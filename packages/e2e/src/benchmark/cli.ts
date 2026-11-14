/**
 * `pnpm --filter @uketsugi/e2e benchmark`: runs the retrieval benchmark on the team fact set, prints
 * the figures, and fails when retrieval parity is lost. It needs no model and is not part of
 * `pnpm test`.
 */
import { figuresOf, firstRightRank, runBenchmark, type QuestionResult } from "./run.ts";
import { loadTeamMemory } from "./team-memory.ts";

/** Retrieval parity: the predecessor's recorded hit@5 on the held-out half, on this same engine. */
const PARITY_HIT_AT_5 = 67;

const RUNS = [
  {
    title: "engine parity: each answer as the predecessor's search document, with its vector",
    mapping: "predecessor",
    vectors: "recorded",
  },
  {
    title:
      "fact path: the answer as the claim, its question as the fact's question, embedded as the product embeds a fact",
    mapping: "fact",
    vectors: "own",
  },
  { title: "fact path with no model: the lexical passes alone", mapping: "fact", vectors: "none" },
] as const;

function line(label: string, results: readonly QuestionResult[]): string {
  const f = figuresOf(results);
  return [
    label.padEnd(22),
    `hit@1 ${f.hitAt1}/${f.answerable}`,
    `hit@5 ${f.hitAt5}/${f.answerable}`,
    `hit@10 ${f.hitAt10}/${f.answerable}`,
    `MRR@5 ${f.mrrAt5.toFixed(4)}`,
    `answerable: ${f.answerableEmpty} empty, ${f.answerableLow} low`,
    `unanswerable: ${f.unanswerableEmpty}/${f.unanswerable} empty, ${f.unanswerableLow}/${f.unanswerable} low`,
  ].join(" · ");
}

function report(title: string, results: readonly QuestionResult[]): string {
  const of = (split: string) => results.filter((result) => result.question.split === split);
  const heldout = of("heldout");
  const answerable = heldout.filter((result) => result.question.answers.length > 0);
  const kinds = [...new Set(answerable.map((result) => result.question.kind))].sort();
  const misses = answerable
    .filter((result) => (firstRightRank(result) ?? 6) > 5)
    .map((result) => `${result.question.id} (${firstRightRank(result) ?? "not returned"})`);
  return [
    `\n${title}`,
    line("heldout", heldout),
    line("dev", of("dev")),
    ...kinds.map((kind) =>
      line(
        `heldout ${kind}`,
        answerable.filter((result) => result.question.kind === kind),
      ),
    ),
    `heldout misses at 5: ${misses.length === 0 ? "none" : misses.join(", ")}`,
  ].join("\n");
}

const set = loadTeamMemory();
console.log(
  `retrieval benchmark · team fact set · ${set.answers.length} facts, ${set.questions.length} questions · recorded vectors of ${set.embedder.model}`,
);
let parity = 0;
for (const run of RUNS) {
  const results = await runBenchmark(set, run.mapping, run.vectors);
  console.log(report(run.title, results));
  if (run === RUNS[0]) {
    parity = figuresOf(results.filter((result) => result.question.split === "heldout")).hitAt5;
  }
}
const passed = parity >= PARITY_HIT_AT_5;
console.log(
  `\nretrieval parity (held-out hit@5 of at least ${PARITY_HIT_AT_5}, the recorded figure): ${parity} · ${passed ? "pass" : "FAIL"}`,
);
process.exitCode = passed ? 0 : 1;
