/**
 * What Claude Code's hooks are answered. Claude Code runs a hook at points of a session and hands
 * it what it knows as JSON; the plugin's one script (`plugins/claude-code/hooks/to-server.sh`)
 * sends that on as it came, and what is answered here is the hook's output, in Claude Code's own
 * shape. So everything the plugin does is decided on the server, and the script holds no rule.
 *
 * - `SessionStart`: the conversation's session begins in the project the script names, and the
 *   answer is what the session starts from: the block, then its brief. Claude Code puts that in
 *   front of the agent before the first prompt, and again after a compaction or a resume.
 * - `PreToolUse`, before each call of one of the server's tools: which conversation the call
 *   belongs to, by the call's own id (`tool-uses.ts`).
 * - `Stop`, as each turn ends: the agent's last message, as the session's note.
 * - `SessionEnd`: that note is the session's last word.
 *
 * The project is this session's own word on where it is: the origin remote of the directory it
 * started in, which the script reads and sends in a header, since it cannot write into JSON.
 */
import type { ClaudeCodeHook, ClaudeCodeHookOutput } from "@uketsugi/contracts";
import { BLOCK_TEXT } from "@uketsugi/contracts";
import type { App, Caller } from "@uketsugi/core";
import { CLAUDE_CODE } from "./connect.ts";
import type { ToolUses } from "./tool-uses.ts";

/** The header the script names the session's project in: the directory's origin remote. */
export const ORIGIN_HEADER = "x-uketsugi-origin";

export interface HookDeps {
  readonly app: App;
  readonly toolUses: ToolUses;
  /** Told of an error no caller could act on. */
  readonly onError: (error: unknown) => void;
}

/** Answers one hook of Claude Code's, for the person its token belongs to. */
export async function answerClaudeCode(
  { app, toolUses, onError }: HookDeps,
  caller: Caller,
  hook: ClaudeCodeHook,
  origin: string | undefined,
): Promise<ClaudeCodeHookOutput> {
  const conversation = { client: CLAUDE_CODE, id: hook.session_id, project: origin };
  switch (hook.hook_event_name) {
    case "SessionStart": {
      const client = { name: CLAUDE_CODE, version: null, conversationId: hook.session_id };
      // The block is what has the agent use memory at all: a brief that cannot be made is
      // reported and left out, and the session starts with the block alone.
      const brief = await app.beginSession(caller, client, origin).catch((error: unknown) => {
        onError(error);
        return null;
      });
      const context = brief === null ? BLOCK_TEXT : `${BLOCK_TEXT}\n${brief}`;
      return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } };
    }
    case "PreToolUse":
      if (hook.tool_use_id !== undefined) {
        const word = { client: CLAUDE_CODE, conversation: hook.session_id };
        toolUses.expect(caller.principalId, hook.tool_use_id, word);
      }
      return {};
    case "Stop":
      if (hook.last_assistant_message !== undefined) {
        await app.noteSession(caller, conversation, hook.last_assistant_message);
      }
      return {};
    case "SessionEnd":
      await app.endSession(caller, conversation);
      return {};
    default:
      return {};
  }
}
