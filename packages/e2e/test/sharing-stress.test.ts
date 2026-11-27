/**
 * Two people, their agents, their own hands on the dashboard (the choice, a redaction, undoing a
 * merge) and the worker, all at once on one project, with claims that repeat so that merges keep
 * happening. It looks for a call that fails for no reason its caller could act on (a deadlock, a
 * broken key), and at rest for three things: a record that is not where its person's choice and
 * the rule say, a citation of a redacted fact left on any other fact, and a choice made again
 * that still finds something to move. Meaningful on PostgreSQL, where units really run side by
 * side; the embedded engine has one connection. `UKT_STRESS_ROUNDS` makes it longer,
 * `UKT_STRESS_SEED` makes it another run, and `UKT_STRESS_OUT` names a file that gets one line
 * per run. It grew from the second review's
 * stress, which found a redaction that missed a merge five times in 1,679.
 */
import { appendFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  createApp,
  createTokenIdentity,
  createWorker,
  listProjects,
  listRulings,
  redactFact,
  revertRuling,
  type Caller,
  type CorePorts,
  type Fact,
} from "@uketsugi/core";
import { everyoneOf, toolCaller, type ToolCaller } from "@uketsugi/testkit";
import { expect, test } from "vitest";
import { sharedWorld, type Shared } from "./sharing-world.ts";
import { CLIENT, describeUseCases, type World } from "./use-case-world.ts";

const PROJECT = "github.com/acme/stressed";
const ROUNDS = Number(process.env.UKT_STRESS_ROUNDS ?? 12);
/** Added to every actor's seed: another value gives another run. */
const SEED = Number(process.env.UKT_STRESS_SEED ?? 0);

