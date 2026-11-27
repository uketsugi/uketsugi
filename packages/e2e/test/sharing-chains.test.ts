/**
 * Where a chain of facts is, and what a redaction or an undone merge leaves behind, when a merge
 * lands at the worst moment. The races are made, not hoped for: the worker's merge is run between
 * a call's read and its unit, where a real worker can always run. Each case states what a sound
 * build does; the cases that came from the second review are marked with its probe's name.
 */
import {
  chooseTreatment,
  exportMarkdown,
  factDetail,
  listProjects,
  redactFact,
  revertRuling,
  scopeOf,
  type Caller,
  type CorePorts,
  type Store,
  type Unit,
} from "@uketsugi/core";
import { everyoneOf } from "@uketsugi/testkit";
import { expect, test } from "vitest";
import { CHECKABLE, sharedWorld } from "./sharing-world.ts";
import { describeUseCases } from "./use-case-world.ts";
import { waitingOnHeldUnit } from "./held-unit.ts";

const P = (name: string): string => `github.com/acme/chains-${name}`;
const SECRET = "REDACT-ME";
const WORD = { kind: "person", who: `${SECRET} the CFO, in confidence` };

describeUseCases("chains of facts between a person and everyone", (w) => {
  const s = sharedWorld(w);

  /** The ports with the worker's due jobs run once, just before the next unit opens. */
  const withMergeBeforeUnit = (): CorePorts => {
    let ran = false;
    const inner = s.ports.store;
    const store: Store = {
      ...inner,
      async unit(target, fn) {
        if (!ran) {
          ran = true;
          await w.runJobs(s.ports);
        }
        return inner.unit(target, fn);
      },
    };
    return { ...s.ports, store };
  };
  /** The ports with the next unit that writes a fact's citations back held just after it has. */
  const heldAfterRecite = () => {
    let recited = (): void => undefined;
    let release = (): void => undefined;
    const atRecite = new Promise<void>((resolve) => (recited = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inner = s.ports.store;
    const store: Store = {
      ...inner,
      unit: (target, fn) =>
        inner.unit(target, (unit) => {
          const facts = Object.create(unit.facts) as Unit["facts"];
          facts.setCitations = async (...args) => {
            await unit.facts.setCitations(...args);
            recited();
            await gate;
          };
          return fn({ ...unit, facts });
        }),
    };
    return { ports: { ...s.ports, store }, atRecite, release: () => release() };
  };
  const watched = () => {
    const watching = waitingOnHeldUnit(s.ports.store, w.database);
    return { ports: { ...s.ports, store: watching.store }, waiting: watching.waiting };
  };
  const settled = (work: Promise<unknown>): Promise<string> =>
    work.then(
      () => "ok",
      (error: unknown) => String(error).split("\n")[0] ?? "",
    );
  const audienceOf = async (who: Caller, id: string): Promise<string> => {
    const fact = await s.seenBy(who, id);
    if (fact === null) return "unseen";
    return fact.audienceId === everyoneOf(who) ? "shared" : "private";
  };
  const exportedTo = async (who: Caller, project: string): Promise<string> =>
    JSON.stringify(await exportMarkdown(s.ports, who, project));
  const rulingOn = async (who: Caller, id: string): Promise<string> => {
    const [ruling] = await s.ports.store.review.rulingsOf(scopeOf(who), [id]);
    return ruling?.id ?? "";
  };
  const because = async (who: Caller, id: string) =>
    (await factDetail(s.ports, who, id)).private_because;

  test("R1: a redaction whose fact is merged between its read and its unit still takes its citation out of the survivor", async () => {
    const project = P("r1");
    await s.choose(s.ann, project, "shared");
    const ann = s.calls(s.ann, project);
    const first = await ann("publish_fact", {
      claim: "Billing moves to Stripe in March",
      citations: ["docs/plan.md:9", WORD],
    });
    await w.runJobs(s.ports);
    w.clock.advance(1_000);
    const second = await ann("publish_fact", {
      claim: "billing moves to stripe in march.",
      citations: "docs/billing.md:3",
    });

    const done = await redactFact(withMergeBeforeUnit(), s.ann, { id: first.id });

    expect(done).toEqual({ id: first.id, redacted: true });
    expect(await s.seenBy(s.ann, first.id)).toMatchObject({ claim: null, supersededBy: second.id });
    expect(JSON.stringify((await s.seenBy(s.bob, second.id))?.citations)).not.toContain(SECRET);
    expect(await exportedTo(s.bob, project)).not.toContain(SECRET);
    expect(await exportedTo(s.ann, project)).not.toContain(SECRET);
  });

  test("R1c: undoing a merge while its survivor is merged onward leaves nothing of the restored fact ahead, so its later redaction is whole", async () => {
    const project = P("r1c");
    await s.choose(s.ann, project, "shared");
    const ann = s.calls(s.ann, project);
    const first = await ann("publish_fact", {
      claim: "Payroll runs on the 25th",
      citations: ["docs/payroll.md:9", WORD],
    });
    w.clock.advance(1_000);
    const second = await ann("publish_fact", {
      claim: "payroll runs on the 25th.",
      citations: "docs/payroll.md:3",
    });
    await w.runJobs(s.ports);
    expect((await s.seenBy(s.ann, first.id))?.supersededBy).toBe(second.id);
    w.clock.advance(1_000);
    const third = await ann("publish_fact", {
      claim: "Payroll runs on the 25th!",
      citations: "docs/payroll.md:5",
    });

    const undone = await revertRuling(
      withMergeBeforeUnit(),
      s.ann,
      await rulingOn(s.ann, first.id),
    );
    await w.runJobs(s.ports);

    expect(undone.reverted).toBe(true);
    expect((await s.seenBy(s.ann, second.id))?.supersededBy).toBe(third.id);
    expect(JSON.stringify((await s.seenBy(s.ann, third.id))?.citations)).not.toContain(SECRET);
    // The restored fact has a source of its own, so it is shared again, its other citation with it.
    expect(JSON.stringify((await s.seenBy(s.bob, first.id))?.citations)).toContain(SECRET);
    await redactFact(s.ports, s.ann, { id: first.id });
    expect(await exportedTo(s.bob, project)).not.toContain(SECRET);
    expect(await exportedTo(s.ann, project)).not.toContain(SECRET);
  });

  test("R2: a chain kept private for one duplicate's word alone says so, and moves by itself once that duplicate is redacted or its merge undone, whatever the survivor took", async () => {
    for (const [name, lift] of [
      ["redacted", (id: string) => redactFact(s.ports, s.ann, { id })],
      ["undone", async (id: string) => revertRuling(s.ports, s.ann, await rulingOn(s.ann, id))],
    ] as const) {
      const project = P(`r2-${name}`);
      const ann = s.calls(s.ann, project);
      const word = { kind: "person", who: "the CFO, in confidence" };
      const first = await ann("publish_fact", {
        claim: `Deploys freeze on Fridays (${name})`,
        citations: [word],
      });
      w.clock.advance(1_000);
      // The survivor holds the same word already, so the merge hands it nothing.
      const second = await ann("publish_fact", {
        claim: `deploys freeze on fridays (${name}).`,
        citations: ["docs/release.md:3", word],
      });
      await w.runJobs(s.ports);
      expect((await s.seenBy(s.ann, first.id))?.supersededBy).toBe(second.id);
      w.clock.advance(60_000);
      expect((await s.choose(s.ann, project, "shared")).moved.facts).toBe(0);
      expect(await audienceOf(s.bob, second.id)).toBe("unseen");
      expect(await because(s.ann, second.id)).toBe("merged_word");

      await lift(first.id);

      expect(await audienceOf(s.bob, second.id)).toBe("shared");
      expect(await because(s.ann, second.id)).toBeUndefined();
      expect((await s.choose(s.ann, project, "shared")).moved.facts).toBe(0);
    }
  });

  test("R3 and R8: nobody else's choice moves a person's fact: one that cites a fact its author took back stays shared and flagged, and can be corrected", async () => {
    const project = P("r3");
    await s.choose(s.ann, project, "shared");
    await s.choose(s.bob, project, "shared");
    const [ann, bob] = [s.calls(s.ann, project), s.calls(s.bob, project)];
    const source = await ann("publish_fact", {
      claim: "Queue workers are capped at eight",
      citations: CHECKABLE,
    });
    const cite = { kind: "fact", fact: source.id };
    const first = await bob("publish_fact", {
      claim: "The nightly batch needs four workers",
      citations: ["src/batch.ts:1", cite],
    });
    w.clock.advance(1_000);
    const resting = await bob("publish_fact", {
      claim: "the nightly batch needs four workers.",
      citations: ["src/batch.ts:7", cite],
    });
    await w.runJobs(s.ports);
    expect((await s.seenBy(s.bob, first.id))?.supersededBy).toBe(resting.id);
    await s.choose(s.ann, project, "private");
    await w.runJobs(s.ports);

    // A new claim with the citations it had: the same call works the first time.
    const corrected = await bob("update_fact", {
      id: resting.id,
      claim: "The nightly batch needs six workers",
    });
    expect(corrected.flags).toContain("source_changed");
    expect(await audienceOf(s.ann, resting.id)).toBe("shared");
    // Sending the dead citation again is refused, and the refusal names it.
    await expect(
      bob("update_fact", { id: resting.id, citations: ["src/batch.ts:7", cite] }),
    ).rejects.toThrow(`A citation names fact ${source.id}, which is not visible here.`);
    // Dropping it leaves the fact where it was, a merged duplicate that still cites it and all.
    await bob("update_fact", { id: resting.id, citations: ["src/batch.ts:7"] });
    expect(await audienceOf(s.ann, resting.id)).toBe("shared");
    expect((await s.seenBy(s.ann, resting.id))?.citations).toHaveLength(1);
  });

  test.each([
    ["a redaction", "redaction"],
    ["the undoing of a merge", "undo"],
  ] as const)(
    "R4: %s whose survivor cites a shared fact does not wait on that fact's withdrawal while the withdrawal waits on it",
    async (_, what) => {
      const [mine, his] = [P(`r4-${what}-ann`), P(`r4-${what}-bob`)];
      await s.choose(s.bob, his, "shared");
      const cited = await s.calls(s.bob, his)("publish_fact", {
        claim: `The ledger service owns the invoices table (${what})`,
        citations: CHECKABLE,
      });
      const ann = s.calls(s.ann, mine);
      const first = await ann("publish_fact", {
        claim: `Invoice exports read the ledger service (${what})`,
        citations: [{ kind: "web", url: "https://wiki.acme.example/billing", quote: SECRET }],
      });
      w.clock.advance(1_000);
      const second = await ann("publish_fact", {
        claim: `invoice exports read the ledger service (${what}).`,
        citations: ["docs/exports.md:3", { kind: "fact", fact: cited.id }],
      });
      await w.runJobs(s.ports);
      expect((await s.seenBy(s.ann, first.id))?.supersededBy).toBe(second.id);
      const ruling = await rulingOn(s.ann, first.id);
      const held = heldAfterRecite();

      const giving = settled(
        what === "undo"
          ? revertRuling(held.ports, s.ann, ruling)
          : redactFact(held.ports, s.ann, { id: first.id }),
      );
      await held.atRecite;
      const withdrawal = watched();
      const withdrawing = settled(
        chooseTreatment(withdrawal.ports, s.bob, { project: his, treatment: "private" }),
      );
      await withdrawal.waiting();
      held.release();

      expect({ giveBack: await giving, withdrawal: await withdrawing }).toEqual({
        giveBack: "ok",
        withdrawal: "ok",
      });
      const listed = (await listProjects(s.ports, s.bob)).projects.find((p) => p.key === his);
      expect(listed?.treatment).toBe("private");
    },
  );

  test("nor does the rule's merge, whose survivor takes a citation of a shared fact", async () => {
    const [mine, his] = [P("merge-ann"), P("merge-bob")];
    await s.choose(s.bob, his, "shared");
    const cited = await s.calls(s.bob, his)("publish_fact", {
      claim: "The mailer owns the outbox table",
      citations: CHECKABLE,
    });
    const ann = s.calls(s.ann, mine);
    const first = await ann("publish_fact", {
      claim: "Receipts are sent by the mailer",
      citations: ["docs/receipts.md:1", { kind: "fact", fact: cited.id }],
    });
    w.clock.advance(1_000);
    const second = await ann("publish_fact", {
      claim: "receipts are sent by the mailer.",
      citations: "docs/receipts.md:8",
    });
    const held = heldAfterRecite();

    const merging = settled(w.runJobs(held.ports));
    await held.atRecite;
    const withdrawal = watched();
    const withdrawing = settled(
      chooseTreatment(withdrawal.ports, s.bob, { project: his, treatment: "private" }),
    );
    await withdrawal.waiting();
    held.release();

    expect({ merge: await merging, withdrawal: await withdrawing }).toEqual({
      merge: "ok",
      withdrawal: "ok",
    });
    expect((await s.seenBy(s.ann, first.id))?.supersededBy).toBe(second.id);
  });

  test("a fact that cites a private fact of its author's says so, and follows that fact when it is shared or taken back, in whichever project it is and by that project's own choice", async () => {
    const [here, there] = [P("follows"), P("follows-elsewhere")];
    await s.choose(s.ann, here, "shared");
    const ann = s.calls(s.ann, here);
    const base = await ann("publish_fact", {
      claim: "The cache is flushed at midnight",
      citations: [{ kind: "person", who: "the on-call engineer" }],
    });
    const cite = { kind: "fact", fact: base.id };
    const resting = await ann("publish_fact", {
      claim: "Reports are stale until a minute past midnight",
      citations: ["src/reports.ts:4", cite],
    });
    const elsewhere = await s.calls(s.ann, there)("publish_fact", {
      claim: "The nightly export starts after the cache flush",
      citations: ["src/export.ts:9", cite],
    });
    expect(await because(s.ann, base.id)).toBe("no_source");
    expect(await because(s.ann, resting.id)).toBe("cites_private");

    // Her agent gives the first fact a source: it is shared, and so is what only it held back,
    // but not the fact in a project she has not shared.
    await ann("update_fact", { id: base.id, citations: ["src/cache.ts:12"] });
    expect(await audienceOf(s.bob, base.id)).toBe("shared");
    expect(await audienceOf(s.bob, resting.id)).toBe("shared");
    expect(await because(s.ann, resting.id)).toBeUndefined();
    expect(await audienceOf(s.bob, elsewhere.id)).toBe("unseen");
    expect(await because(s.ann, elsewhere.id)).toBe("project");
    expect((await s.choose(s.ann, there, "shared")).moved.facts).toBe(1);
    expect(await audienceOf(s.bob, elsewhere.id)).toBe("shared");

    // Without a source again it comes home, and what cites it comes with it from both projects.
    await ann("update_fact", { id: base.id, citations: [{ kind: "person", who: "the on-call" }] });
    expect(await audienceOf(s.bob, base.id)).toBe("unseen");
    expect(await audienceOf(s.bob, resting.id)).toBe("unseen");
    expect(await audienceOf(s.bob, elsewhere.id)).toBe("unseen");
    expect(await because(s.ann, elsewhere.id)).toBe("cites_private");
    expect((await s.choose(s.ann, here, "shared")).moved.facts).toBe(0);
    expect((await s.choose(s.ann, there, "shared")).moved.facts).toBe(0);

    // With a source once more, both follow it back: each by its own project's choice.
    await s.choose(s.ann, there, "private");
    await ann("update_fact", { id: base.id, citations: ["src/cache.ts:12"] });
    expect(await audienceOf(s.bob, resting.id)).toBe("shared");
    expect(await audienceOf(s.bob, elsewhere.id)).toBe("unseen");
  });

  test("only the fact itself is held to what it cites: a duplicate behind it that cites a private fact does not hold it back", async () => {
    const project = P("head-alone");
    await s.choose(s.ann, project, "shared");
    const ann = s.calls(s.ann, project);
    const base = await ann("publish_fact", {
      claim: "The importer runs single-threaded",
      citations: [{ kind: "person", who: "its author" }],
    });
    const first = await ann("publish_fact", {
      claim: "Imports of a million rows take an hour",
      citations: ["docs/import.md:2", { kind: "fact", fact: base.id }],
    });
    w.clock.advance(1_000);
    const second = await ann("publish_fact", {
      claim: "imports of a million rows take an hour.",
      citations: ["docs/import.md:9", { kind: "fact", fact: base.id }],
    });
    await w.runJobs(s.ports);
    const head = (await s.seenBy(s.ann, first.id))?.supersededBy === null ? first.id : second.id;
    expect(await because(s.ann, head)).toBe("cites_private");

    // The live fact stops citing the private one; its earlier wording still does.
    await ann("update_fact", { id: head, citations: ["docs/import.md:9"] });

    expect(await audienceOf(s.bob, head)).toBe("shared");
    expect(await audienceOf(s.bob, base.id)).toBe("unseen");
  });

  test("a redacted fact stays where those who cited it can see that it was redacted, until its author takes the project back", async () => {
    const project = P("stub");
    await s.choose(s.ann, project, "shared");
    const made = await s.calls(s.ann, project)("publish_fact", {
      claim: "The staging database is refreshed on Mondays",
      citations: CHECKABLE,
    });
    await redactFact(s.ports, s.ann, { id: made.id });
    expect(await s.seenBy(s.bob, made.id)).toMatchObject({ claim: null });

    await s.choose(s.ann, project, "shared");
    expect(await s.seenBy(s.bob, made.id)).toMatchObject({ claim: null });
    await s.choose(s.ann, project, "private");
    expect(await s.seenBy(s.bob, made.id)).toBeNull();
    await s.choose(s.ann, project, "shared");
    expect(await s.seenBy(s.bob, made.id)).toBeNull();
  });

  test("a merge that leaves a chain nothing holds back shares it, by the rule's hand and not the person's", async () => {
    const project = P("merged-into-view");
    await s.choose(s.ann, project, "shared");
    const ann = s.calls(s.ann, project);
    const heard = await ann("publish_fact", {
      claim: "Search indexes rebuild on deploy",
      citations: [{ kind: "person", who: "the search lead" }],
    });
    w.clock.advance(1_000);
    // The same claim again with a source, resting on the first; then the first is given a
    // source and rests on the second. Each is private only because it cites the other.
    const sourced = await ann("publish_fact", {
      claim: "search indexes rebuild on deploy.",
      citations: ["src/search/index.ts:3", { kind: "fact", fact: heard.id }],
    });
    w.clock.advance(1_000);
    await ann("update_fact", {
      id: heard.id,
      citations: ["src/search/build.ts:8", { kind: "fact", fact: sourced.id }],
    });
    expect(await because(s.ann, heard.id)).toBe("cites_private");
    expect(await because(s.ann, sourced.id)).toBe("cites_private");
    expect(await audienceOf(s.bob, sourced.id)).toBe("unseen");

    // The rule merges the two: the fact that survives cites only its own earlier wording.
    await w.runJobs(s.ports);

    const merged = await s.seenBy(s.ann, sourced.id);
    const head = merged?.supersededBy ?? sourced.id;
    expect([heard.id, sourced.id].filter((id) => id !== head)).toHaveLength(1);
    expect(await audienceOf(s.bob, head)).toBe("shared");
    expect(await because(s.ann, head)).toBeUndefined();
    const moves = (await factDetail(s.ports, s.bob, head)).history.filter(
      (entry) => entry.kind === "FactShared",
    );
    expect(moves.map((entry) => entry.actor)).toEqual(["consolidate"]);
    expect((await s.choose(s.ann, project, "shared")).moved.facts).toBe(0);
  });
});
