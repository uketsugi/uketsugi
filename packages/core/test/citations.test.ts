import { describe, expect, test } from "vitest";
import {
  citationText,
  citedFacts,
  classify,
  mapCitationText,
  parseCitation,
  parseCitations,
} from "../src/facts/citations.ts";
import type { ProjectRef } from "../src/domain.ts";
import { ToolFailure } from "../src/failure.ts";

const repository = { kind: "repository" as const, key: "github.com/acme/api" };
const named = { kind: "named" as const, key: "me/notes" };
const never = () => false;
const classOf = (raw: unknown, project: ProjectRef = repository) =>
  classify(parseCitation(raw, project, 0), never);

describe("citations", () => {
  test("a path with lines and a commit is a file in the call's repository", () => {
    const citation = parseCitation("src/retry.ts:41-88@A41D07C", repository, 0);
    expect(citation).toEqual({
      kind: "file",
      repo: repository.key,
      path: "src/retry.ts",
      lines: "41-88",
      commit: "a41d07c",
    });
    expect(citationText(citation)).toBe("src/retry.ts:41-88@a41d07c");
    expect(classify(citation, never).class).toBe("checkable");
  });

  test.each([
    ["docs/vendors.md#L47-L53", { path: "docs/vendors.md", lines: "47-53" }],
    ["reports/ops_summary_2025-01.md#L11", { path: "reports/ops_summary_2025-01.md", lines: "11" }],
    ["packages/@acme/core/src/app.ts:7", { path: "packages/@acme/core/src/app.ts", lines: "7" }],
    ["data/movements_2025-03.csv", { path: "data/movements_2025-03.csv" }],
    [
      { kind: "file", path: "src/app.ts", lines: "L3-L9" },
      { path: "src/app.ts", lines: "3-9" },
    ],
    [
      { path: "src/app.ts", commit: "A41D07C" },
      { path: "src/app.ts", commit: "a41d07c" },
    ],
  ])("%j names a file and its lines", (raw, expected) => {
    expect(parseCitation(raw, repository, 0)).toEqual({
      kind: "file",
      repo: repository.key,
      ...expected,
    });
  });

  test("a commit and a URL are checkable; a URL's host is its lookup key", () => {
    const commit = { kind: "commit", repo: repository.key, commit: "a41d07c9" };
    expect(parseCitation("a41d07c9", repository, 0)).toEqual(commit);
    expect(parseCitation("commit A41D07C9", repository, 0)).toEqual(commit);
    const web = parseCitation("https://Docs.Example.com/retries#policy", repository, 0);
    expect(classify(web, never).class).toBe("checkable");
    expect(parseCitation({ kind: "issue", number: "12" }, repository, 0)).toMatchObject({
      kind: "issue",
      number: 12,
    });
  });

  test("a list sent as one string is read as the citations it holds", () => {
    const paths = (raw: unknown[]) =>
      parseCitations(raw, repository).map((citation) => citationText(citation));
    expect(paths(['["orderbook/cents.py:4", "orderbook/fees.py:6-13"]'])).toEqual([
      "orderbook/cents.py:4",
      "orderbook/fees.py:6-13",
    ]);
    expect(paths(["docs/data-model.md:19-22, docs/vendors.md#L47-L53; a41d07c"])).toEqual([
      "docs/data-model.md:19-22",
      "docs/vendors.md:47-53",
      "commit a41d07c",
    ]);
    expect(paths(["src/a.ts:1", "src/a.ts:1"])).toEqual(["src/a.ts:1"]);
    expect(paths(["ran the suite, then read config.ts"])).toEqual([
      "ran the suite, then read config.ts",
    ]);
    expect(() => parseCitations(["[]"], repository)).toThrow(ToolFailure);
  });

  test("what cannot be opened by the audience is testimony, with the reason", () => {
    expect(classOf("ran the test suite twice")).toMatchObject({
      class: "testimony",
      reason: "a local observation",
    });
    expect(classOf("src/retry.ts:41", named).class).toBe("testimony");
    expect(classOf({ kind: "document", title: "Travel policy" })).toMatchObject({
      class: "testimony",
      reason: "needs sign-in",
    });
    expect(classOf({ kind: "memo", text: "from the offsite" }).class).toBe("testimony");
    expect(classOf({ kind: "person", who: "the on-call engineer" }).reason).toBe(
      "a person said so",
    );
  });

  test.each([
    ["/home/sam/api/src/retry.ts:41", "a path on one machine, not in the repository"],
    [{ kind: "file", path: "../other/retry.ts" }, "a path on one machine, not in the repository"],
    ["http://localhost:3000/docs", "not a public address"],
    ["https://10.0.0.7/wiki/retries", "not a public address"],
    ["https://wiki.internal/retries", "not a public address"],
  ])("%j is not something an audience can open", (raw, reason) => {
    expect(classOf(raw)).toMatchObject({ class: "testimony", reason });
  });

  test("a cited fact passes its own class on", () => {
    const fact = parseCitation("0198C1A0-0000-7000-8000-000000000001", repository, 0);
    expect(fact).toEqual({ kind: "fact", fact: "0198c1a0-0000-7000-8000-000000000001" });
    expect(classify(fact, () => true).class).toBe("checkable");
    expect(classify(fact, never)).toMatchObject({
      class: "testimony",
      reason: "the cited fact rests on testimony",
    });
    expect(citedFacts([fact])).toEqual(fact.kind === "fact" ? [fact.fact] : []);
  });

  test("a citation missing its required part is refused by name, without echoing a value", () => {
    const failure = (() => {
      try {
        return parseCitation({ kind: "web", quote: "secret words" }, repository, 2);
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(ToolFailure);
    expect((failure as ToolFailure).toText()).toContain("citations[2]");
    expect((failure as ToolFailure).toText()).not.toContain("secret words");
    expect(() => parseCitation({ kind: "issue", number: "twelve" }, repository, 0)).toThrow(
      ToolFailure,
    );
    expect(() => parseCitation(7, repository, 0)).toThrow(ToolFailure);
  });

  test("a rewrite reaches a citation's texts and says which are references", () => {
    const web = parseCitation({ kind: "web", url: "https://a.example/x", quote: "q" }, named, 0);
    const seen: [string, boolean][] = [];
    const upper = mapCitationText(web, (field, value, isReference) => {
      seen.push([field, isReference]);
      return value.toUpperCase();
    });
    expect(upper).toEqual({ kind: "web", url: "HTTPS://A.EXAMPLE/X", quote: "Q" });
    expect(seen).toEqual([
      ["url", true],
      ["quote", false],
    ]);
    const file = parseCitation("src/a.ts:3@a41d07c", repository, 0);
    expect(mapCitationText(file, () => "x")).toMatchObject({ lines: "3", commit: "a41d07c" });
  });
});
