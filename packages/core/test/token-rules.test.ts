import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { generatedTokenRules } from "../scripts/generate-token-rules.ts";

test("the vendored token rules are what gitleaks' rule file generates now (run `pnpm generate` if not)", () => {
  const { path, document } = generatedTokenRules();
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(document);
});
