/**
 * The retrieval benchmark: every answer of a fact set is published through the request pipeline
 * into a store of its own, the follow-up jobs run as a server runs them, every question is
 * searched, and the figures say where the fact that answers it came back. Nothing here knows the
 * search's insides; it reads results as an agent does.
 */
import type { SearchFactsResult } from "@uketsugi/contracts";
import { createApp, createWorker, scopeOf } from "@uketsugi/core";
import { openLocalPorts } from "@uketsugi/server";
import { FakeClock, FakeIdGen, toolCaller, type ToolCaller } from "@uketsugi/testkit";
import { documentText, type Answer, type FactSet, type Question } from "./team-memory.ts";

/**
 * How an answer becomes a fact. `predecessor` shapes it as the predecessor's search document was:
 * its question as the heavily weighted field, its answer and citation title as the body, which is
 * the text its recorded vector was made from. `fact` is the product's own shape: the answer is the
 * claim, the question it answers rides along, and the citation stays a citation.
 */
export type Mapping = "predecessor" | "fact";

const MAPPINGS: Record<Mapping, (answer: Answer) => Record<string, string>> = {
  predecessor: (answer) => ({
    claim: answer.question,
    detail: `${answer.answer}\n${answer.citation}`,
  }),
  fact: (answer) => ({ claim: answer.answer, question: answer.question }),
};

const PROJECT = "github.com/acme/platform";
const CLIENT = { name: "benchmark", version: null, conversationId: null };
const STARTS_AT = new Date("2026-11-02T09:00:00.000Z");
const ASK_LIMIT = 10;

/**
 * Which vector a published fact carries. `own` is the product's: the one its publish or its embed
 * job made, from the fact's question, claim and citation. `recorded` publishes with no model and
 * then stores the vector the predecessor recorded for the answer's search document, so that the
 * run measures this engine on the predecessor's own input. `none` runs with no model at all, on
 * the lexical passes.
 */
export type Vectors = "own" | "recorded" | "none";

/** One question's outcome: the answers its search returned, best first. */
export interface QuestionResult {
  readonly question: Question;
  readonly returned: readonly string[];
  readonly confidence: SearchFactsResult["confidence"];
}

type Ports = Awaited<ReturnType<typeof openLocalPorts>>["ports"];

/** Runs the follow-up jobs as a server does, and fails if one failed. */
async function runJobs(ports: Ports): Promise<void> {
  const failed: string[] = [];
  const onFailure = (job: { kind: string }, error: unknown) =>
    failed.push(`${job.kind}: ${String(error)}`);
  const worker = createWorker(ports, { onFailure });
  while ((await worker.drain()) > 0);
  if (failed.length > 0) throw new Error(`${failed.length} jobs failed: ${failed[0] ?? ""}`);
}

/**
 * Publishes every answer, runs the jobs, and checks that each fact is still there with the vector
 * the run asks for. Returns each fact's answer by the fact's id.
 */
async function publishAll(
  set: FactSet,
  mapping: Mapping,
  vectors: Vectors,
  ports: Ports,
  call: ToolCaller,
  scope: { orgId: string; audienceIds: readonly string[] },
): Promise<Map<string, Answer>> {
  const answerOf = new Map<string, Answer>();
  for (const answer of set.answers) {
    const args = { ...MAPPINGS[mapping](answer), citations: [answer.citation] };
    const { id, created } = await call("publish_fact", args);
    if (!created) throw new Error(`answer ${answer.id} was merged into fact ${id}`);
    answerOf.set(id, answer);
  }
  await runJobs(ports);
  for (const [id, answer] of answerOf) {
    const fact = await ports.store.facts.get(scope, id);
    if (fact === null || fact.status === "superseded") {
      throw new Error(`answer ${answer.id} was merged away`);
    }
    const recorded = vectors === "recorded" ? set.vectorOf(documentText(answer)) : undefined;
    const stored =
      recorded === undefined
        ? fact.embedded
        : await ports.store.facts.setVector(scope.orgId, id, fact.contentHash, recorded);
    if (!stored && vectors !== "none") {
      throw new Error(`answer ${answer.id} was left without a vector`);
    }
  }
  return answerOf;
}

