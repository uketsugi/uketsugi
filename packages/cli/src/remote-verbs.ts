/** The verbs that ask the running server: `ui` (a sign-in link to the dashboard) and `export`. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { resolveHome } from "./home.ts";
import type { Program } from "./program.ts";
import { CliFailure, size, type Io, type Report } from "./report.ts";
import { connect, connectAsHost, exportMarkdown, projects, signInCode } from "./server-client.ts";

export interface UiOptions {
  readonly dataDir?: string;
  /** False with `--no-open`: the link is printed and no browser is started. */
  readonly open: boolean;
  readonly json?: boolean;
}

/** `ukt ui`: asks the server for a one-time code and opens, or prints, the link that signs a browser in. */
export async function ui(io: Io, options: UiOptions, env: NodeJS.ProcessEnv): Promise<Report> {
  const server = await connectAsHost(resolveHome(options.dataDir, env));
  const link = await signInCode(server);
  const until = new Date(link.expires_at).toLocaleTimeString();
  const wanted = options.open && options.json !== true && io.interactive;
  const opened = wanted && (await io.open(link.url));
  return {
    data: { url: link.url, expires_at: link.expires_at, opened },
    lines: opened
      ? ["Opened the dashboard in your browser.", `If nothing opened, open this link: ${link.url}`]
      : [link.url, `Open this link in a browser on this machine. It works once, until ${until}.`],
  };
}

export interface ExportOptions {
  readonly dataDir?: string;
  /** The folder the Markdown files go in. */
  readonly markdown: string;
  readonly json?: boolean;
}

/** The file a project's document goes in: its key as a path under the folder, never outside it. */
function fileOf(folder: string, key: string): string {
  const file = resolve(folder, `${key}.md`);
  if (file.startsWith(folder + sep) && !key.split("/").includes("..")) return file;
  throw new CliFailure({
    what: `The project key "${key}" does not name a file inside ${folder}.`,
    meaning: "The export stopped rather than write outside the folder.",
    next: "Report this project key; export the other projects from the dashboard meanwhile.",
  });
}

/** `ukt export --markdown <folder>`: one Markdown document per project, as the server writes it. */
export async function exportFacts(options: ExportOptions, env: NodeJS.ProcessEnv): Promise<Report> {
  const server = await connect(resolveHome(options.dataDir, env));
  const folder = resolve(options.markdown);
  const files: { project: string; file: string; bytes: number }[] = [];
  for (const project of (await projects(server)).projects) {
    const file = fileOf(folder, project.key);
    const document = await exportMarkdown(server, project.key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, document);
    files.push({ project: project.key, file, bytes: Buffer.byteLength(document) });
  }
  return {
    data: { folder, files },
    lines:
      files.length === 0
        ? ["Nothing to export: the store holds no project yet."]
        : [
            ...files.map(({ file, bytes }) => `${file} (${size(bytes)})`),
            `Exported ${files.length} project${files.length === 1 ? "" : "s"} to ${folder}.`,
          ],
  };
}

/** Adds `ui` and `export` to the program. */
export function remoteVerbs({ io, env, verb, run }: Program): void {
  verb("ui", "open the dashboard, signed in")
    .option("--no-open", "print the sign-in link instead of opening a browser")
    .action((options: UiOptions) => run("ui", options, () => ui(io, options, env)));
  verb("export", "write every project's facts as Markdown")
    .requiredOption("--markdown <folder>", "the folder the Markdown files go in")
    .action((options: ExportOptions) => run("export", options, () => exportFacts(options, env)));
}
