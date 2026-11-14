/** Deterministic stand-ins for the ports that read the world: time, randomness and the embedding model. */
import type { Clock, Embedder, IdGen } from "@uketsugi/core";

/** A clock that moves only when a test moves it. */
export class FakeClock implements Clock {
  private ms: number;
  private pending: { deadline: number; controller: AbortController }[] = [];

  constructor(start: Date = new Date("2026-01-01T00:00:00.000Z")) {
    this.ms = start.getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  timeout(ms: number): AbortSignal {
    const controller = new AbortController();
    this.pending.push({ deadline: this.ms + ms, controller });
    return controller.signal;
  }

  /** Moves the clock forward and aborts every time limit it passes. */
  advance(ms: number): void {
    this.ms += ms;
    const due = this.pending.filter((entry) => entry.deadline <= this.ms);
    this.pending = this.pending.filter((entry) => entry.deadline > this.ms);
    for (const { controller } of due) {
      controller.abort(new DOMException("The operation timed out", "TimeoutError"));
    }
  }
}

/** The `n`th id of the generator with this seed, in the UUIDv7 layout: the same in every process. */
export function fakeUuid(seed: number, n: number): string {
  const time = n.toString(16).padStart(12, "0");
  const tail = seed.toString(16).padStart(8, "0") + (n % 0xffff).toString(16).padStart(4, "0");
  return `${time.slice(0, 8)}-${time.slice(8)}-7000-8000-${tail}`;
}

/**
 * Ids and bytes that repeat from run to run. Ids have the UUIDv7 layout and increase; `seed` keeps
 * two generators in one test from colliding.
 */
export class FakeIdGen implements IdGen {
  private count = 0;
  private state: number;
  private readonly seed: number;

  constructor(seed = 1) {
    this.seed = seed;
    this.state = seed * 2654435761;
  }

  uuid(): string {
    this.count += 1;
    return fakeUuid(this.seed, this.count);
  }

  bytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, () => {
      this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
      return this.state >>> 24;
    });
  }
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1)
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash;
}

/**
 * An embedder with no model: each word adds to one of `dims` buckets and the vector is scaled to
 * unit length, so texts that share words are close and the same text always gives the same vector.
 */
export class FakeEmbedder implements Embedder {
  readonly model = "fake-embedder";
  readonly dims: number;

  constructor(dims = 384) {
    this.dims = dims;
  }

  embed(texts: readonly string[]): Promise<Float32Array[]> {
    return Promise.resolve(texts.map((text) => this.one(text)));
  }

  private one(text: string): Float32Array {
    const vector = new Float32Array(this.dims);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      const hash = fnv1a(word);
      const bucket = (hash >>> 1) % this.dims;
      vector[bucket] = (vector[bucket] ?? 0) + (hash & 1 ? 1 : -1);
    }
    const norm = Math.hypot(...vector);
    return norm === 0 ? vector : vector.map((value) => value / norm);
  }
}
