import { describe, expect, test } from "vitest";
import { parseProject } from "../src/project.ts";

describe("parseProject", () => {
  test.each([
    ["github.com/acme/api", "github.com/acme/api"],
    ["https://github.com/Acme/API.git", "github.com/acme/api"],
    ["git@github.com:acme/api.git", "github.com/acme/api"],
    ["ssh://git@github.com:22/acme/api/", "github.com/acme/api"],
    ["  `gitlab.example.org/team/svc`  ", "gitlab.example.org/team/svc"],
  ])("reads %s as the repository %s", (input, key) => {
    expect(parseProject(input)).toEqual({ kind: "repository", key });
  });

  test("two spellings of one origin name one project", () => {
    expect(parseProject("git@github.com:acme/api.git")).toEqual(
      parseProject("https://github.com/acme/api"),
    );
  });

  test("reads owner/slug as a named project", () => {
    expect(parseProject("me/q4-expenses")).toEqual({ kind: "named", key: "me/q4-expenses" });
  });

  test.each([
    undefined,
    null,
    42,
    "",
    "billing",
    "github.com/acme",
    "github.com/a/b/c",
    "/home/me/code/api",
  ])("refuses %j", (input) => {
    expect(parseProject(input)).toBeNull();
  });
});
