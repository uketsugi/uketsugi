/** The utilisation guard: no session starts once the seven-day window is near full. */
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Guard,
  MAX_READING_AGE_MS,
  lowerUnits,
  readingFromRun,
  readingOf,
} from "../../src/recall/quota.ts";

const NOW = 1_800_000_000;
const event = (utilization: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt: NOW + 86_400,
      utilization,
      isUsingOverage: false,
      ...extra,
    },
  });

describe("reading a transcript", () => {
  test("takes the newest event of a window that has not reset", () => {
    const text = [event(0.7), event(0.76), event(0.9, { resetsAt: NOW - 1 })].join("\n");
    expect(readingOf(text, NOW)).toEqual({ utilization: 0.76, ok: true });
  });

  test("says nothing when the transcript holds no event", () => {
    expect(readingOf('{"type":"result"}', NOW)).toBeUndefined();
  });

  test("an overage or a status that is not allowed is not ok", () => {
    expect(readingOf(event(0.5, { isUsingOverage: true }), NOW)?.ok).toBe(false);
    expect(readingOf(event(0.5, { status: "rejected" }), NOW)?.ok).toBe(false);
    expect(readingOf(event(0.5, { status: "allowed_warning" }), NOW)?.ok).toBe(true);
  });
});

describe("before the first session", () => {
  test("N is lowered so that the reading plus the projection stays under 0.90", () => {
    expect(lowerUnits(8, { utilization: 0.76, ok: true })).toBe(8);
    expect(lowerUnits(8, { utilization: 0.85, ok: true })).toBe(3);
    expect(lowerUnits(8, { utilization: 0.4, ok: true })).toBe(8);
  });

  test("N is 0 when the window is already at 0.90 or in overage", () => {
    expect(lowerUnits(8, { utilization: 0.9, ok: true })).toBe(0);
    expect(lowerUnits(8, { utilization: 0.5, ok: false })).toBe(0);
  });

  test("a run refuses to start without a reading", () => {
    expect(() => new Guard(undefined)).toThrow(/reading/);
  });
});

describe("during the run", () => {
  test("a session may start at 0.76 and not once a reading reaches 0.91", () => {
    const guard = new Guard({ utilization: 0.76, ok: true });
    expect(guard.mayStart()).toBe(true);
    guard.observe(event(0.8), NOW);
    expect(guard.mayStart()).toBe(true);
    guard.observe(event(0.91), NOW);
    expect(guard.mayStart()).toBe(false);
  });

  test("a reading of exactly 0.90 stops it, and so does overage", () => {
    const at = new Guard({ utilization: 0.5, ok: true });
    at.observe(event(0.9), NOW);
    expect(at.mayStart()).toBe(false);
    const over = new Guard({ utilization: 0.5, ok: true });
    over.observe(event(0.6, { isUsingOverage: true }), NOW);
    expect(over.mayStart()).toBe(false);
  });

  test("a transcript with no event leaves the guard as it was", () => {
    const guard = new Guard({ utilization: 0.76, ok: true });
    guard.observe('{"type":"result"}', NOW);
    expect(guard.mayStart()).toBe(true);
  });
});

describe("where the first reading comes from", () => {
  test("the newest event in the transcripts of the run before it; none when there is none", async () => {
    const root = mkdtempSync(join(tmpdir(), "recall-check-quota-"));
    try {
      const future = (u: number): string => event(u).replace(String(NOW + 86_400), "99999999999");
      mkdirSync(join(root, "cases", "u1-memory-E", "transcripts"), { recursive: true });
      mkdirSync(join(root, "cases", "u1-none-E", "transcripts"), { recursive: true });
      writeFileSync(join(root, "cases", "u1-memory-E", "transcripts", "E.0.jsonl"), future(0.78));
      await new Promise((resolve) => setTimeout(resolve, 20));
      writeFileSync(join(root, "cases", "u1-none-E", "transcripts", "E.0.jsonl"), future(0.81));
      expect(await readingFromRun(root)).toEqual({ utilization: 0.81, ok: true });
      expect(await readingFromRun(join(root, "nowhere"))).toBeUndefined();
      expect(await readingFromRun(root, Date.now() + MAX_READING_AGE_MS - 60_000)).toEqual({
        utilization: 0.81,
        ok: true,
      });
      expect(await readingFromRun(root, Date.now() + MAX_READING_AGE_MS + 60_000)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
