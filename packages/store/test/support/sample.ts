/** One person and the facts they publish, for the tests of how a store is hosted. */
import type { Caller, Store } from "@uketsugi/core";
import {
  fakeUuid,
  SAMPLE_PROJECT,
  sampleEvent,
  sampleFactContent,
  targetOf,
} from "@uketsugi/testkit";

const AT = new Date("2026-01-01T00:00:00.000Z");

/** The person the samples belong to; the same caller however often, and in whichever process, it is asked for. */
export function sampleOwner(store: Store): Promise<Caller> {
  return store.directory.ensurePrincipal({
    subject: "test:owner",
    displayName: "owner",
    orgId: fakeUuid(0, 1),
    principalId: fakeUuid(0, 2),
    audienceId: fakeUuid(0, 3),
  });
}

/**
 * Publishes the owner's `n`th fact with its event, in one unit, and returns the fact's id.
 * `beforeCommit` runs inside the unit after both are written.
 */
export async function publishSample(
  store: Store,
  owner: Caller,
  n: number,
  beforeCommit: () => Promise<unknown> = () => Promise.resolve(),
): Promise<string> {
  const id = fakeUuid(1, n);
  const content = sampleFactContent(`Sample fact ${n} retries five times with backoff`);
  await store.unit(targetOf(owner, AT), async (unit) => {
    const fact = { id, project: SAMPLE_PROJECT, author: owner.principalId };
    await unit.facts.insert({ ...fact, content, vector: null });
    await unit.append(sampleEvent(id, owner.principalId));
    await beforeCommit();
  });
  return id;
}
