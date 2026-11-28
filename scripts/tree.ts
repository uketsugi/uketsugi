/**
 * What the tracked tree must not hold, as faults a test lists (`tree.test.ts` runs it on the real
 * tree, so `pnpm check` fails on any, and on planted trees to show each rule fails):
 *
 * - a document other than the README, or built output. The README is the only document a
 *   repository carries, and a release is built into ignored folders and never committed. A file a
 *   harness reads as part of a plugin is code, not a document.
 * - a second statement of a fact that has one source: the version (`packages/cli/package.json`,
 *   which `ukt --version` and the release build read), a harness's line (`HARNESSES` in the
 *   server's `connect.ts`) and a limit (`LIMITS` in the contract, and the constants in core the
 *   README names). Prose cannot be derived, so the README may say a number only as the source does.
 */
import { MIN_DAILY_TOKENS, MOST_TURNS_KEPT } from "../packages/core/src/index.ts";
import { HARNESSES } from "../packages/server/src/connect.ts";
import { LIMITS, SERVER_NAME } from "../packages/contracts/src/index.ts";

export interface Tree {
  /** Tracked paths, relative to the repository's root. */
  readonly files: readonly string[];
  readonly read: (path: string) => Buffer;
}

export const VERSION_SOURCE = "packages/cli/package.json";
const GENERATED_FROM_VERSION = "packages/contracts/src/generated.ts";
const PLUGIN_FILES = "packages/server/plugins/";
const DOCUMENT = /\.(md|markdown|txt|rst|adoc|docx?|pdf|odt)$/i;
const BUILT =
  /(^|\/)dist\/|\.(tar|tgz|zip|gz|sha256|exe|dll|so|dylib|node|onnx|gguf|safetensors)$/i;
const EXECUTABLE_MAGIC = [
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  Buffer.from("MZ"),
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
];
const ORIGIN = "http://127.0.0.1:7410";
const MCP_URL = `${ORIGIN}/mcp`;

const isText = (bytes: Buffer): boolean => !bytes.includes(0);

function placement(tree: Tree): string[] {
  return tree.files.flatMap((path) => {
    const document = DOCUMENT.test(path) && path !== "README.md" && !path.startsWith(PLUGIN_FILES);
    if (document)
      return [
        `${path} is a document: only README.md is tracked, the rest lives beside the repository`,
      ];
    const head = tree.read(path).subarray(0, 4);
    if (
      BUILT.test(path) ||
      EXECUTABLE_MAGIC.some((magic) => head.subarray(0, magic.length).equals(magic))
    ) {
      return [
        `${path} is built output: a release is built into ignored folders and never committed`,
      ];
    }
    return [];
  });
}

/** The version appears where the cli's manifest says it, and nowhere else but a test's invented ones. */
function versionFaults(tree: Tree): string[] {
  if (!tree.files.includes(VERSION_SOURCE)) return [];
  const version = (JSON.parse(tree.read(VERSION_SOURCE).toString("utf8")) as { version: string })
    .version;
  const own = new RegExp(`(?<![\\d.])${version.replaceAll(".", "\\.")}(?![\\d]|\\.\\d)`);
  return tree.files.flatMap((path) => {
    if (
      path === VERSION_SOURCE ||
      // Derived from it by `pnpm generate`, which a contracts test holds current.
      path === GENERATED_FROM_VERSION ||
      path === "pnpm-lock.yaml" ||
      /(^|\/)test\/|\.test\.ts$/.test(path)
    )
      return [];
    const bytes = tree.read(path);
    if (!isText(bytes)) return [];
    return bytes
      .toString("utf8")
      .split("\n")
      .filter((line) => own.test(line))
      .map(
        (line) =>
          `${path} states the version (${version}), which ${VERSION_SOURCE} alone does: ${line.trim().slice(0, 80)}`,
      );
  });
}

function readme(tree: Tree): string {
  return tree.files.includes("README.md") ? tree.read("README.md").toString("utf8") : "";
}

/** Each harness's add line, wherever the README gives it, is the one `HARNESSES` renders. */
function harnessFaults(tree: Tree): string[] {
  const text = readme(tree);
  const render = (line: string) =>
    line.replaceAll("{name}", SERVER_NAME).replaceAll("{url}", MCP_URL);
  return HARNESSES.flatMap((harness) => {
    const whole = render(harness.add);
    // What starts the line before the first slot is the harness's own command; where there is
    // none (a file's entry), what comes before the address is.
    const command = harness.add.slice(0, harness.add.indexOf("{"));
    const prefix = command.length >= 8 ? command : whole.slice(0, whole.indexOf(MCP_URL));
    if (prefix === "") return [];
    const stated = [
      ...text.matchAll(new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")),
    ];
    return stated
      .filter((m) => !text.startsWith(whole, m.index))
      .map(
        () =>
          `README.md gives ${harness.name} a line that is not the one connect.ts renders: ${whole}`,
      );
  });
}

const grouped = (n: number): string => n.toLocaleString("en-US");

/** Each limit the README says, in the words it says it in, is the source's number. */
function limitFaults(tree: Tree): string[] {
  const text = readme(tree).replace(/\s+/g, " ");
  const stated: [string, RegExp, number[]][] = [
    ["a session's note", /keeps the first ([\d,]+) characters/, [LIMITS.closing_note_chars]],
    [
      "a captured turn",
      /cut to ([\d,]+) characters of request and ([\d,]+) of answer/,
      [LIMITS.turn_request_chars, LIMITS.turn_answer_chars],
    ],
    ["turns kept", /holds at most ([\d,]+) turns/, [MOST_TURNS_KEPT]],
    ["the smallest budget", /It takes no less than ([\d,]+),/, [MIN_DAILY_TOKENS]],
  ];
  return stated.flatMap(([what, words, numbers]) => {
    const found = words.exec(text);
    if (found === null)
      return [
        `README.md no longer says ${what} as the check reads it (${words}); change the check with it`,
      ];
    return numbers.flatMap((n, i) =>
      found[i + 1] === grouped(n)
        ? []
        : [`README.md says ${what} is ${found[i + 1]}; the source says ${grouped(n)}`],
    );
  });
}

export const treeFaults = (tree: Tree): string[] => [
  ...placement(tree),
  ...versionFaults(tree),
  ...harnessFaults(tree),
  ...limitFaults(tree),
];
