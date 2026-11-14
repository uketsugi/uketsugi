/**
 * The small ports: everything core needs from outside except storage (see `store-port.ts`).
 * Every method that may reach a network or a disk is asynchronous.
 */
import type { Caller, JobKind, RunnerKind } from "./domain.ts";
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

/** Turns texts into unit-length vectors of `dims` components. */
export interface Embedder {
  /** The pinned model's id. Vectors of different models are never compared. */
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
   * `bearer` is the token alone, without the `Bearer ` prefix, or undefined when the request
   * carried none. Rejects with `AuthError` and never with anything that names the token.
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

/** One unit of work for a model: a prompt, and the shape its output must have. */
export interface Chore {
  readonly job: JobKind;
  readonly orgId: string;
  /** A runner is sent only records of this audience. */
  readonly audienceId: string;
  readonly prompt: string;
  /** A JSON Schema the output must satisfy. */
  readonly shape: Readonly<Record<string, unknown>>;
}

/** Who runs a job's model step. A job always has a rule step whose result stands when no model runs. */
export interface ModelRunner {
  readonly kind: RunnerKind;
  /** The model's output for a chore, already parsed, or null when this runner runs no model. */
  run(chore: Chore, signal?: AbortSignal): Promise<unknown>;
}

/** The runner of every job in this build: nobody runs a prompt, and the rule step's result stands. */
export const RULES_RUNNER: ModelRunner = { kind: "rules", run: () => Promise.resolve(null) };

/** The ports a use case works with. */
export interface CorePorts {
  readonly store: Store;
  readonly clock: Clock;
  readonly ids: IdGen;
  /** Null when no model is installed: search then runs on the lexical streams and says so. */
  readonly embedder: Embedder | null;
  /** Who runs a job's model step. Absent means rules only. */
  readonly runner?: ModelRunner;
  /** How long a task's lease lasts, in milliseconds. Absent means fifteen minutes. */
  readonly taskLeaseMs?: number;
}
