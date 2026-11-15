import { SESSION_IDLE_MS } from "@uketsugi/core";
import { FakeClock } from "@uketsugi/testkit";
import { expect, test } from "vitest";
import { createToolUses } from "../src/tool-uses.ts";

const START = new Date("2026-11-14T09:00:00Z");
const word = (conversation: string) => ({ client: "claude-code", conversation });

test("a call belongs to the conversation its person's hook named, for as long as a session may stay quiet", () => {
  const clock = new FakeClock(START);
  const uses = createToolUses({ clock });
  uses.expect("ann", "toolu_1", word("conversation-1"));
  uses.expect("ann", "toolu_2", word("conversation-2"));
  expect(uses.of("ann", "toolu_1", null)).toEqual(word("conversation-1"));
  expect(uses.of("ann", "toolu_2", null)).toEqual(word("conversation-2"));
  // A call is asked about more than once when its harness sends it again.
  expect(uses.of("ann", "toolu_1", null)).toEqual(word("conversation-1"));
  // Another person's hook said nothing of this call, and nobody's of that one.
  expect(uses.of("bob", "toolu_1", null)).toBeNull();
  expect(uses.of("ann", "toolu_3", null)).toBeNull();

  // The person is asked to allow the call and takes their time; past a session's quiet, it is forgotten.
  clock.advance(SESSION_IDLE_MS);
  expect(uses.of("ann", "toolu_1", null)).toEqual(word("conversation-1"));
  clock.advance(1);
  expect(uses.of("ann", "toolu_1", null)).toBeNull();
});

test("a call that carries no id answers to its person's oldest word that no call has answered to", () => {
  const uses = createToolUses({ clock: new FakeClock(START) });
  expect(uses.of("ann", null, null)).toBeNull();
  uses.expect("ann", "toolu_1", word("conversation-1"));
  uses.expect("ann", "toolu_2", word("conversation-2"));
  uses.expect("bob", "toolu_9", word("conversation-9"));
  expect(uses.of("ann", null, null)).toEqual(word("conversation-1"));
  expect(uses.of("ann", null, null)).toEqual(word("conversation-2"));
  // Every word of hers has had its call: one more call is nobody's, and Bob's word is Bob's.
  expect(uses.of("ann", null, null)).toBeNull();
  expect(uses.of("bob", null, null)).toEqual(word("conversation-9"));
});

test("a connection keeps the conversation of its last placed call, for a call whose word never arrived", () => {
  const clock = new FakeClock(START);
  const uses = createToolUses({ clock });
  // The first call's word is lost: the connection has no conversation yet.
  expect(uses.of("ann", "toolu_0", "connection-a")).toBeNull();
  uses.expect("ann", "toolu_1", word("conversation-1"));
  expect(uses.of("ann", "toolu_1", "connection-a")).toEqual(word("conversation-1"));
  expect(uses.of("ann", "toolu_2", "connection-a")).toEqual(word("conversation-1"));
  expect(uses.of("ann", "toolu_2", "connection-b")).toBeNull();
  expect(uses.of("bob", "toolu_2", "connection-a")).toBeNull();
  clock.advance(SESSION_IDLE_MS + 1);
  expect(uses.of("ann", "toolu_3", "connection-a")).toBeNull();
});

test("each person has a pool of their own: one person's words push out none of another's", () => {
  const uses = createToolUses({ clock: new FakeClock(START) });
  uses.expect("ann", "toolu_ann", word("conversation-ann"));
  for (let n = 0; n < 5000; n += 1) uses.expect("bob", `toolu_${n}`, word("conversation-bob"));
  expect(uses.of("ann", "toolu_ann", null)).toEqual(word("conversation-ann"));
  // Of his own, only the latest are kept.
  expect(uses.of("bob", "toolu_0", null)).toBeNull();
  expect(uses.of("bob", "toolu_4999", null)).toEqual(word("conversation-bob"));
  expect(uses.of("bob", "toolu_4936", null)).toEqual(word("conversation-bob"));
  expect(uses.of("bob", "toolu_4935", null)).toBeNull();
});
