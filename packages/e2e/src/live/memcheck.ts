/**
 * Whether Claude Code's own memory, carried in a home, is read by a later session: the baseline of
 * the live test (both arms carry it) is not what the design says unless it is. A session in a box is
 * told something to keep in its own memory; a second session, in a copy of that home on another tree
 * at the same path inside the box (`/home/demo/work`), is asked something only that memory holds.
 * The two transcripts are kept. If the second session does not answer from it, the check fails.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterContext } from "../recall/adapter.ts";
import { Case } from "../recall/case.ts";
import { none } from "../recall/none.ts";
import type { Tools } from "../recall/preflight.ts";
import { run } from "../recall/process.ts";
import { spendOf } from "../recall/spend.ts";
import { copyEvidence } from "../recall/runner.ts";
import { memoryFilesOf } from "./pair.ts";

export const CODE_WORD = "quince-47";
const TELL = `Please keep this in your own memory for later sessions in this project: the staging deploy code word is ${CODE_WORD}. Just confirm that you have noted it.`;
const ASK =
  "What is the staging deploy code word for this project? Answer in one line, from what you already know about this project; do not search the disk.";

export interface MemCheck {
  readonly passed: boolean;
  /** The harness's memory files the first session wrote, and those found in the copy the second one started in. */
  readonly wrote: readonly string[];
  readonly carried: readonly string[];
  readonly answer: string;
  /** The second session looked into the memory folder with a tool, rather than being given it by the harness. */
  readonly readThroughATool: boolean;
  readonly tokens: number;
}

export interface MemSetup {
  readonly context: AdapterContext;
  readonly tools: Tools;
  /** Where the transcripts and `memcheck.json` are kept. */
  readonly out: string;
}

/** The final answer of a session: the text of its `result` event. */
async function answerOf(transcript: string): Promise<string> {
  for (const line of (await readFile(transcript, "utf8")).split("\n").reverse()) {
    try {
      const event = JSON.parse(line) as { type?: string; result?: unknown };
      if (event.type === "result") return typeof event.result === "string" ? event.result : "";
    } catch {
      // not an event
    }
  }
  return "";
}

export async function memcheck(setup: MemSetup): Promise<MemCheck> {
  const { context, tools } = setup;
  const id = randomUUID().slice(0, 8);
  const open = (name: string, dir?: string, carried = false): Promise<Case> =>
    Case.open({
      adapter: none,
      context: { ...context, harnessMemory: true },
      tools,
      config: "none",
      name,
      seeded: false,
      ...(dir === undefined ? {} : { dir, carried }),
    });
  const trees = [
    await context.workspace.make("memcheck", `tree-a-${id}`),
    await context.workspace.make("memcheck", `tree-b-${id}`),
  ];
  const first = await open(`memcheck-a-${id}`);
  const second = await (async (): Promise<Case> => {
    const dir = context.workspace.at("memcheck", `case-b-${id}`);
    await first.session({ name: "a", tree: trees[0] as string, prompt: TELL });
    await mkdir(dir, { recursive: true });
    await run("cp", ["-a", join(first.dir, "session-homes", "a"), join(dir, "home")]);
    return open(`memcheck-b-${id}`, dir, true);
  })();
  try {
    const wrote = await memoryFilesOf(join(first.dir, "session-homes", "a"));
    const carried = await memoryFilesOf(join(second.dir, "home"));
    const result = await second.session({ name: "b", tree: trees[1] as string, prompt: ASK });
    const answer = await answerOf(join(second.dir, "transcripts", "b.0.jsonl"));
    const touched = result.transcript.calls.some((c) =>
      /\.claude|memory/i.test(JSON.stringify(c.input)),
    );
    const check: MemCheck = {
      passed: answer.includes(CODE_WORD),
      wrote,
      carried,
      answer: answer.slice(0, 300),
      readThroughATool: touched,
      tokens:
        (await spendOf(first.dir).catch(() => ({ tokens: 0 }))).tokens +
        (await spendOf(second.dir).catch(() => ({ tokens: 0 }))).tokens,
    };
    for (const [name, c] of [
      ["a", first],
      ["b", second],
    ] as const)
      await copyEvidence(c.dir, join(setup.out, "cases", `memcheck-${name}`));
    await mkdir(join(setup.out, "memcheck"), { recursive: true });
    await writeFile(join(setup.out, "memcheck", "memcheck.json"), JSON.stringify(check, null, 1));
    return check;
  } finally {
    await first.close();
    await second.close();
  }
}
