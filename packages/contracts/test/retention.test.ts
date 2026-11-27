/** The README says what the dashboard says: every retention line is in it, word for word. */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { LOCAL_BACKUPS, RETENTION } from "../src/index.ts";

const README = readFileSync(new URL("../../../README.md", import.meta.url), "utf8").replace(
  /\s+/g,
  " ",
);

describe("the retention", () => {
  test.each(RETENTION.map((row) => [row.what, row.kept]))("the README states: %s", (what, kept) => {
    expect(README).toContain(`**${what}.** ${kept}`);
  });

  test("the README states what the open edition says of backups", () => {
    expect(README).toContain(LOCAL_BACKUPS);
  });
});
