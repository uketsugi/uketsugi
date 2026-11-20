/**
 * Fails when a dependency pinned in any `package.json` is covered by a GitHub repository security
 * advisory. `pnpm audit` and OSV read only the advisories GitHub has reviewed into its database, and
 * a maintainer's published advisory can be weeks ahead of it (hono's of Nov 11, 2026 were). This
 * reads the maintainers' own lists, which GitHub serves without a token (60 requests an hour per
 * address; `GITHUB_TOKEN` in the environment lifts that). A check that could not run fails too,
 * naming why: a silent pass when GitHub refuses is how those advisories went unnoticed. Someone who
 * must work offline sets `UKT_ADVISORIES_OFFLINE=1`, and the check then says plainly that it skipped.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface Advisory {
  ghsa_id: string;
  withdrawn_at: string | null;
  vulnerabilities: {
    package: { name: string } | null;
    vulnerable_version_range: string | null;
    patched_versions: string | null;
  }[];
}

const bounds = (range: string): [string, number[]][] =>
  [...range.matchAll(/(<=|>=|<|>|=)\s*v?(\d+(?:\.\d+)*)/g)].map((m) => [
    m[1] ?? "",
    (m[2] ?? "").split(".").map(Number),
  ]);

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const HOLDS: Record<string, (c: number) => boolean> = {
  "<": (c) => c < 0,
  "<=": (c) => c <= 0,
  ">": (c) => c > 0,
  ">=": (c) => c >= 0,
  "=": (c) => c === 0,
};

/** Whether GitHub's range ("`>= 4.13.11, <= 4.13.17`", "`< v4.10.2`") holds for an exact version. */
export function inRange(version: string, range: string): boolean {
  const v = version.split(".").map(Number);
  const parts = bounds(range);
  return parts.length > 0 && parts.every(([op, b]) => HOLDS[op]?.(compare(v, b)) ?? false);
}

const parse = (v: string): number[] => v.split(".").map(Number);

/**
 * Whether a patched version closes the range it is in: it lies above the range's lower bounds
 * (a fix for another release line, such as 1.19.18 for ">= 2.0.0", does not) and `version` has
 * reached it. Maintainers write some ranges open-ended (">= 4.12.0", fixed in 4.12.2), which read
 * alone would cover every later release.
 */
function fixed(version: number[], range: string, patched: string | null): boolean {
  const lower = bounds(range).filter(([op]) => op.startsWith(">"));
  return bounds(
    (patched ?? "")
      .split(",")
      .map((p) => `>=${p}`)
      .join(" "),
  ).some(
    ([, p]) =>
      lower.every(([op, b]) => HOLDS[op]?.(compare(p, b)) ?? false) && compare(version, p) >= 0,
  );
}

/** The advisories, not withdrawn, that cover `name` at `version`. */
export function covering(name: string, version: string, list: Advisory[]): string[] {
  const v = parse(version);
  return list
    .filter((a) => !a.withdrawn_at)
    .filter((a) =>
      a.vulnerabilities.some((x) => {
        const range = x.vulnerable_version_range ?? "";
        return (
          x.package?.name === name &&
          inRange(version, range) &&
          !fixed(v, range, x.patched_versions)
        );
      }),
    )
    .map((a) => a.ghsa_id);
}

type Pins = Map<string, Set<string>>;

/** Every exact pin of what each package.json ships (its dependencies, not its tooling): name to versions. */
export function pins(root: URL): Pins {
  const found: Pins = new Map();
  const files = ["package.json", ...readdirPackages(root)];
  for (const file of files) {
    const json = JSON.parse(readFileSync(new URL(file, root), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const group of ["dependencies", "optionalDependencies"]) {
      for (const [name, version] of Object.entries(json[group] ?? {})) {
        if (/^\d+\.\d+\.\d+$/.test(version)) {
          found.set(name, (found.get(name) ?? new Set()).add(version));
        }
      }
    }
  }
  return found;
}

const readdirPackages = (root: URL): string[] =>
  readdirSync(new URL("packages/", root)).map((d) => `packages/${d}/package.json`);

/** An advisory list is days behind a fix, so a list fetched in the last hour is not fetched again. */
const FRESH_MS = 60 * 60 * 1000;
interface Entry {
  etag: string;
  body: unknown;
  at: number;
}

/** What the check reaches the outside through, so that a test can give it a stub. */
export interface Env {
  fetch: typeof fetch;
  now: () => number;
  /** The cache file, inside the tree's own ignored folder. */
  cachePath: string;
  token?: string | undefined;
}

class Refused extends Error {}

const refusal = (url: string, status: number): Refused =>
  new Refused(
    `${url} answered HTTP ${status}${status === 403 || status === 429 ? " (rate limit? set GITHUB_TOKEN)" : ""}`,
  );

const loadCache = (path: string, now: number): Record<string, Entry> => {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, Entry>;
    // An entry dated in the future would stay fresh for ever.
    return Object.fromEntries(
      Object.entries(raw).filter(
        ([, e]) => typeof e.etag === "string" && typeof e.at === "number" && e.at <= now,
      ),
    );
  } catch {
    return {};
  }
};

