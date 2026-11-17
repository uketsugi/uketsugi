/**
 * What the Connect page is given, held byte for byte to what the server gave when every harness's
 * plugin was code: for plugins from a folder, from a server reached over HTTPS and from one
 * reached over plain HTTP, each where the harness is added with a token and where it is not.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { connectInfo, HARNESSES, type PluginsFrom } from "../src/connect.ts";

/** The six answers, as JSON, recorded when the characterization was written. */
const RECORDED = JSON.parse(
  readFileSync(new URL("./connect-info.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const CASES: Record<string, { origin: string; from: PluginsFrom }> = {
  folder: { origin: "http://127.0.0.1:7410", from: { folder: "/srv/the plugins" } },
  https: {
    origin: "https://memory.example.com",
    from: { url: "https://memory.example.com/plugins" },
  },
  http: { origin: "http://192.0.2.7:7410", from: { url: "http://192.0.2.7:7410/plugins" } },
};

/** Every case, by the key it is recorded under. */
function answers(): Record<string, string> {
  const all: Record<string, string> = {};
  for (const [name, { origin, from }] of Object.entries(CASES)) {
    for (const needsToken of [false, true]) {
      all[`${name}, ${needsToken ? "token" : "no token"}`] = JSON.stringify(
        connectInfo(origin, from, needsToken),
        null,
        2,
      );
    }
  }
  return all;
}

describe("what the Connect page is given", () => {
  test("is, for every harness, what it was before the harnesses were data", () => {
    const now = answers();
    expect(Object.keys(now)).toHaveLength(6);
    for (const [key, text] of Object.entries(now)) {
      expect(text, key).toBe(JSON.stringify(RECORDED[key], null, 2));
    }
  });
});

describe("the harnesses the server knows", () => {
  test("are data: every row survives being written out as JSON and read back", () => {
    expect(JSON.parse(JSON.stringify(HARNESSES))).toStrictEqual(HARNESSES);
  });
});
