import { describe, expect, test } from "vitest";
import type { ClassedCitation, Fact } from "../src/domain.ts";
import { pickSurvivor, sameClaim, takeCitations } from "../src/facts/duplicates.ts";
import { backoffMs } from "../src/jobs/worker.ts";

const file = (path: string): ClassedCitation => ({
  citation: { kind: "file", repo: "github.com/acme/api", path },
  class: "checkable",
});
const said: ClassedCitation = {
  citation: { kind: "person", who: "the on-call engineer" },
  class: "testimony",
  reason: "a person said so",
};

function fact(id: string, changes: Partial<Fact> = {}): Fact {
  const at = new Date("2026-03-01T00:00:00.000Z");
  const who = { author: "p1", supersededBy: null };
  const hashes = { contentHash: id, claimHash: id, embedded: false, redactedAt: null };
  const text = { claim: "Webhooks retry five times", detail: null, question: null };
  const where = { orgId: "o1", audienceId: "a1", project: "github.com/acme/api" };
  const when = { createdAt: at, updatedAt: at };
  const status = "unconfirmed" as const;
  return {
    id,
    ...where,
    ...text,
    citations: [file("a.ts")],
    status,
    ...who,
    ...hashes,
    ...when,
    ...changes,
  };
}

describe("the merge rule", () => {
  test.each([
    ["Invoice webhooks retry five times.", "invoice webhooks retry five times"],
    ["The handler is idempotent on `event.id`", "Handler is idempotent on event.id"],
    ["Retries use a 30s back-off (see retry.ts)", "retries use a 30s back-off, see retry.ts"],
  ])("%j and %j say the same thing", (a, b) => {
    expect(sameClaim(a, b)).toBe(true);
  });

  test.each([
    ["Webhooks retry five times", "Webhooks retry seven times"],
    ["The cache is invalidated on write", "The cache is not invalidated on write"],
    ["The offset is -5 minutes", "The offset is 5 minutes"],
    ["PAY-4021 means the card was declined", "PAY-4012 means the card was declined"],
    ["The limit is 1.5 MB", "The limit is 15 MB"],
    ["Run v1.2 of the migration", "Run v12 of the migration"],
    ["The gateway calls the ledger", "The ledger calls the gateway"],
    ["The key is user_id", "The key is user id"],
  ])("%j and %j are not merged by rule", (a, b) => {
    expect(sameClaim(a, b)).toBe(false);
  });

  test("the best member is confirmed, then has a source anyone can open, then is newest", () => {
    const old = fact("f1");
    const newer = fact("f2", { updatedAt: new Date("2026-03-02T00:00:00.000Z") });
    const confirmed = fact("f3", { status: "confirmed", citations: [said] });
    const hearsay = fact("f4", {
      citations: [said],
      updatedAt: new Date("2026-03-09T00:00:00.000Z"),
    });
    expect(pickSurvivor([old, newer]).id).toBe("f2");
    expect(pickSurvivor([newer, old, hearsay]).id).toBe("f2");
    expect(pickSurvivor([old, newer, confirmed, hearsay]).id).toBe("f3");
    expect(pickSurvivor([old, fact("f0")]).id).toBe("f1");
  });

  test("the survivor takes each citation it lacks once, and none that names the group", () => {
    const toSurvivor: ClassedCitation = {
      citation: { kind: "fact", fact: "f1" },
      class: "checkable",
    };
    const member = fact("f2", { citations: [file("a.ts"), file("b.ts"), said, toSurvivor] });
    const took = takeCitations([file("a.ts")], member, new Set(["f1", "f2"]));
    expect(took.taken).toEqual([file("b.ts"), said]);
    expect(took.citations).toEqual([file("a.ts"), file("b.ts"), said]);
    expect(takeCitations(took.citations, member, new Set(["f1", "f2"])).taken).toEqual([]);
  });

  test("a failed job waits longer each time, and an hour at most", () => {
    expect([1, 2, 3, 20].map(backoffMs)).toEqual([10_000, 20_000, 40_000, 3_600_000]);
  });
});
