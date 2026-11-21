import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CATALOG } from "../packages/embed/src/catalog.ts";
import { check, covering, inRange, pins, type Advisory, type Env } from "./advisories.ts";

const advisory = (
  id: string,
  range: string,
  patched: string | null = null,
  withdrawn: string | null = null,
  name = "hono",
): Advisory => ({
  ghsa_id: id,
  withdrawn_at: withdrawn,
  vulnerabilities: [
    { package: { name }, vulnerable_version_range: range, patched_versions: patched },
  ],
});

describe("advisory ranges as GitHub writes them", () => {
  it.each([
    ["4.13.16", ">= 4.13.11, <= 4.13.17", true],
    ["4.13.17", ">= 4.13.11, <= 4.13.17", true],
    ["4.13.11", ">= 4.13.11, <= 4.13.17", true],
    ["4.13.18", ">= 4.13.11, <= 4.13.17", false],
    ["4.13.10", ">= 4.13.11, <= 4.13.17", false],
    ["4.13.17", "< 4.13.17", false],
    ["4.13.17", "> 4.13.17", false],
    ["4.13.18", "> 4.13.17", true],
    ["4.9.0", ">=1.3.0 <1.10.1", false],
    ["1.4.0", ">=1.3.0 <1.10.1", true],
    ["4.10.2", "< v4.10.2", false],
    ["4.12.17", "<  4.12.18", true],
    ["4.13.19", "", false],
  ])("%s in %j is %s", (version, range, expected) => {
    expect(inRange(version, range)).toBe(expected);
  });
});

describe("the advisories that cover a pin", () => {
  const list = [
    advisory("GHSA-74fm-fwc7-3fwp", ">= 4.13.11, <= 4.13.17", "4.13.18"),
    advisory("GHSA-92p4-j3wq-jmqx", ">= 4.5.1, <= 4.13.17", "4.13.18"),
    advisory("GHSA-old", "< 4.12.4", "4.12.4"),
    advisory("GHSA-open-ended", ">= 4.12.0", "4.12.2"),
    advisory("GHSA-withdrawn", "<= 4.13.17", null, "2026-11-12T00:00:00Z"),
  ];

  it("names the advisories that cover hono 4.13.16 and 4.13.17", () => {
    const ids = ["GHSA-74fm-fwc7-3fwp", "GHSA-92p4-j3wq-jmqx"];
    expect(covering("hono", "4.13.16", list)).toEqual(ids);
    expect(covering("hono", "4.13.17", list)).toEqual(ids);
  });

  it("names none for the fixed version, or for another package", () => {
    expect(covering("hono", "4.13.18", list)).toEqual([]);
    expect(covering("zod", "4.13.16", list)).toEqual([]);
  });

  it("reads an open-ended range as ending at its fix", () => {
    expect(covering("hono", "4.12.1", list)).toContain("GHSA-open-ended");
    expect(covering("hono", "4.12.2", list)).not.toContain("GHSA-open-ended");
  });

  it("counts a version fixed only by a patched version that closes its own range", () => {
    const two = [advisory("GHSA-two", ">= 2.0.0, < 2.1.6", "1.19.18, 2.1.6")];
    expect(covering("hono", "2.1.0", two)).toEqual(["GHSA-two"]);
    expect(covering("hono", "2.1.6", two)).toEqual([]);
    const open = [advisory("GHSA-open", ">= 2.0.0", "1.19.18, 2.1.6")];
    expect(covering("hono", "2.0.5", open)).toEqual(["GHSA-open"]);
    expect(covering("hono", "2.1.6", open)).toEqual([]);
    expect(covering("hono", "2.1.7", open)).toEqual([]);
  });
});

/** A tree with two packages, and a GitHub and npm registry the test controls. */
function tree(deps: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "advisories-"));
  mkdirSync(join(dir, "packages/a"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { tool: "1.0.0" } }));
  writeFileSync(
    join(dir, "packages/a/package.json"),
    JSON.stringify({
      dependencies: { ...deps, "@uketsugi/core": "workspace:*" },
      optionalDependencies: { opt: "2.0.0" },
    }),
  );
  return { root: pathToFileURL(dir + "/"), cachePath: join(dir, "cache/advisories.json") };
}

interface Stub {
  env: Env;
  calls: string[];
}
function stub(
  t: { cachePath: string },
  github: (url: string, headers: Headers) => Response | Promise<Response>,
  clock = { now: 1_000_000 },
): Stub & { clock: { now: number } } {
  const calls: string[] = [];
  const fetcher = (u: string, init?: RequestInit) => {
    calls.push(u);
    if (u.startsWith("https://registry.npmjs.org/")) {
      const repo = u.includes("nogit") ? undefined : { url: "git+https://github.com/o/hono.git" };
      return Promise.resolve(Response.json({ repository: repo }));
    }
    return Promise.resolve(github(u, new Headers(init?.headers)));
  };
  return {
    calls,
    clock,
    env: {
      fetch: fetcher as unknown as typeof fetch,
      now: () => clock.now,
      cachePath: t.cachePath,
    },
  };
}
const list = (range: string, patched: string) =>
  Response.json([advisory("GHSA-x", range, patched)], { headers: { etag: '"v1"' } });

