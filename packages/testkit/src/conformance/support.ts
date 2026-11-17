/** What the Store suites share: the store under test, the people who write in it and the sample records they write. */
import { createHash } from "node:crypto";
import type { Caller, EventDraft, FactContent, Store, UnitTarget } from "@uketsugi/core";
import type { FakeIdGen } from "../fakes.ts";

/** A Store under test: `open` gives a new, empty, migrated store each time. */
export interface StoreHarness {
  open(): Promise<Store>;
}

/** The project every sample record is published in. */
export const PROJECT = "github.com/acme/api";

/** The SHA-256 of a seed, in hex: distinct seeds give distinct hashes. */
export function hash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

/** A fact's content with one file citation; the hashes are of the claim, not of the canonical content. */
export function content(claim: string, detail: string | null = null): FactContent {
  const citation = { kind: "file" as const, repo: PROJECT, path: "src/retry.ts", lines: "10-20" };
  return {
    claim,
    detail,
    question: null,
    citations: [{ citation, class: "checkable" }],
    contentHash: hash(`content of ${claim}`),
    claimHash: hash(claim),
    idents: [],
    citedFacts: [],
  };
}

/** What every session a test opens by hand holds of the model step: no model has read it. */
export const UNREAD = {
  digestedAt: null,
  modelTokens: { input: 0, output: 0 },
  digestFailure: null,
} as const;

/** An event a person appends about a record. */
export function event(
  subject: string,
  person: string,
  kind: EventDraft["kind"] = "FactPublished",
  payload: EventDraft["payload"] = {},
): EventDraft {
  return { kind, subject, actor: { kind: "person", id: person }, session: null, payload };
}

/** The unit a person writes in: their private audience, at one instant. */
export function targetOf(caller: Caller, at: Date): UnitTarget {
  return { orgId: caller.orgId, audienceId: caller.privateAudienceId, at };
}

/** A person of an organization of their own, the same however often the subject is asked for. */
export function person(store: Store, ids: FakeIdGen, subject: string): Promise<Caller> {
  return store.directory.ensurePrincipal({
    subject,
    displayName: subject,
    orgId: ids.uuid(),
    principalId: ids.uuid(),
    audienceId: ids.uuid(),
  });
}

/** A new store from the harness with the two people every suite writes as. */
export async function openWithPeople(
  harness: StoreHarness,
  ids: FakeIdGen,
): Promise<{ store: Store; alice: Caller; bob: Caller }> {
  const store = await harness.open();
  return {
    store,
    alice: await person(store, ids, "test:alice"),
    bob: await person(store, ids, "test:bob"),
  };
}