function prng(seed: number): () => number {
  let state = (seed + SEED * 7919) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** A fault in one line: what it said, its database code if it had one, and where in the product it rose. */
function where(cause: unknown): string {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const at = (error.stack ?? "")
    .split("\n")
    .filter((line) => /usecases|jobs\/|facts\/|sharing/.test(line))
    .map((line) => line.trim().replace(/\(.*packages\//, "("))
    .slice(0, 4)
    .join(" < ");
  const code = "code" in error ? ` [${String(error.code)}]` : "";
  return `${error.message.split("\n")[0]}${code} @ ${at}`;
}

interface Person {
  readonly who: Caller;
  readonly name: string;
  readonly call: ToolCaller;
  readonly facts: string[];
  readonly tasks: string[];
}

/** What a run keeps count of while it runs. */
interface Run {
  readonly ports: CorePorts;
  readonly people: readonly Person[];
  readonly allFacts: string[];
  /** The marks a fact's own citations ever held, and the facts whose redaction succeeded. */
  readonly marks: Map<string, string[]>;
  readonly redacted: Set<string>;
  readonly faults: string[];
  readonly handFaults: string[];
  readonly refusals: Map<string, number>;
  readonly counts: { redactions: number; reverts: number; choices: number; calls: number };
  calls: number;
}

/** A refused call counts by its kind and gives null; a call the server failed on is a fault of its own. */
async function quiet<T>(run: Run, work: Promise<T>): Promise<T | null> {
  return work.catch((error: unknown) => {
    const text = String(error);
    const kind = /failed while handling/.test(text)
      ? "INTERNAL"
      : (/refused: (.{0,60})/.exec(text)?.[1] ?? text.slice(0, 60)).replace(/[0-9a-f-]{36}/g, "…");
    run.refusals.set(kind, (run.refusals.get(kind) ?? 0) + 1);
    return null;
  });
}

const claimOf = (key: number, variant: number): string =>
  variant % 2 === 0 ? `Module ${key} retries three times` : `module ${key} retries three times.`;

/** A fact's citations: always somebody's marked word, often a file, sometimes another fact. */
function citationsOf(run: Run, rand: () => number, id: number): { sent: unknown[]; mark: string } {
  const mark = `MARK-${id}-X`;
  const word = { kind: "person", who: `${mark} said so` };
  const roll = rand();
  if (roll < 0.45) return { sent: [`src/m${id}.ts:1`, word], mark };
  if (roll < 0.7) return { sent: [word], mark };
  const cited = run.allFacts[Math.floor(rand() * run.allFacts.length)];
  const fact = cited === undefined ? [] : [{ kind: "fact", fact: cited }];
  return { sent: [`src/m${id}.ts:1`, word, ...fact], mark };
}

const remember = (run: Run, id: string, mark: string): void =>
  void run.marks.set(id, [...(run.marks.get(id) ?? []), mark]);

async function writeFact(run: Run, me: Person, rand: () => number, mine: number): Promise<void> {
  const pick = <T>(list: readonly T[]): T | undefined => list[Math.floor(rand() * list.length)];
  const id = rand() < 0.73 ? undefined : pick(me.facts);
  const { sent, mark } = citationsOf(run, rand, mine);
  const claim = claimOf(Math.floor(rand() * 6), mine);
  if (id === undefined) {
    const made = await quiet(run, me.call("publish_fact", { claim, citations: sent }));
    if (made === null || !made.created) return;
    me.facts.push(made.id);
    run.allFacts.push(made.id);
    remember(run, made.id, mark);
    return;
  }
  const changes = { id, ...(rand() < 0.5 ? { claim } : {}), citations: sent };
  // The mark counts whether or not the correction was accepted: the check errs on the strict side.
  remember(run, id, mark);
  await quiet(run, me.call("update_fact", changes));
}

async function workOnTasks(run: Run, me: Person, rand: () => number, mine: number): Promise<void> {
  if (rand() < 0.5) {
    const sent = {
      title: `Task ${mine} of ${me.name}`,
      tracked: rand() < 0.3,
      claim: rand() < 0.3,
    };
    const made = await quiet(run, me.call("publish_task", sent));
    if (made !== null) me.tasks.push(made.task.id);
    return;
  }
  const all = run.people.flatMap((each) => each.tasks);
  const id = all[Math.floor(rand() * all.length)];
  if (id === undefined) return;
  const claimed = await quiet(run, me.call("claim_task", { id, take_over: true }));
  if (claimed === null) return;
  await quiet(run, me.call("update_task", { id, lease: claimed.lease, note: `note ${mine}` }));
}

/** One agent of a person: publishes, corrects, confirms, works on tasks and searches. */
async function agent(w: World, run: Run, me: Person, seed: number): Promise<void> {
  const rand = prng(seed);
  for (let round = 0; round < ROUNDS; round += 1) {
    const roll = rand();
    run.calls += 1;
    const mine = run.calls;
    w.clock.advance(10);
    if (roll < 0.55) await writeFact(run, me, rand, mine);
    else if (roll < 0.65) {
      const id = run.allFacts[Math.floor(rand() * run.allFacts.length)];
      if (id !== undefined) {
        await quiet(run, me.call("update_fact", { id, confirm: { checked: `seen ${mine}` } }));
      }
    } else if (roll < 0.85) await workOnTasks(run, me, rand, mine);
    else await quiet(run, me.call("search_facts", { query: "module retries three times" }));
  }
}

/** What a person can act on is a refusal with words; anything else from their own hands is a fault. */
async function byHand(run: Run, what: string, work: Promise<unknown>): Promise<boolean> {
  return work.then(
    () => true,
    (error: unknown) => {
      const told = /changed|redacted since|is another person's|No listed|nothing to restore/i;
      if (!told.test(String(error))) run.handFaults.push(`${what}: ${where(error)}`);
      return false;
    },
  );
}

/** A person at the dashboard: changes their mind, redacts a fact of theirs, undoes a merge. */
async function hands(w: World, s: Shared, run: Run, me: Person, seed: number): Promise<void> {
  const rand = prng(seed);
  for (let round = 0; round < ROUNDS; round += 1) {
    const roll = rand();
    w.clock.advance(10);
    if (roll < 0.35) {
      run.counts.choices += 1;
      const treatment = rand() < 0.5 ? "shared" : "private";
      await byHand(run, `choose ${treatment}`, s.choose(me.who, PROJECT, treatment));
    } else if (roll < 0.75) {
      const id = me.facts[Math.floor(rand() * me.facts.length)];
      if (id === undefined) continue;
      run.counts.redactions += 1;
      if (await byHand(run, "redact", redactFact(run.ports, me.who, { id }))) run.redacted.add(id);
    } else {
      const listed = await listRulings(run.ports, me.who).catch(() => ({ rulings: [] }));
      const ruling = listed.rulings.find((entry) => entry.revertible);
      if (ruling === undefined) continue;
      run.counts.reverts += 1;
      await byHand(run, "revert", revertRuling(run.ports, me.who, ruling.id));
    }
    await nextTurn();
  }
}

/** The worker beside every request, and then until nothing is due however far the clock moves. */
async function jobs(w: World, run: Run, done: () => boolean): Promise<void> {
  const worker = createWorker(run.ports, {
    onFailure: (job, error, dead) => {
      if (dead) run.faults.push(`dead job ${job.kind}: ${String(error).split("\n")[0]}`);
    },
  });
  while (!done()) {
    await worker.drain();
    await nextTurn();
  }
  for (let pass = 0; pass < 40; pass += 1) {
    w.clock.advance(3_600_000);
    if ((await worker.drain()) === 0 && pass > 2) break;
  }
}

const hasSource = (fact: Fact): boolean =>
  fact.citations.some((entry) => entry.class === "checkable");
const citedOf = (fact: Fact): string[] =>
  fact.citations.flatMap(({ citation }) => (citation.kind === "fact" ? [citation.fact] : []));

/** Every fact of the project, in whichever of the three audiences it is. */
async function everyFact(run: Run, audienceIds: string[]): Promise<Fact[]> {
  const scope = { orgId: run.people[0]?.who.orgId ?? "", audienceIds };
  const every: Fact[] = [];
  for (;;) {
    const last = every.at(-1);
    const before = last === undefined ? undefined : { updatedAt: last.updatedAt, id: last.id };
    const page = await run.ports.store.facts.list(scope, { project: PROJECT, before, limit: 500 });
    every.push(...page);
    if (page.length < 500) return every;
  }
}

/**
 * One person's chains against the rule, written out here and not taken from the product: in a
 * project they share, a chain is shared exactly when its head is live and has a source, every
 * duplicate behind it that has its text has one, and the head cites no fact of theirs that is
 * theirs alone. A chain that is redacted at its head is left where it was.
 */
function misplaced(me: Person, treatment: string | undefined, every: readonly Fact[]): string[] {
  const found: string[] = [];
  const sharedId = everyoneOf(me.who) ?? "";
  const byId = new Map(every.map((fact) => [fact.id, fact]));
  const headOf = (fact: Fact): Fact => {
    let at = fact;
    for (let step = 0; step < 200 && at.supersededBy !== null; step += 1) {
      const next = byId.get(at.supersededBy);
      if (next === undefined) break;
      at = next;
    }
    return at;
  };
  const own = every.filter((fact) => fact.author === me.who.principalId);
  const alone = new Set(
    every.filter((fact) => fact.audienceId === me.who.privateAudienceId).map((fact) => fact.id),
  );
  for (const [head, members] of Map.groupBy(own, headOf)) {
    const inShared = head.audienceId === sharedId;
    const within = new Set(members.map((fact) => fact.id));
    const texts = members.filter((fact) => fact.claim !== null);
    const citesOwn = citedOf(head).some((id) => !within.has(id) && alone.has(id));
    const belongs = treatment === "shared" && texts.every(hasSource) && !citesOwn;
    if (new Set(members.map((fact) => fact.audienceId)).size > 1)
      found.push(`${me.name}: chain ${head.id} is split over audiences`);
    if (inShared && treatment !== "shared")
      found.push(`${me.name} chose private, yet chain ${head.id} is shared`);
    if (head.claim === null || head.status === "superseded") continue;
    if (inShared && !belongs)
      found.push(`${me.name}: shared chain ${head.id} is one others may not be shown`);
    if (!inShared && belongs)
      found.push(`${me.name}: chain ${head.id} is private though nothing holds it back`);
  }
  return found;
}

async function misplacedTasks(run: Run, me: Person, treatment: string | undefined) {
  const sharedId = everyoneOf(me.who) ?? "";
  const scope = { orgId: me.who.orgId, audienceIds: [me.who.privateAudienceId, sharedId] };
  const query = { project: PROJECT, person: me.who.principalId, limit: 2000 };
  const tasks = await run.ports.store.tasks.list(scope, query);
  return tasks
    .filter((task) => task.publisher === me.who.principalId)
    .filter((task) => {
      const belongs = treatment === "shared" && !task.tracked;
      return (task.audienceId === sharedId) !== belongs;
    })
    .map((task) => `${me.name}: task ${task.id} is misplaced (tracked ${task.tracked})`);
}

/** The marks of redacted facts that some fact still holds, and redacted facts that kept their text. */
function missed(run: Run, every: readonly Fact[], sharedId: string): string[] {
  const found: string[] = [];
  const byId = new Map(every.map((fact) => [fact.id, fact]));
  for (const id of run.redacted) {
    if ((byId.get(id)?.claim ?? null) !== null) found.push(`${id} was redacted and has text`);
    for (const mark of run.marks.get(id) ?? []) {
      for (const holder of every.filter((fact) => JSON.stringify(fact.citations).includes(mark))) {
        const seen = holder.audienceId === sharedId ? "shared" : "private";
        found.push(`${mark} of redacted ${id} is on ${holder.id} (${seen})`);
      }
    }
  }
  return found;
}

describeUseCases("two people, their agents, their own hands and the worker at once", (w) => {
  const s = sharedWorld(w);

  test("no call fails for a reason its caller cannot act on, every record ends where it belongs, and nothing of a redacted fact is left anywhere", async () => {
    const faults: string[] = [];
    const ports = s.ports;
    const app = createApp(
      { ...ports, identity: createTokenIdentity(ports) },
      { onError: (error) => faults.push(where(error)) },
    );
    const person = (who: Caller, name: string): Person => ({
      who,
      name,
      call: toolCaller(app, who, CLIENT, PROJECT),
      facts: [],
      tasks: [],
    });
    const [ann, bob] = [person(s.ann, "ann"), person(s.bob, "bob")];
    const run: Run = {
      ports,
      people: [ann, bob],
      allFacts: [],
      marks: new Map(),
      redacted: new Set(),
      faults,
      handFaults: [],
      refusals: new Map(),
      counts: { redactions: 0, reverts: 0, choices: 0, calls: 0 },
      calls: 0,
    };
    await s.choose(s.ann, PROJECT, "shared");
    await s.choose(s.bob, PROJECT, "shared");
    let done = false;
    const working = Promise.all([
      agent(w, run, ann, 11),
      agent(w, run, ann, 12),
      agent(w, run, bob, 21),
      agent(w, run, bob, 22),
      hands(w, s, run, ann, 31),
      hands(w, s, run, bob, 41),
    ]).then(() => (done = true));
    await Promise.all([working, jobs(w, run, () => done)]);

    // At rest.
    const sharedId = everyoneOf(s.ann) ?? "";
    const every = await everyFact(run, [
      s.ann.privateAudienceId,
      s.bob.privateAudienceId,
      sharedId,
    ]);
    const astray: string[] = [];
    const again: string[] = [];
    for (const me of run.people) {
      const listed = await listProjects(ports, me.who);
      const treatment = listed.projects.find((project) => project.key === PROJECT)?.treatment;
      astray.push(
        ...misplaced(me, treatment, every),
        ...(await misplacedTasks(run, me, treatment)),
      );
      // The person makes the choice they have made once more: there is nothing left for it to move.
      const { moved } = await s.choose(me.who, PROJECT, treatment ?? "private");
      if (moved.facts + moved.tasks > 0)
        again.push(`${me.name}: choosing again moved ${moved.facts} facts, ${moved.tasks} tasks`);
    }
    const left = missed(run, every, sharedId);
    const summary = {
      engine: expect.getState().currentTestName?.includes("PostgreSQL") ? "postgres" : "embedded",
      rounds: ROUNDS,
      counts: { ...run.counts, calls: run.calls },
      facts: every.length,
      redacted: run.redacted.size,
      refusals: Object.fromEntries(run.refusals),
      faults: [...new Set(faults)].slice(0, 12),
      faultCount: faults.length,
      handFaults: [...new Set(run.handFaults)].slice(0, 12),
      handFaultCount: run.handFaults.length,
      astray: astray.slice(0, 12),
      astrayCount: astray.length,
      again,
      missed: left.slice(0, 12),
      missedCount: left.length,
    };
    if (process.env.UKT_STRESS_OUT !== undefined)
      appendFileSync(process.env.UKT_STRESS_OUT, `${JSON.stringify(summary)}\n`);
    expect({ faults, handFaults: run.handFaults, astray, again, missed: left }).toEqual({
      faults: [],
      handFaults: [],
      astray: [],
      again: [],
      missed: [],
    });
  }, 580_000);
});
