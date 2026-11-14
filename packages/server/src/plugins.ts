/**
 * The plugins this server ships, one folder for each harness that has one (`plugins/` beside this
 * package's code), and how a person gets them. On the server's own machine a harness installs
 * from the folder. From any other machine they are fetched from here: each plugin as a zip, and
 * for Claude Code the folder's marketplace file with the zip in place of the folder, which is
 * how it installs from an address. So the plugin a person has is the one of the server they use.
 *
 * Nothing in a plugin is secret, and a harness fetches one before its person has given it a
 * token, so these routes ask for none.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { zipSync, type Zippable } from "fflate";
import { Hono, type Context } from "hono";
import type { PluginsFrom } from "./connect.ts";
import { noRoute, failed } from "./errors.ts";
import { reachedAt, reachedLocally } from "./guard.ts";

/** Where the routes are mounted. */
export const PLUGINS_PATH = "/plugins";

/** Where Claude Code looks for a marketplace's file, in its folder. */
const MARKETPLACE_FILE = ".claude-plugin/marketplace.json";

/** The date every file in a zip carries, so that the same files always make the same zip. */
const ZIP_DATE = new Date("2026-01-01T00:00:00Z");

/** The folder of plugins as it stands on this machine, its links followed; null where there is none. */
export function pluginsFolder(dir: string | undefined): string | null {
  return dir !== undefined && existsSync(join(dir, MARKETPLACE_FILE)) ? realpathSync(dir) : null;
}

/** Where the person at the other end of a request gets the plugins from. */
export function pluginsFrom(c: Context, folder: string | null): PluginsFrom | null {
  if (folder === null) return null;
  return reachedLocally(c) ? { folder } : { url: `${reachedAt(c)}${PLUGINS_PATH}` };
}

/** Every file under a folder, by its path from there. */
function filesOf(folder: string, under = ""): Zippable {
  const files: Zippable = {};
  const entries = readdirSync(join(folder, under), { withFileTypes: true });
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name, "en"))) {
    const path = under === "" ? entry.name : `${under}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(files, filesOf(folder, path));
    else if (entry.isFile()) files[path] = readFileSync(join(folder, path));
  }
  return files;
}

/**
 * One plugin's folder as a zip, its files at the top. The same files always make the same bytes:
 * Claude Code tells one version of the plugin from another by the zip's digest.
 */
function zipOf(folder: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(zipSync(filesOf(folder), { level: 9, mtime: ZIP_DATE }));
}

/** A marketplace's file as far as this reads it: each plugin by its folder. */
interface Marketplace {
  readonly plugins: readonly { readonly source: string }[];
}

/** The plugin routes over a folder of plugins. Each zip is made when it is first asked for. */
export function pluginRoutes(folder: string): Hono {
  const routes = new Hono();
  const zips = new Map<string, Uint8Array<ArrayBuffer>>();
  const names = readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
  const zipNamed = (name: string): Uint8Array<ArrayBuffer> => {
    const made = zips.get(name) ?? zipOf(join(folder, name));
    zips.set(name, made);
    return made;
  };

  routes.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-cache");
  });
  // The folder's own file names each plugin by its folder; from an address each is its zip. The
  // zip's digest is left out: Claude Code keeps this file for a while, and a digest in a kept
  // copy would refuse the plugin of a server upgraded since.
  routes.get("/marketplace.json", (c) => {
    const listed = JSON.parse(readFileSync(join(folder, MARKETPLACE_FILE), "utf8")) as Marketplace;
    const plugins = listed.plugins.map((plugin) => {
      const name = plugin.source.replace(/^\.\//, "");
      const url = `${reachedAt(c)}${PLUGINS_PATH}/${name}.zip`;
      return { ...plugin, source: { source: "archive", url } };
    });
    return c.json({ ...listed, plugins });
  });
  routes.get("/:file{[a-z-]+\\.zip}", (c) => {
    const name = c.req.param("file").replace(/\.zip$/, "");
    if (!names.includes(name)) return failed(c, noRoute(c.req.method, c.req.path));
    return c.body(zipNamed(name), 200, { "Content-Type": "application/zip" });
  });
  routes.all("*", (c) => failed(c, noRoute(c.req.method, c.req.path)));
  return routes;
}
