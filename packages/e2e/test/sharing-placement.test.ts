/**
 * Where a record ends up when things happen at once or go wrong: a write in flight while its
 * person changes their mind, a correction that changes who may read a fact, a choice whose move
 * fails, a redaction that races a move, and merges undone or redacted long after their chain has
 * moved. Each case was a way for text its person meant to keep private to end up where everyone
 * reads (REVIEW-P1). On the embedded store and on a PostgreSQL server.
 */
import {
  chooseTreatment,
  createApp,
  createNamedProject,
  createTokenIdentity,
  exportMarkdown,
  factDetail,
  listProjects,
  redactFact,
  revertRuling,
  scopeOf,
  type CorePorts,
  type Embedder,
  type Store,
} from "@uketsugi/core";
import { everyoneOf, FakeEmbedder, toolCaller } from "@uketsugi/testkit";
import { expect, test } from "vitest";
import { CHECKABLE, sharedWorld, TESTIMONY } from "./sharing-world.ts";
import { CLIENT, describeUseCases } from "./use-case-world.ts";

const P = (name: string): string => `github.com/acme/placed-${name}`;

/** A model that waits, inside its first call, until the test lets it go on. */
function heldEmbedder() {
  let entered = (): void => undefined;
  let release = (): void => undefined;
  const embedding = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fake = new FakeEmbedder();
  const embedder: Embedder = {
    model: fake.model,
    dims: fake.dims,
    async embed(texts) {
      entered();
      await gate;
      return fake.embed(texts);
    },
  };
  return { embedder, embedding, release: () => release() };
}

