import type { Store } from "@uketsugi/core";
import { eventually, onTestServer } from "@uketsugi/testkit";

/**
 * What shows that an operation is waiting on a unit that is held, so that a test releases the unit
 * once the wait is there and not after a time. The operation runs on `store`.
 *
 * On a server the wait is the database's own account of it: a session of the test's database is
 * waiting for a lock, which only the held unit's row can be, since nothing else is running.
 *
 * On the embedded store one connection is held by the unit, so a call to the store that has not
 * been answered is waiting for it. Such a call is counted from the turn it is made, and the
 * test's poll comes in a later one.
 */
export function waitingOnHeldUnit(inner: Store, database: string | null) {
  if (database !== null) {
    return {
      store: inner,
      waiting: () =>
        eventually(async () => {
          const rows = await onTestServer(
            `SELECT 1 FROM pg_stat_activity WHERE datname = '${database}' AND wait_event_type = 'Lock'`,
          );
          if (rows.length === 0) throw new Error("no session is waiting for a lock");
        }),
    };
  }
  let unanswered = 0;
  const counted = <T extends object>(repo: T): T =>
    new Proxy(repo, {
      get(target, key, receiver) {
        const member: unknown = Reflect.get(target, key, receiver);
        if (typeof member !== "function") return member;
        return async (...args: unknown[]) => {
          unanswered += 1;
          try {
            return await (member as (...args: unknown[]) => unknown).apply(target, args);
          } finally {
            unanswered -= 1;
          }
        };
      },
    });
  const store = Object.fromEntries(
    Object.entries(inner).map(([key, member]) => [
      key,
      key !== "unit" && typeof member === "object" && member !== null ? counted(member) : member,
    ]),
  ) as unknown as Store;
  return {
    store,
    waiting: () =>
      eventually(() => {
        if (unanswered === 0) throw new Error("no call to the store is waiting");
      }),
  };
}