/** GET as JSON: from the cache when fresh, revalidated by ETag when not. */
function getter(env: Env, cache: Record<string, Entry>) {
  return async function getJson<T>(url: string): Promise<T> {
    const github = url.startsWith("https://api.github.com/");
    const hit = github ? cache[url] : undefined;
    if (hit && env.now() - hit.at < FRESH_MS) return hit.body as T;
    let res: Response;
    try {
      res = await env.fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "dependency-advisories",
          ...(github && env.token ? { authorization: `Bearer ${env.token}` } : {}),
          ...(hit ? { "if-none-match": hit.etag } : {}),
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new Refused(`could not reach ${url} (offline?): ${(error as Error).message}`);
    }
    if (res.status === 304 && hit) {
      hit.at = env.now();
      return hit.body as T;
    }
    // A repository that does not list its advisories has none to read.
    if (res.status === 404) return [] as T;
    if (!res.ok) throw refusal(url, res.status);
    const body = (await res.json()) as T;
    const etag = res.headers.get("etag");
    if (github && etag) cache[url] = { etag, body, at: env.now() };
    return body;
  };
}

type Get = <T>(url: string) => Promise<T>;

/** The GitHub repository a published version names, as "owner/name", or undefined. */
async function repoOf(get: Get, name: string, version: string): Promise<string | undefined> {
  const meta = await get<{ repository?: { url?: string } | string }>(
    `https://registry.npmjs.org/${name.replace("/", "%2F")}/${version}`,
  );
  const url = typeof meta.repository === "string" ? meta.repository : meta.repository?.url;
  return /github\.com[/:]([^/]+\/[^/.]+)/.exec(url ?? "")?.[1];
}

async function advisoriesOf(get: Get, repo: string): Promise<Advisory[]> {
  const all: Advisory[] = [];
  for (let page = 1; ; page++) {
    const got = await get<Advisory[]>(
      `https://api.github.com/repos/${repo}/security-advisories?per_page=100&page=${page}`,
    );
    all.push(...got);
    if (got.length < 100) return all;
  }
}

/** The covered pins as "name@version: GHSA-…" lines, and the pins with no GitHub repository to read. */
async function problems(
  get: Get,
  found: Pins,
): Promise<{ covered: string[]; unchecked: string[] }> {
  const lists = new Map<string, Promise<Advisory[]>>();
  const covered: string[] = [];
  const unchecked: string[] = [];
  await Promise.all(
    [...found].flatMap(([name, versions]) =>
      [...versions].map(async (version) => {
        const repo = await repoOf(get, name, version);
        if (!repo) return void unchecked.push(`${name}@${version}`);
        if (!lists.has(repo)) lists.set(repo, advisoriesOf(get, repo));
        const ids = covering(name, version, (await lists.get(repo)) ?? []);
        if (ids.length > 0) covered.push(`${name}@${version}: ${ids.join(", ")}`);
      }),
    ),
  );
  return { covered: covered.sort(), unchecked: unchecked.sort() };
}

/** The whole check on a tree: whether it passes, and what to print. */
export async function check(
  root: URL,
  env: Env,
  offline: boolean,
): Promise<{ ok: boolean; lines: string[] }> {
  if (offline) {
    return {
      ok: true,
      lines: ["advisories: SKIPPED, UKT_ADVISORIES_OFFLINE is set; nothing was checked"],
    };
  }
  const found = pins(root);
  const cache = loadCache(env.cachePath, env.now());
  try {
    const { covered, unchecked } = await problems(getter(env, cache), found);
    const lines = unchecked.map((p) => `advisories: not checked, no GitHub repository: ${p}`);
    if (covered.length > 0) {
      return {
        ok: false,
        lines: [
          ...lines,
          `advisories: pinned dependencies a GitHub advisory covers:`,
          ...covered.map((c) => `  ${c}`),
        ],
      };
    }
    return {
      ok: true,
      lines: [...lines, `advisories: none cover the ${found.size} pinned dependencies`],
    };
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    return {
      ok: false,
      lines: [
        `advisories: FAILED, the check could not run: ${error.message}`,
        "  (UKT_ADVISORIES_OFFLINE=1 skips it, and says so)",
      ],
    };
  } finally {
    mkdirSync(dirname(env.cachePath), { recursive: true });
    writeFileSync(env.cachePath, JSON.stringify(cache));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL("../", import.meta.url);
  const { ok, lines } = await check(
    root,
    {
      fetch,
      now: Date.now,
      cachePath: fileURLToPath(new URL("node_modules/.cache/advisories.json", root)),
      token: process.env["GITHUB_TOKEN"],
    },
    Boolean(process.env["UKT_ADVISORIES_OFFLINE"]),
  );
  (ok ? console.log : console.error)(lines.join("\n"));
  process.exitCode = ok ? 0 : 1;
}