describe("the pins of a tree", () => {
  it("reads exact versions of dependencies and optional dependencies only", () => {
    const t = tree({ hono: "4.13.16" });
    const got = pins(t.root);
    for (const r of CATALOG.runtime) expect(got.found.get(r.name)).toEqual(new Set([r.version]));
    expect(got.found.get("hono")).toEqual(new Set(["4.13.16"]));
    expect(got.found.get("opt")).toEqual(new Set(["2.0.0"]));
    expect(got.found.has("@uketsugi/core")).toBe(false);
  });

  it("lists a pin that is not x.y.z, and leaves out only a workspace link", () => {
    const t = tree({ hono: "4.13.16", loose: "^1.0.0" });
    expect(pins(t.root, [{ name: "rt", version: "1.0.0-rc.1", integrity: "" }]).unreadable).toEqual(
      ["loose@^1.0.0", "rt@1.0.0-rc.1"],
    );
  });
});

describe("the check", () => {
  const t = () => tree({ hono: "4.13.16" });

  it("fails naming the advisory that covers a pin, and passes once it is fixed", async () => {
    const a = t();
    const bad = await check(a.root, stub(a, () => list("<= 4.13.17", "4.13.18")).env, false);
    expect(bad.ok).toBe(false);
    expect(bad.lines.join("\n")).toContain("hono@4.13.16: GHSA-x");
    const b = t();
    const good = await check(b.root, stub(b, () => list("<= 4.13.15", "4.13.16")).env, false);
    expect(good.ok).toBe(true);
  });

  it("checks the runtime the catalog pins, and names it", async () => {
    const a = t();
    const [first] = CATALOG.runtime;
    if (!first) throw new Error("the catalog pins no runtime");
    const bad = await check(
      a.root,
      stub(a, () =>
        Response.json([advisory("GHSA-rt", `<= ${first.version}`, "99.0.0", null, first.name)]),
      ).env,
      false,
    );
    expect(bad.ok).toBe(false);
    expect(bad.lines.join("\n")).toContain(`${first.name}@${first.version}: GHSA-rt`);
    const b = t();
    const good = await check(b.root, stub(b, () => list("< 1.0.0", "1.0.0")).env, false);
    for (const r of CATALOG.runtime)
      expect(good.lines.join("\n")).toContain(`${r.name}@${r.version}`);
  });

  it("fails on a pin it cannot read, naming it", async () => {
    const a = tree({ hono: "4.13.16" });
    const r = await check(a.root, stub(a, () => list("< 1.0.0", "1.0.0")).env, false, [
      { name: "rt", version: "1.0.0-rc.1", integrity: "" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("rt@1.0.0-rc.1");
  });

  it("names a pin with no GitHub repository, without failing", async () => {
    const a = tree({ nogit: "1.0.0" });
    const r = await check(a.root, stub(a, () => list("< 0.0.1", "0.0.1")).env, false);
    expect(r.ok).toBe(true);
    expect(r.lines).toContain("advisories: not checked, no GitHub repository: nogit@1.0.0");
  });

  it("fails, naming why, when GitHub refuses", async () => {
    const a = t();
    const r = await check(a.root, stub(a, () => new Response("", { status: 403 })).env, false);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/could not run.*HTTP 403.*GITHUB_TOKEN/);
  });

  it("fails, naming why, when offline", async () => {
    const a = t();
    const s = stub(a, () => new Response());
    s.env.fetch = () => Promise.reject(new TypeError("fetch failed"));
    const r = await check(a.root, s.env, false);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/could not run.*offline/);
  });

  it("skips, and says so, when told it is offline", async () => {
    const a = t();
    const s = stub(a, () => new Response("", { status: 500 }));
    const r = await check(a.root, s.env, true);
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toContain("SKIPPED");
    expect(s.calls).toEqual([]);
  });

  it("sends the token when there is one", async () => {
    const a = t();
    let auth: string | null = null;
    const s = stub(a, (_u, h) => ((auth = h.get("authorization")), list("< 1.0.0", "1.0.0")));
    await check(a.root, { ...s.env, token: "tok" }, false);
    expect(auth).toBe("Bearer tok");
  });

  describe("the cache", () => {
    it("is not fetched again within the hour, and is saved when the check fails", async () => {
      const a = t();
      const s = stub(a, () => list("<= 4.13.17", "4.13.18"));
      expect((await check(a.root, s.env, false)).ok).toBe(false);
      expect(readFileSync(a.cachePath, "utf8")).toContain("GHSA-x");
      const before = s.calls.filter((c) => c.startsWith("https://api.github.com/")).length;
      s.clock.now += 59 * 60 * 1000;
      expect((await check(a.root, s.env, false)).ok).toBe(false);
      expect(s.calls.filter((c) => c.startsWith("https://api.github.com/")).length).toBe(before);
    });

    it("is revalidated by its ETag after the hour", async () => {
      const a = t();
      const s = stub(a, (_u, h) =>
        h.get("if-none-match") === '"v1"'
          ? new Response(null, { status: 304 })
          : list("<= 4.13.17", "4.13.18"),
      );
      await check(a.root, s.env, false);
      s.clock.now += 61 * 60 * 1000;
      const r = await check(a.root, s.env, false);
      expect(r.ok).toBe(false);
      expect(s.calls.filter((c) => c.startsWith("https://api.github.com/")).length).toBe(2);
    });

    it("does not trust an entry dated in the future", async () => {
      const a = t();
      mkdirSync(join(a.cachePath, ".."), { recursive: true });
      const url = "https://api.github.com/repos/o/hono/security-advisories?per_page=100&page=1";
      writeFileSync(
        a.cachePath,
        JSON.stringify({ [url]: { etag: '"v1"', body: [], at: 1_000_000 + 1e12 } }),
      );
      const r = await check(a.root, stub(a, () => list("<= 4.13.17", "4.13.18")).env, false);
      expect(r.ok).toBe(false);
    });
  });
});
