/**
 * Which conversation a tool call belongs to, where the harness's own hook says so. Claude Code
 * sends no conversation id on a call, but it gives each call an id, and the hook it runs before
 * the call is handed that id beside the conversation's. The plugin's hook sends the pair here
 * ahead of the call, so the call goes on its own conversation's session and nothing is inferred.
 *
 * A pair is kept for as long as a session may stay quiet: the person may be asked to allow the
 * call, and takes their time. One whose call never comes, because they said no, is dropped then.
 */
import { SESSION_IDLE_MS, type Clock } from "@uketsugi/core";

/** The most pairs kept; the one told of longest ago is dropped first. */
const MOST = 1024;

export interface ToolUses {
  /** A hook's word: the person's call with this id belongs to this conversation. */
  expect(person: string, toolUse: string, conversation: string): void;
  /** The conversation of the person's call with this id; null where no hook spoke of it. */
  of(person: string, toolUse: string): string | null;
}

/** The pairs of one server process. */
export function createToolUses(ports: { clock: Clock }): ToolUses {
  /** By person and call id, the one told of last at the end. */
  const told = new Map<string, { conversation: string; at: number }>();
  const keyOf = (person: string, toolUse: string) => JSON.stringify([person, toolUse]);
  return {
    expect(person, toolUse, conversation) {
      const at = ports.clock.now().getTime();
      for (const [key, pair] of told) {
        if (at - pair.at <= SESSION_IDLE_MS && told.size < MOST) break;
        told.delete(key);
      }
      const key = keyOf(person, toolUse);
      told.delete(key);
      told.set(key, { conversation, at });
    },
    of(person, toolUse) {
      const pair = told.get(keyOf(person, toolUse));
      const fresh = pair !== undefined && ports.clock.now().getTime() - pair.at <= SESSION_IDLE_MS;
      return fresh ? pair.conversation : null;
    },
  };
}