/** Publishes the set under one mapping and searches every question at a limit of 10. */
export async function runBenchmark(
  set: FactSet,
  mapping: Mapping,
  vectors: Vectors,
): Promise<QuestionResult[]> {
  const local = await openLocalPorts({});
  set.unknown.length = 0;
  try {
    // A fixed clock and counted ids, so that every run breaks ties the same way.
    const base = { ...local.ports, clock: new FakeClock(STARTS_AT), ids: new FakeIdGen() };
    const { owner } = local;
    /** The server as it runs with or without the model: one store behind both. */
    const serverWith = (model: boolean) => {
      const ports = { ...base, embedder: model ? set.embedder : null };
      return { ports, call: toolCaller(createApp(ports), owner, CLIENT, PROJECT) };
    };
    const scope = scopeOf(owner);
    const writer = serverWith(vectors === "own");
    const answerOf = await publishAll(set, mapping, vectors, writer.ports, writer.call, scope);
    const { call } = serverWith(vectors !== "none");

    const results: QuestionResult[] = [];
    for (const question of set.questions) {
      const args = { query: question.text, limit: ASK_LIMIT };
      const found = await call("search_facts", args);
      if (found.degraded.join() !== (vectors === "none" ? "no_model" : "")) {
        throw new Error(`question ${question.id} ran degraded: ${found.degraded.join(", ")}`);
      }
      const returned = found.facts.map((fact) => answerOf.get(fact.id)?.id ?? fact.id);
      results.push({ question, returned, confidence: found.confidence });
    }
    if (set.unknown.length > 0) {
      throw new Error(
        `the product embedded ${set.unknown.length} texts the set holds no vector for, so these would not be its figures; the first: "${set.unknown[0] ?? ""}"`,
      );
    }
    return results;
  } finally {
    await local.close();
  }
}

/** The headline figures over a set of question results. A count is out of `answerable` or `unanswerable`. */
export interface Figures {
  /** Questions the set holds an answer to; the hit figures count these. */
  readonly answerable: number;
  readonly hitAt1: number;
  readonly hitAt5: number;
  readonly hitAt10: number;
  /** Mean of 1 / rank of the first right answer in the top five, 0 for a miss. */
  readonly mrrAt5: number;
  /** Answerable questions whose search showed nothing, and whose confidence was low. */
  readonly answerableEmpty: number;
  readonly answerableLow: number;
  /** Questions the set holds no answer to, and how many showed nothing or said confidence was low. */
  readonly unanswerable: number;
  readonly unanswerableEmpty: number;
  readonly unanswerableLow: number;
}

/** The 1-based place of the first right answer, or null when none was returned. */
export function firstRightRank(result: QuestionResult): number | null {
  const index = result.returned.findIndex((id) => result.question.answers.includes(id));
  return index === -1 ? null : index + 1;
}

export function figuresOf(results: readonly QuestionResult[]): Figures {
  const answerable = results.filter((result) => result.question.answers.length > 0);
  const unanswerable = results.filter((result) => result.question.answers.length === 0);
  const ranks = answerable.map((result) => firstRightRank(result) ?? Infinity);
  const within = (k: number): number => ranks.filter((rank) => rank <= k).length;
  const empty = (set: readonly QuestionResult[]): number =>
    set.filter((result) => result.returned.length === 0).length;
  const low = (set: readonly QuestionResult[]): number =>
    set.filter((result) => result.confidence === "low").length;
  const reciprocal = ranks.reduce((sum, rank) => sum + (rank <= 5 ? 1 / rank : 0), 0);
  return {
    answerable: answerable.length,
    hitAt1: within(1),
    hitAt5: within(5),
    hitAt10: within(10),
    mrrAt5: answerable.length === 0 ? 0 : Math.round((reciprocal / answerable.length) * 1e4) / 1e4,
    answerableEmpty: empty(answerable),
    answerableLow: low(answerable),
    unanswerable: unanswerable.length,
    unanswerableEmpty: empty(unanswerable),
    unanswerableLow: low(unanswerable),
  };
}
