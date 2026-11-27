import { describe, expect, test } from "vitest";
import type { Caller, Project, ProjectRef } from "../src/domain.ts";
import { hookProject, isPersonal, parseProject, resolveProject } from "../src/project.ts";

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

/** What `parseProject` was before path projects: every input it accepted is held to its key. */
function parsedBefore(input: string): ProjectRef | null {
  const named = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
  const repository = /^[a-z0-9._-]+\.[a-z0-9._-]+(\/[a-z0-9._-]+){2}$/;
  const trimmed = input
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .trim();
  if (named.test(trimmed)) return { kind: "named", key: trimmed };
  const key = trimmed
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d+\/)/, "$1/")
    .replace(/^([^/:]+):\d+\//, "$1/")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  return repository.test(key) ? { kind: "repository", key } : null;
}

const KEPT = [
  "github.com/acme/api",
  "https://github.com/Acme/API.git",
  "git@github.com:acme/api.git",
  "ssh://git@github.com:22/acme/api/",
  "  `gitlab.example.org/team/svc`  ",
  "http://host.example:8080/a/b",
  "git://github.com/acme/api",
  "me/q4-expenses",
  "scratch/x",
  "https://user@github.com/acme/api",
  "github.com/acme/api.GIT",
  "ssh://git@host.example/a/b.git/",
];
const REFUSED = [
  "",
  "billing",
  "github.com/acme",
  "github.com/a/b/c",
  "/home/me/code/api",
  "file:///x",
  "file:///srv/git/api.git",
];

describe("what parseProject accepted before path projects", () => {
  test.each(KEPT)("%s has the key it had", (input) => {
    expect(parsedBefore(input)).not.toBeNull();
    expect(parseProject(input)).toEqual(parsedBefore(input));
  });

  test.each(REFUSED)("%s is still refused", (input) => {
    expect(parseProject(input)).toBeNull();
  });

  test("the one input that changes is a file URL whose host has a dot and whose path has two parts", () => {
    expect(parsedBefore("file://box.local/work/api")).toEqual({
      kind: "repository",
      key: "box.local/work/api",
    });
    expect(parseProject("file://box.local/work/api")).toEqual({
      kind: "path",
      key: "file://box.local/work/api",
    });
  });
});

describe("a path project", () => {
  test("is file://<machine>/<absolute path>, with the machine in lower case and the path as given", () => {
    expect(parseProject("file://Box/home/Ann/My Work//")).toEqual({
      kind: "path",
      key: "file://box/home/Ann/My Work",
    });
    expect(parseProject("`file://box/srv/x`")).toEqual({ kind: "path", key: "file://box/srv/x" });
  });

  test.each(["file://box", "file://box/", "file:///x", "file://my box/x", "box/home/ann"])(
    "%j names none",
    (input) => {
      expect(parseProject(input)?.kind).not.toBe("path");
    },
  );

  test("is its person's own and cannot be shared", () => {
    expect(isPersonal({ kind: "path", key: "file://box/x" })).toBe(true);
    expect(isPersonal({ kind: "repository", key: "github.com/a/b" })).toBe(false);
  });

  test.each([
    "/home/jé/proj",
    "/srv/データ",
    "/home/a b/c",
    "/tmp/%41",
    '/tmp/say "hi"',
    "/tmp/back\\slash",
    "/tmp/two\nlines",
  ])("the hook's machine and directory %j give the key of the agent's text", (directory) => {
    const text = `file://Box${directory}`;
    expect(parseProject(hookProject(undefined, "Box", directory))).toEqual(parseProject(text));
    expect(parseProject(text)?.kind).toBe("path");
  });
});

describe("the project a hook names", () => {
  test("is the origin when it names a project, else the folder", () => {
    const origin = "https://github.com/acme/api.git";
    expect(hookProject(origin, "box", "/x")).toBe(origin);
    expect(parseProject(hookProject("/srv/git/api.git", "box", "/x"))).toEqual({
      kind: "path",
      key: "file://box/x",
    });
    expect(parseProject(hookProject("", "box", "/x"))?.key).toBe("file://box/x");
  });

  test("is none with no machine or no directory", () => {
    expect(hookProject("", undefined, "/x")).toBeUndefined();
    expect(hookProject("", "box", undefined)).toBeUndefined();
    expect(hookProject(undefined, "box", "relative")).toBeUndefined();
  });
});

/** A store's projects held in a map: all `resolveProject` asks of it. */
function projectsOf() {
  const known = new Map<string, Project>();
  const choices = new Map<string, "private" | "shared">();
  const store = {
    projects: {
      ensure: (_org: string, ref: ProjectRef) => {
        const project = known.get(ref.key) ?? { orgId: "org", ...ref };
        known.set(ref.key, project);
        return Promise.resolve(project);
      },
      find: (_org: string, key: string) => Promise.resolve(known.get(key) ?? null),
      choice: (_org: string, who: string, key: string) =>
        Promise.resolve(choices.get(`${who}|${key}`) ?? null),
      choose: (_org: string, who: string, key: string, treatment: "private" | "shared") => {
        choices.set(`${who}|${key}`, treatment);
        return Promise.resolve();
      },
      listOf: () => Promise.resolve([]),
      nameFor: () => Promise.resolve(null),
    },
  };
  return { ports: { store, clock: { now: () => new Date(0) } } as never, choices };
}
const person = (id: string) => ({ orgId: "org", principalId: id }) as Caller;

describe("resolving a path project", () => {
  test("the first call makes it private and its caller's own; another person's call makes their own", async () => {
    const { ports, choices } = projectsOf();
    const ref: ProjectRef = { kind: "path", key: "file://box/x" };
    expect(await resolveProject(ports, person("ann"), ref)).toMatchObject(ref);
    expect(choices.get("ann|file://box/x")).toBe("private");
    expect(choices.has("bo|file://box/x")).toBe(false);
    await resolveProject(ports, person("bo"), ref);
    expect(choices.get("bo|file://box/x")).toBe("private");
  });
});