describeUseCases("where a record ends up when things race or fail", (w) => {
  const s = sharedWorld(w);
  const callsOn = (ports: CorePorts, who: typeof s.ann, project: string) =>
    toolCaller(createApp({ ...ports, identity: createTokenIdentity(ports) }), who, CLIENT, project);
  const treatmentOf = async (who: typeof s.ann, project: string) =>
    (await listProjects(s.ports, who)).projects.find((entry) => entry.key === project)?.treatment;

  test("a publish in flight while its person chooses private lands private, says so, and stays theirs to correct", async () => {
    const project = P("in-flight");
    const held = heldEmbedder();
    const ann = callsOn({ ...s.ports, embedder: held.embedder }, s.ann, project);
    await s.choose(s.ann, project, "shared");
    const publishing = ann("publish_fact", {
      claim: "The payroll export key lives at vault path kv/payroll",
      citations: "src/payroll.ts:1",
    });
    await held.embedding;
    await s.choose(s.ann, project, "private");
    held.release();
    const fact = await publishing;
    expect(await treatmentOf(s.ann, project)).toBe("private");
    expect(fact.treatment).toBe("used here, private");
    expect((await s.seenBy(s.ann, fact.id))?.audienceId).toBe(s.ann.privateAudienceId);
    expect(await s.seenBy(s.bob, fact.id)).toBeNull();
    const fixed = await s.calls(s.ann, project)("update_fact", { id: fact.id, detail: "Rotated." });
    expect(fixed.id).toBe(fact.id);
    // The same for a task published while the choice changes.
    const task = await s.calls(s.ann, project)("publish_task", { title: "Rotate the payroll key" });
    expect((await s.ports.store.tasks.get(scopeOf(s.bob), task.task.id)) ?? null).toBeNull();
  });

  test("a correction that takes a shared fact private is one unit, never readable by others, and leaves no hash of it in the shared log", async () => {
    const project = P("corrected");
    await s.choose(s.ann, project, "shared");
    const first = await s.calls(s.ann, project)("publish_fact", {
      claim: "The staging cluster has three nodes",
      citations: CHECKABLE,
    });
    let units = 0;
    const store: Store = {
      ...s.ports.store,
      unit(target, fn) {
        units += 1;
        return s.ports.store.unit(target, fn);
      },
    };
    await callsOn(
      { ...s.ports, store },
      s.ann,
      project,
    )("update_fact", {
      id: first.id,
      claim: "The staging root password is hunter2 (told to me by ops)",
      citations: [TESTIMONY],
    });
    expect(units).toBe(1);
    const now = await s.seenBy(s.ann, first.id);
    expect(now).toMatchObject({ audienceId: s.ann.privateAudienceId });
    expect(await s.seenBy(s.bob, first.id)).toBeNull();
    const sharedLog = await s.logged(everyoneOf(s.ann) ?? "", first.id);
    expect(sharedLog.map((event) => event.kind)).toEqual(["FactPublished", "FactWithdrawn"]);
    expect(JSON.stringify(sharedLog)).not.toContain(now?.contentHash);
    // The other way: a private fact that gains a source others can open is corrected, then shared,
    // and the log others read holds no hash of the text it had.
    const word = await s.calls(s.ann, project)("publish_fact", {
      claim: "Staging is rebuilt on Sundays",
      citations: [TESTIMONY],
    });
    const before = await s.seenBy(s.ann, word.id);
    await s.calls(s.ann, project)("update_fact", { id: word.id, citations: [CHECKABLE] });
    expect((await s.seenBy(s.bob, word.id))?.audienceId).toBe(everyoneOf(s.ann));
    const arrived = await s.logged(everyoneOf(s.ann) ?? "", word.id);
    expect(arrived.map((event) => event.kind)).toEqual(["FactShared"]);
    expect(JSON.stringify(arrived)).not.toContain(before?.contentHash);
  });

  test("when the unit of such a correction fails, nothing of it is written anywhere", async () => {
    const project = P("failed-correction");
    await s.choose(s.ann, project, "shared");
    const first = await s.calls(s.ann, project)("publish_fact", {
      claim: "The canary cluster has two nodes",
      citations: CHECKABLE,
    });
    const store: Store = {
      ...s.ports.store,
      unit: () => Promise.reject(new Error("the connection dropped")),
    };
    const failed = callsOn(
      { ...s.ports, store },
      s.ann,
      project,
    )("update_fact", {
      id: first.id,
      claim: "The canary root password is swordfish (told to me by ops)",
      citations: [TESTIMONY],
    });
    await expect(failed).rejects.toThrow(/failed while handling the call/);
    expect((await s.seenBy(s.bob, first.id))?.claim).toBe("The canary cluster has two nodes");
  });

  test("a choice whose move fails is not recorded: the project never reads private while its facts stay shared", async () => {
    const project = P("failed-choice");
    await s.choose(s.ann, project, "shared");
    const fact = await s.calls(s.ann, project)("publish_fact", {
      claim: "Invoices are archived after ninety days",
      citations: CHECKABLE,
    });
    const store: Store = {
      ...s.ports.store,
      unit: () => Promise.reject(new Error("deadlock detected")),
    };
    const choice = { project, treatment: "private" as const };
    await expect(chooseTreatment({ ...s.ports, store }, s.ann, choice)).rejects.toThrow(
      "deadlock detected",
    );
    expect(await treatmentOf(s.ann, project)).toBe("shared");
    expect((await s.seenBy(s.bob, fact.id))?.claim).toBe("Invoices are archived after ninety days");
    expect((await s.choose(s.ann, project, "private")).moved.facts).toBe(1);
    expect(await s.seenBy(s.bob, fact.id)).toBeNull();
  });

  test("a redaction that races a move redacts the fact where it is by then", async () => {
    const project = P("redacted-in-flight");
    const fact = await s.calls(s.ann, project)("publish_fact", {
      claim: "The signing key is rotated by hand each quarter",
      citations: CHECKABLE,
    });
    let moved = false;
    const inner = s.ports.store.facts;
    const facts = new Proxy(inner, {
      get(target, key, receiver) {
        if (key !== "get") return Reflect.get(target, key, receiver) as unknown;
        return async (...args: Parameters<typeof inner.get>) => {
          const read = await inner.get(...args);
          if (!moved && args[1] === fact.id) {
            moved = true;
            await s.choose(s.ann, project, "shared");
          }
          return read;
        };
      },
    });
    const ports = { ...s.ports, store: { ...s.ports.store, facts } };
    expect(await redactFact(ports, s.ann, { id: fact.id })).toEqual({
      id: fact.id,
      redacted: true,
    });
    expect(moved).toBe(true);
    expect(await s.seenBy(s.bob, fact.id)).toMatchObject({
      claim: null,
      audienceId: everyoneOf(s.ann),
    });
  });

  /** Two wordings of one claim, merged: the first is superseded by the second, which takes its citation. */
  async function merged(project: string, firstCitation: unknown) {
    const ann = s.calls(s.ann, project);
    const first = await ann("publish_fact", {
      claim: "Billing moves to Stripe in March",
      citations: [firstCitation],
    });
    w.clock.advance(1_000);
    const second = await ann("publish_fact", {
      claim: "billing moves to stripe in march.",
      citations: "docs/billing.md:3",
    });
    await w.runJobs(s.ports);
    expect((await s.seenBy(s.ann, first.id))?.supersededBy).toBe(second.id);
    return { ann, first, second };
  }

  /** The person changes their mind `times` times, ending on shared when `times` is odd. */
  async function changeMind(project: string, times: number): Promise<void> {
    for (let move = 0; move < times; move += 1) {
      w.clock.advance(60_000);
      await s.choose(s.ann, project, move % 2 === 0 ? "shared" : "private");
    }
  }

  const kindsOf = async (id: string) =>
    (await s.seenBy(s.ann, id))?.citations.map(({ citation }) => citation.kind);
  const QUOTED = { kind: "web", url: "https://wiki.acme.example/billing", quote: "REDACT-ME" };

  test.each([1, 11, 61])(
    "after its chain has moved %i times, redacting a merged-away fact still takes its citation out of the survivor",
    async (moves) => {
      const project = P(`moved-${moves}`);
      const { first, second } = await merged(project, QUOTED);
      expect(await kindsOf(second.id)).toEqual(["file", "web"]);
      await changeMind(project, moves);
      // Every move is written in both logs for each fact of the chain: the merge is far behind.
      const entries = await s.ports.store.review.history(scopeOf(s.ann), first.id, 1000);
      expect(entries.length).toBeGreaterThanOrEqual(2 * moves);
      expect((await s.seenBy(s.bob, second.id))?.audienceId).toBe(everyoneOf(s.ann));
      await redactFact(s.ports, s.ann, { id: first.id });
      expect(await kindsOf(second.id)).toEqual(["file"]);
      const exported = await exportMarkdown(s.ports, s.bob, project);
      expect(JSON.stringify(exported)).toContain("billing moves to stripe");
      expect(JSON.stringify(exported)).not.toContain("REDACT-ME");
    },
  );

  test("after its chain has moved 61 times, a merge is still undone, and each fact has its own citation again", async () => {
    const project = P("unmerged-late");
    const { first, second } = await merged(project, QUOTED);
    await changeMind(project, 61);
    const [ruling] = await s.ports.store.review.rulingsOf(scopeOf(s.ann), [first.id]);
    expect(await revertRuling(s.ports, s.ann, ruling?.id ?? "")).toEqual({
      id: ruling?.id,
      reverted: true,
    });
    expect(await kindsOf(first.id)).toEqual(["web"]);
    expect(await kindsOf(second.id)).toEqual(["file"]);
    expect((await s.seenBy(s.bob, first.id))?.status).toBe("unconfirmed");
  });

  test("a chain that holds somebody's word alone is never shown to others, however its head is corrected; without the word it is", async () => {
    const project = P("held-back");
    const word = { kind: "person", who: "REDACT-ME the CFO, in confidence" };
    const { ann, first, second } = await merged(project, word);
    for (let round = 0; round < 3; round += 1) {
      await changeMind(project, 1);
      expect(await s.seenBy(s.bob, second.id)).toBeNull();
      await ann("update_fact", { id: second.id, detail: `Checked again, round ${round}.` });
      expect(await s.seenBy(s.bob, second.id)).toBeNull();
      await ann("update_fact", { id: second.id, citations: ["docs/billing.md:3", CHECKABLE] });
      expect(await s.seenBy(s.bob, second.id)).toBeNull();
    }
    await redactFact(s.ports, s.ann, { id: first.id });
    // The word is gone, so nothing in the chain is unshareable any more: it is where the choice says.
    const theirs = await s.seenBy(s.bob, second.id);
    expect(theirs?.audienceId).toBe(everyoneOf(s.ann));
    expect(JSON.stringify(theirs)).not.toContain("REDACT-ME");
  });

  test("undoing a merge leaves no fact others cannot check where they read", async () => {
    const project = P("unmerged");
    const ann = s.calls(s.ann, project);
    const word = await ann("publish_fact", {
      claim: "Deploys freeze on Fridays",
      detail: "Heard in the Tuesday sync; not announced yet.",
      citations: [TESTIMONY],
    });
    w.clock.advance(1_000);
    const cited = await ann("publish_fact", {
      claim: "deploys freeze on fridays.",
      citations: "docs/release.md:3",
    });
    await w.runJobs(s.ports);
    expect((await s.seenBy(s.ann, word.id))?.supersededBy).toBe(cited.id);
    w.clock.advance(60_000);
    expect((await s.choose(s.ann, project, "shared")).moved.facts).toBe(0);
    expect(await s.seenBy(s.bob, cited.id)).toBeNull();
    const [ruling] = await s.ports.store.review.rulingsOf(scopeOf(s.ann), [word.id]);
    expect(await revertRuling(s.ports, s.ann, ruling?.id ?? "")).toMatchObject({ reverted: true });
    // The fact with a source is shared now; the person's word is live again, and theirs alone.
    expect(await s.seenBy(s.ann, word.id)).toMatchObject({
      status: "unconfirmed",
      audienceId: s.ann.privateAudienceId,
    });
    expect(await s.seenBy(s.bob, word.id)).toBeNull();
    const shared = await s.seenBy(s.bob, cited.id);
    expect(shared?.citations.map(({ citation }) => citation.kind)).toEqual(["file"]);
    const found = await s.calls(s.bob, project)("search_facts", {
      query: "deploys freeze Fridays",
    });
    expect(found.facts.map((fact) => [fact.id, fact.detail])).toEqual([[cited.id, undefined]]);
    const exported = JSON.stringify(await exportMarkdown(s.ports, s.bob, project));
    expect(exported).not.toContain("Tuesday sync");
  });

  test("a named project is its maker's own: another person's reads as unknown, like one nobody made", async () => {
    await createNamedProject(s.ports, s.ann, { slug: "acme-acquisition", name: "Acquisition" });
    const asked = (project: string) =>
      s
        .calls(s.bob, project)("search_facts", { query: "x" })
        .then(
          () => "accepted",
          (error: unknown) => String(error),
        );
    const [unknown, hers] = [await asked("me/never-made"), await asked("me/acme-acquisition")];
    expect(unknown).toContain("project is required");
    expect(hers).toBe(unknown);
    expect((await listProjects(s.ports, s.bob)).projects.map((entry) => entry.key)).not.toContain(
      "me/acme-acquisition",
    );
    expect(await asked("me/acme-acquisition")).toBe(unknown);
    const mine = await s.calls(s.ann, "me/acme-acquisition")("search_facts", { query: "x" });
    expect(mine.project).toBe("me/acme-acquisition");
    // He may make one of the same name: it is his, with his own name for it, and hers is not told.
    const his = await createNamedProject(s.ports, s.bob, {
      slug: "acme-acquisition",
      name: "Mine",
    });
    expect(his).toMatchObject({ key: "me/acme-acquisition", name: "Mine" });
  });

  test("what a person wrote on others' shared records stays with those records when they go private", async () => {
    const project = P("left-behind");
    await s.choose(s.ann, project, "shared");
    await s.choose(s.bob, project, "shared");
    const [ann, bob] = [s.calls(s.ann, project), s.calls(s.bob, project)];
    const fact = await ann("publish_fact", { claim: "Caches warm at boot", citations: CHECKABLE });
    const task = await ann("publish_task", { title: "Profile the warm-up" });
    await bob("update_fact", { id: fact.id, confirm: { checked: "read warm.ts" } });
    // Her own check of her own fact is told apart from his: it refreshes, and confirms nothing.
    await ann("update_fact", { id: fact.id, confirm: { checked: "ran it again" } });
    const { lease } = await bob("claim_task", { id: task.task.id });
    await bob("update_task", { id: task.task.id, lease, note: "Half profiled." });
    await s.choose(s.bob, project, "private");
    const detail = await factDetail(s.ports, s.ann, fact.id);
    const checks = detail.confirmations.map((entry) => [
      entry.person,
      entry.checked,
      entry.by_author,
    ]);
    expect(checks).toHaveLength(2);
    expect(checks).toContainEqual(["bob", "read warm.ts", false]);
    expect(checks).toContainEqual(["you", "ran it again", true]);
    expect((await ann("search_tasks", { id: task.task.id })).notes).toMatchObject([
      { author: "bob", text: "Half profiled." },
    ]);
    // From then on his agent writes nothing more there.
    await expect(bob("update_task", { id: task.task.id, lease, note: "More." })).rejects.toThrow(
      /this project is private for your person/,
    );
  });
});
