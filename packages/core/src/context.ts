/**
 * What every use case stands on: who a call acts as and in which project and session, the scope a
 * read takes, the events a write appends, and the one way a text reaches the embedding model.
 */
import type { Envelope } from "@uketsugi/contracts";
import type {
  Actor,
  Caller,
  ClaimedJob,
  EventDraft,
  EventKind,
  EventPayloads,
  Fact,
  Project,
  ReadScope,
  Session,
} from "./domain.ts";
import { EmbedError, type CorePorts } from "./ports.ts";
import type { UnitWrites } from "./store-port.ts";

/** What a tool call acts as and in: resolved by the request pipeline before a use case runs. */
export interface CallContext {
  readonly caller: Caller;
  readonly project: Project;
  readonly session: Session;
}

/**
 * A tool's result before the pipeline adds what every result carries. A use case names what is
 * incomplete in its answer only when something is.
 */
export type Outcome<Result> = Omit<Result, keyof Envelope> & { readonly degraded?: string[] };

/** The caller's visible set as a read scope. */
export function scopeOf(caller: Caller): ReadScope {
  return { orgId: caller.orgId, audienceIds: caller.visibleAudienceIds };
}

/**
 * The scope a job about a fact reads in: its fact's audience. A job about a session names no
 * audience, and reads no fact by this.
 */
export function scopeOfJob(job: Pick<ClaimedJob, "orgId" | "audienceId">): ReadScope {
  return { orgId: job.orgId, audienceIds: job.audienceId === null ? [] : [job.audienceId] };
}

/**
 * Whether the model step may read a person's sessions: on a server with a model, and only for a
 * person its runner serves, who agreed to what a provider is sent.
 */
export function servedByModel(
  ports: Pick<CorePorts, "runner">,
  person: Pick<Caller, "orgId" | "principalId">,
): boolean {
  return ports.runner?.serves(person) ?? false;
}

/** An id as a caller wrote it, in the spelling the store keeps: trimmed, in lower case. */
export function idOf(written: string): string {
  return written.trim().toLowerCase();
}

/**
 * The live fact at the head of each superseded fact's chain, by that fact's id: what a result
 * names as `superseded_by` and where a write that names a superseded fact is sent. A fact stores
 * only the next link of its chain. One statement, and none when no fact given is superseded.
 */
export async function liveHeads(
  ports: Pick<CorePorts, "store">,
  scope: ReadScope,
  facts: readonly Fact[],
): Promise<ReadonlyMap<string, string>> {
  const superseded = facts.filter((fact) => fact.supersededBy !== null).map((fact) => fact.id);
  return superseded.length === 0 ? new Map() : ports.store.facts.heads(scope, superseded);
}

/** A person's display name among those looked up; someone no longer in the directory still gets one. */
export function nameOf(names: ReadonlyMap<string, string>, principalId: string): string {
  return names.get(principalId) ?? "someone who has left";
}

/** What a reader's own records say of who wrote them: an agent knows its person by no other name. */
const READER = "you";

/**
 * The display names of the people a result names, for one reader: everyone else by the name the
 * directory holds, the reader as `you`. A fact or a task so says whose it is without the reader
 * having to know their own person's name.
 */
export async function namesFor(
  ports: Pick<CorePorts, "store">,
  reader: Caller,
  principalIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(principalIds)];
  const names = new Map(await ports.store.directory.names(reader.orgId, ids));
  if (names.has(reader.principalId)) names.set(reader.principalId, READER);
  return names;
}

/** The caller as the actor of an event, a flag or a ruling. */
export function personActor(caller: Caller): Actor {
  return { kind: "person", id: caller.principalId };
}

/**
 * One text's vector from the model, waited for no longer than `budgetMs`: the one way a write, the
 * embed job and a search reach the embedder. Rejects with `EmbedError` when no model is installed
 * or it does not answer in time, and with the model's own error when it fails.
 */
export async function embedWithin(
  ports: Pick<CorePorts, "embedder" | "clock">,
  text: string,
  kind: "document" | "query",
  budgetMs: number,
): Promise<Float32Array> {
  if (ports.embedder === null) throw new EmbedError("no embedding model is installed", false);
  const signal = ports.clock.timeout(budgetMs);
  const late = new Promise<never>((_, reject) => {
    const timedOut = () => reject(new EmbedError("the model did not answer in time", true));
    signal.addEventListener("abort", timedOut, { once: true });
  });
  const [vector] = await Promise.race([ports.embedder.embed([text], kind, signal), late]);
  if (vector === undefined) throw new EmbedError("the model returned no vector", true);
  return vector;
}

/**
 * Leaves the job that gives a fact its vector, due at once. A host with no model leaves none: when
 * it gets one, the worker finds every fact without a vector.
 */
export async function leaveEmbedJob(
  ports: Pick<CorePorts, "ids" | "embedder">,
  unit: UnitWrites,
  factId: string,
  at: Date,
): Promise<void> {
  if (ports.embedder === null) return;
  await unit.enqueue({ id: ports.ids.uuid(), kind: "embed", subject: factId, runAfter: at });
}

/**
 * An event for a unit to append, by any actor: a person or a job. `payload` holds ids, codes and
 * hashes, never text. `session` is null when no tool call caused the event.
 */
export function eventBy<K extends EventKind>(
  by: { readonly actor: Actor; readonly session: string | null },
  kind: K,
  subject: string,
  payload: EventPayloads[K],
): EventDraft {
  return { kind, subject, actor: by.actor, session: by.session, payload };
}

/** An event by the caller of a tool call, in the call's session. */
export function eventOf<K extends EventKind>(
  ctx: Pick<CallContext, "caller" | "session">,
  kind: K,
  subject: string,
  payload: EventPayloads[K],
): EventDraft {
  return eventBy(
    { actor: personActor(ctx.caller), session: ctx.session.id },
    kind,
    subject,
    payload,
  );
}
