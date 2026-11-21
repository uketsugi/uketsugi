/**
 * What an edition holds for something begun and not yet finished, a login that has gone to the
 * provider and not come back: each entry lives for a time and the whole holds a number at most,
 * so that whoever begins logins without finishing them cannot make the server hold more.
 */

export interface PendingOptions {
  /** How long an entry can be taken. */
  readonly ttlMs: number;
  /** The most entries held. A new one beyond it pushes out the oldest. */
  readonly max: number;
}

export interface Pending<V> {
  /** Holds `value` under `id`, pushing out the oldest entry if the bound is reached. */
  put(id: string, value: V): void;
  /** Gives the entry back and forgets it; undefined if there is none or it has expired. */
  take(id: string): V | undefined;
}

/** A bounded store of entries that expire; `nowMs` is the server's clock. */
export function createPending<V>(nowMs: () => number, options: PendingOptions): Pending<V> {
  // A Map iterates in the order of insertion, and every entry lives as long as any other, so
  // the first is always the oldest.
  const entries = new Map<string, { value: V; expiresAt: number }>();
  return {
    put(id, value) {
      const now = nowMs();
      for (const [key, entry] of entries) {
        if (entry.expiresAt > now) break;
        entries.delete(key);
      }
      entries.delete(id);
      while (entries.size >= options.max) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      entries.set(id, { value, expiresAt: now + options.ttlMs });
    },
    take(id) {
      const entry = entries.get(id);
      entries.delete(id);
      return entry !== undefined && entry.expiresAt > nowMs() ? entry.value : undefined;
    },
  };
}
