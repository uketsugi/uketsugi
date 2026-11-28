/**
 * The small ports: everything core needs from outside except storage (see `store-port.ts`).
 * Every method that may reach a network or a disk is asynchronous.
 */
import type { Caller, RunnerKind } from "./domain.ts";
import type { SearchProfile } from "./search/fusion.ts";
import type { Store } from "./store-port.ts";

/** The only source of time. Core never reads the system clock. */
export interface Clock {
  /** The current instant, in whole milliseconds. */
  now(): Date;
  /** A signal that aborts once `ms` milliseconds have passed on this clock. */
  timeout(ms: number): AbortSignal;
}

/** The only source of ids and randomness. */
export interface IdGen {
  /** A new UUIDv7 in its canonical lower-case text form, increasing within one generator. */
  uuid(): string;
  /** `length` random bytes, for token material. */
  bytes(length: number): Uint8Array;
}

/** A vector with the id of the model that made it: a store keeps a vector only under its recorded model. */
export interface ModelVector {
  readonly model: string;
  readonly vector: Float32Array;
}

/** Turns texts into unit-length vectors of `dims` components. */
export interface Embedder {
  /**
   * The pinned model's id. A store records the id of the model that made its vectors: it sets them
   * aside when this one differs, and compares none that another model made.
   */
  readonly model: string;
  readonly dims: number;
  /**
   * One vector per text, in order. `kind` lets a model that embeds questions and documents
   * differently do so. Rejects with `EmbedError`; aborts when `signal` does.
   */
  embed(
    texts: readonly string[],
    kind: "document" | "query",
    signal?: AbortSignal,
  ): Promise<Float32Array[]>;
}

/** An embedder failure. `retryable` says whether the same texts may succeed later. */
export class EmbedError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "EmbedError";
    this.retryable = retryable;
  }
}

/** Why a request's credential was not accepted. */
export type AuthFailure = "missing" | "malformed" | "invalid" | "expired" | "revoked";

/** Thrown by `Identity.authenticate`; the server answers 401 with the identity's challenge. */
export class AuthError extends Error {
  readonly reason: AuthFailure;
  constructor(reason: AuthFailure) {
    super(`authentication failed: ${reason}`);
    this.name = "AuthError";
    this.reason = reason;
  }
}

/**
 * Resolves a request's credential to a caller. A local host checks a stored secret; Cloud
 * verifies a signed one. What a harness sends and what signs a person in are different
 * credentials, so that holding the first never gives the second.
 */
export interface Identity {
  /**
   * The caller a bearer credential belongs to, with the visible set already resolved.
   * `bearer` is the token alone, without the `Bearer ` prefix. It is undefined for a request that
   * carried none and that its transport knows came from the server's own machine and nowhere
   * else: an identity may answer that one with a person, and a transport asks for no other.
   * Rejects with `AuthError` and never with anything that names the token.
   */
  authenticate(bearer: string | undefined): Promise<Caller>;
  /**
   * The person a dashboard sign-in belongs to: what a browser is signed in with, which a harness
   * never holds. The token a harness sends is refused here, as any unknown secret is. Rejects
   * with `AuthError`.
   */
  signIn(key: string): Promise<Caller>;
  /**
   * A caller who signed in earlier, as they stand now: what a dashboard session asks on every
   * request, since it outlives the request that opened it. Null once the credential they signed
   * in with no longer holds, for example because it was revoked.
   */
  current(caller: Caller): Promise<Caller | null>;
  /** The `WWW-Authenticate` value of a 401, for example `Bearer` or `Bearer resource_metadata="…"`. */
  readonly challenge: string;
}

/**
 * One question for a model: what it is to do, the records it is to do it with, and the shape its
 * answer must have. The instructions are ours; the material is text a session left, which may
 * itself hold text aimed at a model, so a runner sends it as data and never as instructions.
 */
export interface Chore {
  /** Which step asks, for example `digest.extract`: what a log names the call by. */
  readonly step: string;
  readonly instructions: string;
  readonly material: string;
  /** A JSON Schema of the answer. A runner passes it on where its provider takes one; the asker checks the answer either way. */
  readonly shape: Readonly<Record<string, unknown>>;
}

/** A model's answer to a chore, parsed from JSON but not yet checked, and what it cost. */
export interface ModelAnswer {
  readonly output: unknown;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Who runs a job's model step: a provider the server's operator configured, or a hosted edition's
 * own. What a chore holds leaves the machine with it. A server without one runs on rules alone and
 * sends nothing anywhere.
 */
export interface ModelRunner {
  readonly kind: Exclude<RunnerKind, "rules">;
  /** What answers, as a person reads it: the provider and its model. */
  readonly name: string;
  /**
   * Whether what a person's sessions said may be sent to this model. Only a person agrees to that
   * for their own text, so whoever makes the runner says who has: a local server's model reads the
   * sessions of the person who runs it and configured it, and nobody else's.
   */
  serves(person: Pick<Caller, "orgId" | "principalId">): boolean;
  /**
   * The most tokens, input and output together, an organization may spend on this model in a day:
   * what its operator set, and on a person's own server, where the organization is one, the
   * server's. Readings that would pass it wait.
   */
  readonly dailyTokens: number;
  /** The most one person may spend in a day, where the operator set one: their next reading waits, and nobody else's does. Left out, a person is bound by the organization's alone. */
  readonly personDailyTokens?: number;
  /** Rejects with `ModelError`; aborts when `signal` does. */
  run(chore: Chore, signal?: AbortSignal): Promise<ModelAnswer>;
}

/**
 * A model call that failed. `retryable` says whether the same chore may succeed later. Its message
 * names the provider's reason and never what was sent: a chore holds a session's text.
 */
export class ModelError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "ModelError";
    this.retryable = retryable;
  }
}

/**
 * An answer that is not what the chore asked for (not the JSON, no list in it): asking again would
 * get the same, so a reading is given up at once. Every other `ModelError` is the provider's
 * failure (a hiccup, an outage, a key or an account it refuses), which a reading waits out.
 */
export class AnswerError extends ModelError {
  constructor(message: string) {
    super(message, false);
  }
}

/** The ports a use case works with. */
export interface CorePorts {
  readonly store: Store;
  readonly clock: Clock;
  readonly ids: IdGen;
  /** Null when no model is installed: search then runs on the lexical streams and says so. */
  readonly embedder: Embedder | null;
  /** Who runs a job's model step. Absent, every job runs on rules and nothing is sent to a model. */
  readonly runner?: ModelRunner;
  /** How long a task's lease lasts, in milliseconds. Absent means fifteen minutes. */
  readonly taskLeaseMs?: number;
  /** The values every search runs with. Absent means the fitted ones; a benchmark passes others to measure them. */
  readonly searchProfile?: SearchProfile;
}
