import { SESSION_IDLE_MS } from "@uketsugi/core";
import { FakeClock } from "@uketsugi/testkit";
import { expect, test } from "vitest";
import { createToolUses } from "../src/tool-uses.ts";

test("a call belongs to the conversation its person's hook named, for as long as a session may stay quiet", () => {
  const clock = new FakeClock(new Date("2026-11-14T09:00:00Z"));
  const uses = createToolUses({ clock });
  uses.expect("ann", "toolu_1", "conversation-1");
  uses.expect("ann", "toolu_2", "conversation-2");
  expect(uses.of("ann", "toolu_1")).toBe("conversation-1");
  expect(uses.of("ann", "toolu_2")).toBe("conversation-2");
  // A call is asked about more than once when its harness sends it again.
  expect(uses.of("ann", "toolu_1")).toBe("conversation-1");
  // Another person's hook said nothing of this call, and nobody's of that one.
  expect(uses.of("bob", "toolu_1")).toBeNull();
  expect(uses.of("ann", "toolu_3")).toBeNull();

  // The person is asked to allow the call and takes their time; past a session's quiet, it is forgotten.
  clock.advance(SESSION_IDLE_MS);
  expect(uses.of("ann", "toolu_1")).toBe("conversation-1");
  clock.advance(1);
  expect(uses.of("ann", "toolu_1")).toBeNull();
});

test("only so many are kept: the one told of longest ago goes first", () => {
  const clock = new FakeClock(new Date("2026-11-14T09:00:00Z"));
  const uses = createToolUses({ clock });
  for (let n = 0; n <= 1024; n += 1) uses.expect("ann", `toolu_${n}`, "conversation-1");
  expect(uses.of("ann", "toolu_0")).toBeNull();
  expect(uses.of("ann", "toolu_1")).toBe("conversation-1");
  expect(uses.of("ann", "toolu_1024")).toBe("conversation-1");
});
