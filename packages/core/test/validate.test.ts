import { PROJECT_REFUSAL } from "@uketsugi/contracts";
import { describe, expect, test } from "vitest";
import { ToolFailure, projectRequired } from "../src/failure.ts";
import { claimHashOf, contentHashOf } from "../src/hash.ts";
import { embedTextOf } from "../src/usecases/facts/write.ts";
import { validateInput, validateRequest } from "../src/validate.ts";

/** The failure a refused value raises, as the caller reads it. */
function refusalOf(attempt: () => unknown): string {
  try {
    attempt();
  } catch (error) {
    if (error instanceof ToolFailure) return error.toText();
    throw error;
  }
  throw new Error("the value was accepted");
}

describe("input contracts and failures", () => {
  test("one citation sent bare is accepted as a list of one", () => {
    const input = validateInput("publish_fact", {
      project: "github.com/a/b",
      claim: "c",
      citations: "a.ts:1",
    });
    expect(input.citations).toEqual(["a.ts:1"]);
  });

  test("a fault is named by its path and the tool's arguments, never by the value sent", () => {
    const attempt = () =>
      validateInput("update_fact", { project: "github.com/a/b", id: 7, flag: "wrongvalue" });
    expect(attempt).toThrow(ToolFailure);
    try {
      attempt();
    } catch (error) {
      const { error: parts } = (error as ToolFailure).toToolError();
      expect(parts).toMatchObject({ code: "invalid_input", retry: false });
      expect(parts.what).toContain("id must be string");
      expect(parts.next).toContain(
        "update_fact takes: project, id, claim, detail, citations, confirm, flag.",
      );
      expect(JSON.stringify(parts)).not.toContain("wrongvalue");
    }
  });

  test("a text over the limit its schema states is refused by its field and both lengths", () => {
    const call = { project: "github.com/a/b", claim: "c", citations: ["a.ts:1"] };
    const long = "word ".repeat(401);
    expect(refusalOf(() => validateInput("publish_fact", { ...call, claim: long }))).toContain(
      "claim is 2005 characters long; the most it may hold is 2000.",
    );
    const checked = { ...call, id: "x", confirm: { checked: long } };
    const refused = refusalOf(() => validateInput("update_fact", checked));
    expect(refused).toContain("confirm.checked is 2005 characters long");
    expect(refused).not.toContain("word word");
    expect(refusalOf(() => validateInput("publish_task", { ...call, title: long }))).toContain(
      "title is 2005 characters long; the most it may hold is 200.",
    );
    const many = Array.from({ length: 2000 }, (_, n) => `src/file-${n}.ts:1`);
    expect(refusalOf(() => validateInput("publish_fact", { ...call, citations: many }))).toMatch(
      /^citations is \d+ characters long; the most it may hold is 20000\./,
    );
    expect(refusalOf(() => validateRequest("FactListParams", "query", { q: long }))).toContain(
      "q is 2005 characters long; the most it may hold is 2000.",
    );
  });

  test("a default is the contract's, filled in by validation; a query's numbers arrive as text", () => {
    const call = { project: "github.com/a/b" };
    expect(validateInput("search_facts", { ...call, query: "q" }).limit).toBe(10);
    expect(validateInput("search_tasks", call).limit).toBe(20);
    expect(validateInput("search_tasks", { ...call, limit: 3 }).limit).toBe(3);
    expect(refusalOf(() => validateInput("search_facts", { ...call, limit: "3" }))).toContain(
      "limit must be integer",
    );
    expect(validateRequest("FactListParams", "query", {})).toEqual({ limit: 25 });
    expect(validateRequest("FactListParams", "query", { limit: "5" }).limit).toBe(5);
    expect(validateRequest("ActivityParams", "query", {}).days).toBe(7);
    for (const days of ["0", "91", "many"]) {
      expect(refusalOf(() => validateRequest("ActivityParams", "query", { days }))).toContain(
        "The request's query is not what this route takes: days must be",
      );
    }
    expect(validateRequest("SessionNoteRequest", "body", { text: "t", cwd: "/w" }).final).toBe(
      false,
    );
    expect(refusalOf(() => validateRequest("NewProjectRequest", "body", { slug: 5 }))).toContain(
      "The request's body is not what this route takes: slug must be string",
    );
  });

  test("a fact's vector is made from its question, its claim and its citations, one to a line", () => {
    const file = { kind: "file" as const, repo: "github.com/a/b", path: "src/retry.ts" };
    const citations = [
      { citation: { ...file, lines: "41-88" }, class: "checkable" as const },
      {
        citation: { kind: "document" as const, title: "Retry runbook" },
        class: "testimony" as const,
      },
    ];
    const claim = "Webhooks retry five times";
    expect(embedTextOf({ question: "How often do webhooks retry?", claim, citations })).toBe(
      "How often do webhooks retry?\nWebhooks retry five times\nsrc/retry.ts:41-88\nRetry runbook",
    );
    expect(embedTextOf({ question: null, claim, citations: [] })).toBe(claim);
  });

  test("the missing-project refusal is the fixed text and has all four parts", () => {
    const failure = projectRequired();
    expect(failure.toText()).toBe(PROJECT_REFUSAL);
    expect(`${failure.text.what} ${failure.text.next}`).toBe(PROJECT_REFUSAL);
    expect(failure.toToolError().error).toMatchObject({ code: "project_required", retry: false });
  });

  test("a claim hashes the same however it is spaced or cased; content hashes follow the text", async () => {
    expect(await claimHashOf("Webhooks  retry FIVE times")).toBe(
      await claimHashOf("webhooks retry five times"),
    );
    const base = { claim: "a", detail: null, question: null, citations: [] };
    expect(await contentHashOf(base)).not.toBe(await contentHashOf({ ...base, detail: "b" }));
    expect(await contentHashOf(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
