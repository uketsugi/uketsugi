/**
 * Which conversation a tool call belongs to, where the harness's own hook says so. Claude Code
 * sends no conversation id on a call, but the hook it runs before the call is handed the call's
 * id beside the conversation's, and the plugin's hook sends the pair here ahead of the call. So
 * the call goes on its own conversation's session and nothing is inferred.
 *
 * The call is known by its id, which Claude Code also sends with the call itself. That it does is
 * nowhere promised, so two things stand behind it. A call that carries no id is taken for the
 * one its person's hook told of longest ago and no call has answered to yet: the hook runs just
 * before its call. And a connection keeps the conversation a hook's word last put one of its
 * calls on, for a call whose word never arrived.
 *
 * Each person has a pool of their own, so nobody's traffic pushes out another's word. A word is
 * kept for as long as a session may stay quiet: the person may be asked to allow the call, and
 * takes their time. One whose call never comes, because they said no, is dropped then.
 */
import { SESSION_IDLE_MS, type Clock } from "@uketsugi/core";

/** The most words kept for one person, and the most connections; the one heard longest ago goes first. */
const MOST = 64;

/** What a hook says of a call: the harness its session is keyed by, and the conversation. */
export interface Word {
  readonly client: string;
  readonly conversation: string;
}

export interface ToolUses {
  /** A hook's word: the person's call with this id belongs to this conversation. */
  expect(person: string, toolUse: string, word: Word): void;
  /**
   * The word about a call that has arrived on `connection`: by the call's id where it carries
   * one, else (`toolUse` null) the person's oldest word no call has answered to; where there is
   * none, the word the connection's last placed call had. Null where no hook has spoken.
   */
  of(person: string, toolUse: string | null, connection: string | null): Word | null;
}

interface Told {
  readonly word: Word;
  readonly at: number;
  /** Whether a call has answered to it. */
  met: boolean;
}

/** What one person's hooks have said: by call id, and by the connection a placed call came on. */
interface Said {
  readonly calls: Map<string, Told>;
  readonly connections: Map<string, Told>;
}

/** Puts a word under a key at the end of a pool, and drops what is stale or too much from its front. */
function keep(pool: Map<string, Told>, key: string, word: Word, at: number, met: boolean): void {
  pool.delete(key);
  pool.set(key, { word, at, met });
  for (const [oldest, told] of pool) {
    if (at - told.at <= SESSION_IDLE_MS && pool.size <= MOST) break;
    pool.delete(oldest);
  }
}

/** The words of one server process. */
export function createToolUses(ports: { clock: Clock }): ToolUses {
  const byPerson = new Map<string, Said>();
  const saidBy = (person: string): Said => {
    const said = byPerson.get(person) ?? { calls: new Map(), connections: new Map() };
    byPerson.set(person, said);
    return said;
  };
  return {
    expect(person, toolUse, word) {
      keep(saidBy(person).calls, toolUse, word, ports.clock.now().getTime(), false);
    },
    of(person, toolUse, connection) {
      const said = byPerson.get(person);
      if (said === undefined) return null;
      const at = ports.clock.now().getTime();
      const fresh = (told: Told | undefined) =>
        told !== undefined && at - told.at <= SESSION_IDLE_MS ? told : undefined;
      const unmet = () => [...said.calls.values()].find((told) => !told.met && fresh(told));
      const told = fresh(toolUse === null ? unmet() : said.calls.get(toolUse));
      if (told !== undefined) {
        told.met = true;
        if (connection !== null) keep(said.connections, connection, told.word, at, true);
        return told.word;
      }
      return (
        fresh(connection === null ? undefined : said.connections.get(connection))?.word ?? null
      );
    },
  };
}
