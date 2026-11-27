/**
 * Sharing between two people on one server, through the tools and the choice each person makes:
 * where a write lands, what the other person sees and may do, what a choice moves and what going
 * back takes home. On the embedded store and on a PostgreSQL server.
 */
import { TREATMENT_TEXT, UNCHOSEN_NOTICE } from "@uketsugi/contracts";
import {
  createNamedProject,
  factDetail,
  listProjects,
  listRulings,
  redactFact,
  revertRuling,
} from "@uketsugi/core";
import { expect, test } from "vitest";
import { CHECKABLE, sharedWorld, TESTIMONY } from "./sharing-world.ts";
import { describeUseCases } from "./use-case-world.ts";

const P = (n: number): string => `github.com/acme/shared-${n}`;

describeUseCases("sharing a project between two people", (w) => {
  const s = sharedWorld(w);
  const kinds = async (who: typeof s.ann, id: string) =>
    (await factDetail(s.ports, who, id)).history.map((entry) => entry.kind);

  test("a project is private until its person shares it; then what others can check lands where they see it", async () => {
    const [ann, bob] = [s.calls(s.ann, P(1)), s.calls(s.bob, P(1))];
    const early = await ann("publish_fact", {
      claim: "Retries stop after five",
      citations: CHECKABLE,
    });
    expect(early.treatment).toBe(TREATMENT_TEXT.private);
    expect(early.text).toContain(`project: ${P(1)} · used here, private`);
    expect(early.brief?.notice).toBe(UNCHOSEN_NOTICE);
    expect(early.text).toContain(UNCHOSEN_NOTICE);
    expect((await bob("search_facts", { query: "retries" })).matched).toBe(0);

    w.clock.advance(60_000);
    expect(await s.choose(s.ann, P(1), "shared")).toEqual({
      project: P(1),
      treatment: "shared",
      moved: { facts: 1, tasks: 0 },
    });
    const cited = await ann("publish_fact", {
      claim: "Backoff doubles each try",
      citations: CHECKABLE,
    });
    const word = await ann("publish_fact", {
      claim: "The retry suite passes",
      citations: [TESTIMONY],
    });
    const open = await ann("publish_task", { title: "Move the schedule to config" });
    const step = await ann("publish_task", { title: "Read retry.ts first", tracked: true });
    expect(cited.text).toContain(`project: ${P(1)} · used here, shared`);
    expect(cited.brief).toBeUndefined();
    const shared = s.ann.sharedAudienceId;
    expect((await s.seenBy(s.ann, early.id))?.audienceId).toBe(shared);
    expect((await s.seenBy(s.ann, cited.id))?.audienceId).toBe(shared);
    expect((await s.seenBy(s.ann, word.id))?.audienceId).toBe(s.ann.privateAudienceId);

    const found = await bob("search_facts", { query: "retries backoff suite" });
    expect(found.facts.map((fact) => [fact.claim, fact.author]).sort()).toEqual([
      ["Backoff doubles each try", "ann"],
      ["Retries stop after five", "ann"],
    ]);
    expect(found.treatment).toBe(TREATMENT_TEXT.private);
    expect(await s.seenBy(s.bob, word.id)).toBeNull();
    const tasks = await bob("search_tasks", {});
    expect(tasks.tasks.map((task) => [task.id, task.publisher])).toEqual([[open.task.id, "ann"]]);
    expect((await ann("search_tasks", {})).tasks.map((task) => task.id).sort()).toEqual(
      [open.task.id, step.task.id].sort(),
    );
    // Their own facts say `you`; nobody else's does.
    const mine = await ann("search_facts", { query: "retries backoff suite" });
    expect(new Set(mine.facts.map((fact) => fact.author))).toEqual(new Set(["you"]));
  });

  test("a call writes to what others shared only from a project its person shares, and then it can build on it", async () => {
    const [ann, bob] = [s.calls(s.ann, P(2)), s.calls(s.bob, P(2))];
    await s.choose(s.ann, P(2), "shared");
    const fact = await ann("publish_fact", {
      claim: "Webhooks are signed with HMAC",
      citations: CHECKABLE,
    });
    const task = await ann("publish_task", { title: "Rotate the signing key" });
    const refused =
      /is shared with everyone on this server, and this project is private for your person/;
    await expect(
      bob("update_fact", { id: fact.id, confirm: { checked: "read it" } }),
    ).rejects.toThrow(refused);
    await expect(bob("update_fact", { id: fact.id, flag: "stale" })).rejects.toThrow(refused);
    await expect(bob("claim_task", { id: task.task.id })).rejects.toThrow(refused);
    expect((await s.seenBy(s.ann, fact.id))?.status).toBe("unconfirmed");

    await s.choose(s.bob, P(2), "shared");
    const confirmed = await bob("update_fact", {
      id: fact.id,
      confirm: { checked: "read sign.ts" },
    });
    expect(confirmed).toMatchObject({ status: "confirmed", treatment: TREATMENT_TEXT.shared });
    const built = await bob("publish_fact", {
      claim: "A replayed webhook fails the signature check",
      citations: [{ kind: "fact", fact: fact.id }, "src/sign.ts:4"],
    });
    expect(built.citations.map((citation) => citation.class)).toEqual(["checkable", "checkable"]);
    expect((await s.seenBy(s.ann, built.id))?.audienceId).toBe(s.ann.sharedAudienceId);
    const claimed = await bob("claim_task", { id: task.task.id });
    await bob("update_task", {
      id: task.task.id,
      lease: claimed.lease,
      note: "Key rotated in staging.",
    });

    const seen = await ann("search_facts", { query: "webhook signature" });
    expect(seen.facts.map((entry) => [entry.author, entry.trust]).sort()).toEqual([
      ["bob", "unreviewed"],
      ["you", "reviewed"],
    ]);
    const held = await ann("search_tasks", { id: task.task.id });
    expect(held.tasks[0]).toMatchObject({ holder: "bob", note_by: "bob", publisher: "you" });
  });

  test("going back takes a person's own records home, and tells whoever built on them", async () => {
    const [ann, bob] = [s.calls(s.ann, P(3)), s.calls(s.bob, P(3))];
    await s.choose(s.ann, P(3), "shared");
    await s.choose(s.bob, P(3), "shared");
    const fact = await ann("publish_fact", { claim: "Exports are gzipped", citations: CHECKABLE });
    const task = await ann("publish_task", { title: "Stream the export" });
    await bob("update_fact", { id: fact.id, confirm: { checked: "read export.ts" } });
    const rests = await bob("publish_fact", {
      claim: "An export of a year is under a megabyte",
      citations: [{ kind: "fact", fact: fact.id }],
    });
    const { lease } = await bob("claim_task", { id: task.task.id });

    w.clock.advance(60_000);
    expect((await s.choose(s.ann, P(3), "private")).moved).toEqual({ facts: 1, tasks: 1 });
    expect(await s.seenBy(s.bob, fact.id)).toBeNull();
    expect(await s.seenBy(s.ann, fact.id)).toMatchObject({
      audienceId: s.ann.privateAudienceId,
      status: "unconfirmed",
    });
    expect(await s.ports.store.review.confirmations(w.scope, [fact.id])).toEqual([]);
    expect((await bob("search_facts", { id: rests.id })).facts[0]?.flags).toEqual([
      "source_changed",
    ]);
    await expect(bob("update_task", { id: task.task.id, lease, note: "x" })).rejects.toThrow(
      /No task/,
    );
    expect((await ann("search_tasks", {})).tasks.map((entry) => entry.id)).toEqual([task.task.id]);
    expect(
      (await ann("publish_fact", { claim: "Exports are dated", citations: CHECKABLE })).treatment,
    ).toBe(TREATMENT_TEXT.private);
    // Its author reads the whole of its history, each move once; choosing again moves nothing more.
    expect(await kinds(s.ann, fact.id)).toEqual([
      "FactWithdrawn",
      "FactConfirmed",
      "FactPublished",
    ]);
    expect((await s.choose(s.ann, P(3), "private")).moved).toEqual({ facts: 0, tasks: 0 });
  });

  test("another person sees nothing of a fact's private past, in its history or in the shared log", async () => {
    const ann = s.calls(s.ann, P(4));
    const fact = await ann("publish_fact", {
      claim: "Uploads are capped at 5 MB",
      citations: CHECKABLE,
    });
    await ann("update_fact", { id: fact.id, claim: "Uploads are capped at 10 MB" });
    await ann("update_fact", { id: fact.id, flag: "stale" });
    w.clock.advance(60_000);
    await s.choose(s.ann, P(4), "shared");
    expect(await kinds(s.bob, fact.id)).toEqual(["FactShared"]);
    expect(await kinds(s.ann, fact.id)).toEqual([
      "FactShared",
      "FlagRaised",
      "FactRewritten",
      "FactPublished",
    ]);
    const inShared = await s.logged(s.ann.sharedAudienceId ?? "", fact.id);
    expect(inShared.map((event) => [event.kind, event.payload])).toEqual([["FactShared", {}]]);
    const inPrivate = await s.logged(s.ann.privateAudienceId, fact.id);
    expect(inPrivate.at(-1)).toMatchObject({ kind: "FactShared", payload: { left: true } });

    // A redaction reaches the fact's entries in both logs: no hash of its text is left in either.
    await redactFact(s.ports, s.ann, { id: fact.id });
    const hashes = (events: Awaited<typeof inPrivate>) =>
      events
        .flatMap((event) => Object.keys(event.payload))
        .filter((key) => /hash|before|after/i.test(key));
    expect(hashes(await s.logged(s.ann.privateAudienceId, fact.id))).toEqual([]);
    expect(hashes(await s.logged(s.ann.sharedAudienceId ?? "", fact.id))).toEqual([]);
    expect(await kinds(s.bob, fact.id)).toEqual(["FactRedacted", "FactShared"]);
  });

  test("a chain moves whole, and its merge is undone where it now lives, by its author alone", async () => {
    const ann = s.calls(s.ann, P(5));
    const first = await ann("publish_fact", {
      claim: "Logs rotate daily at midnight",
      citations: "src/log.ts:3",
    });
    w.clock.advance(1_000);
    const second = await ann("publish_fact", {
      claim: "logs rotate daily, at midnight.",
      citations: "docs/log.md:1",
    });
    await w.runJobs(s.ports);
    expect((await s.seenBy(s.ann, first.id))?.supersededBy).toBe(second.id);
    w.clock.advance(60_000);
    expect((await s.choose(s.ann, P(5), "shared")).moved.facts).toBe(1);
    const shared = s.ann.sharedAudienceId;
    expect((await s.seenBy(s.bob, first.id))?.audienceId).toBe(shared);
    expect((await s.seenBy(s.bob, second.id))?.audienceId).toBe(shared);

    const [ruling] = await s.ports.store.review.rulingsOf(s.everyone(), [first.id]);
    const listed = async (who: typeof s.ann) =>
      (await listRulings(s.ports, who)).rulings.find((entry) => entry.id === ruling?.id);
    expect(await listed(s.bob)).toMatchObject({ revertible: false, fact: first.id });
    expect(await listed(s.ann)).toMatchObject({ revertible: true });
    await expect(revertRuling(s.ports, s.bob, ruling?.id ?? "")).rejects.toThrow(
      /merged another person's facts/,
    );
    expect(await revertRuling(s.ports, s.ann, ruling?.id ?? "")).toMatchObject({ reverted: true });
    expect(await s.seenBy(s.bob, first.id)).toMatchObject({
      status: "unconfirmed",
      audienceId: shared,
    });
    const paths = (await s.seenBy(s.bob, second.id))?.citations.map(({ citation }) =>
      citation.kind === "file" ? citation.path : citation.kind,
    );
    expect(paths).toEqual(["docs/log.md"]);
  });

  test("the rule merges one author's duplicates and never one person's fact into another's", async () => {
    const [ann, bob] = [s.calls(s.ann, P(6)), s.calls(s.bob, P(6))];
    await s.choose(s.ann, P(6), "shared");
    await s.choose(s.bob, P(6), "shared");
    const hers = await ann("publish_fact", {
      claim: "Sessions expire after twelve hours",
      citations: CHECKABLE,
    });
    w.clock.advance(1_000);
    const his = await bob("publish_fact", {
      claim: "sessions expire after twelve hours.",
      citations: "docs/auth.md:7",
    });
    expect(his.similar).toMatchObject([{ id: hers.id }]);
    await w.runJobs(s.ports);
    expect((await s.seenBy(s.bob, hers.id))?.status).toBe("unconfirmed");
    expect((await s.seenBy(s.ann, his.id))?.status).toBe("unconfirmed");
  });

  test("a fact is shared when others can check it: by its own source, and by every fact it cites", async () => {
    const ann = s.calls(s.ann, P(7));
    const word = await ann("publish_fact", {
      claim: "The cache was cold on Monday",
      citations: [TESTIMONY],
    });
    const onWord = await ann("publish_fact", {
      claim: "Cold starts take nine seconds",
      citations: [{ kind: "fact", fact: word.id }, "src/cache.ts:1"],
    });
    const source = await ann("publish_fact", {
      claim: "The cache holds 512 entries",
      citations: "src/cache.ts:8",
    });
    const onSource = await ann("publish_fact", {
      claim: "The cache evicts at 513 entries",
      citations: [{ kind: "fact", fact: source.id }],
    });
    expect((await s.choose(s.ann, P(7), "shared")).moved.facts).toBe(2);
    const where = async (id: string) => (await s.seenBy(s.ann, id))?.audienceId;
    const [own, shared] = [s.ann.privateAudienceId, s.ann.sharedAudienceId];
    expect(
      await Promise.all([word, onWord, source, onSource].map((fact) => where(fact.id))),
    ).toEqual([own, own, shared, shared]);
    // A correction puts a fact where its citations now say it belongs, in either direction.
    await ann("update_fact", { id: word.id, citations: ["src/cache.ts:20"] });
    expect(await where(word.id)).toBe(shared);
    await ann("update_fact", { id: source.id, citations: [TESTIMONY] });
    expect(await where(source.id)).toBe(own);
    expect(await s.seenBy(s.bob, source.id)).toBeNull();
  });

  test("each person's projects and choices are their own, and a named project stays private", async () => {
    const mine = await listProjects(s.ports, s.bob);
    expect(mine.sharing).toBe(true);
    expect(mine.projects.map((project) => project.key)).not.toContain(P(4));
    expect(mine.projects.find((project) => project.key === P(1))).toMatchObject({
      treatment: "private",
      chosen: false,
    });
    expect(mine.projects.find((project) => project.key === P(2))).toMatchObject({
      treatment: "shared",
      chosen: true,
    });
    await expect(s.choose(s.bob, "me/notes", "shared")).rejects.toThrow(/does not name a project/);
  });

  test("a person's projects say nothing of when anyone else first worked in one, or made one of the same name", async () => {
    const secret = "github.com/acme/secret-acquisition";
    await s.calls(s.ann, secret)("search_facts", { query: "terms" });
    const hers = w.clock.now().toISOString().slice(0, 10);
    w.clock.advance(21 * 24 * 3_600_000);
    // Bob guesses the repository's name three weeks later.
    await s.calls(s.bob, secret)("search_facts", { query: "terms" });
    const his = (await listProjects(s.ports, s.bob)).projects.find((p) => p.key === secret);
    await createNamedProject(s.ports, s.ann, { slug: "layoffs-q1", name: "Plan" });
    w.clock.advance(21 * 24 * 3_600_000);
    const made = await createNamedProject(s.ports, s.bob, { slug: "layoffs-q1", name: "Mine" });

    const fields = ["chosen", "facts", "key", "kind", "name", "names", "treatment"];
    expect(Object.keys(his ?? {}).sort()).toEqual(fields);
    expect(Object.keys(made).sort()).toEqual(fields);
    expect(JSON.stringify([his, made])).not.toContain(hers);
  });
});

describeUseCases("a host with one person", (w) => {
  test("nothing is asked and everything is private, as before", async () => {
    const published = await w.publish("Invoices are numbered per tenant");
    expect(published.treatment).toBe(TREATMENT_TEXT.private);
    expect(published.text).toContain("used here, private");
    expect(published.brief?.notice).toBeUndefined();
    expect(published.text).not.toContain("has not chosen");
    expect(w.owner).toMatchObject({ sharedAudienceId: null });
    expect((await w.factOf(published.id)).audienceId).toBe(w.owner.privateAudienceId);
    expect(await listProjects(w.portsWith(null), w.owner)).toMatchObject({ sharing: false });
    const { chooseTreatment } = await import("@uketsugi/core");
    await expect(
      chooseTreatment(w.portsWith(null), w.owner, {
        project: "github.com/acme/api",
        treatment: "shared",
      }),
    ).rejects.toThrow(/has one person/);
  });
});
