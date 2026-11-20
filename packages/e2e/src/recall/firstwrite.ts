/**
 * A session's first write to its tree, as the tree itself says: after each batch of tool results the
 * tree's `git status --porcelain -uall` is compared with the status taken before the session, and
 * the first batch after which it differs holds the write. The write is put on the last call whose
 * result came in that batch (never earlier than it was made: seen one call late at worst, and a
 * search whose result came in the same batch is therefore after the write). Build outputs are in
 * `.git/info/exclude` and files the tree held beforehand are in the baseline, so neither is a write.
 * No command is parsed: a `sed -i`, a heredoc or an editor tool all show as a changed tree.
 */
import { run } from "./process.ts";

export interface FirstWrite {
  readonly call_line: number;
  readonly result_line: number;
  readonly tool: string;
}

export async function treeStatus(tree: string): Promise<Set<string>> {
  const done = await run("git", ["status", "--porcelain", "-uall"], { cwd: tree });
  return new Set(done.stdout.split("\n").filter((l) => l !== ""));
}

export class WriteWatch {
  write: FirstWrite | null = null;
  private line = 0;
  private readonly calls = new Map<string, { line: number; name: string }>();
  private results: { call: { line: number; name: string }; line: number }[] = [];

  private readonly tree: string;
  private readonly baseline: ReadonlySet<string>;

  constructor(tree: string, baseline: ReadonlySet<string>) {
    this.tree = tree;
    this.baseline = baseline;
  }

  /** One line of the transcript, counted as every reader of it counts: the lines that parse. */
  feed(raw: string): void {
    let event: { type?: string; message?: { content?: unknown } };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      return;
    }
    this.line += 1;
    const content = Array.isArray(event.message?.content)
      ? (event.message.content as {
          type?: string;
          id?: string;
          name?: string;
          tool_use_id?: string;
        }[])
      : [];
    if (event.type === "assistant") {
      for (const b of content) {
        if (b.type === "tool_use" && b.id !== undefined) {
          this.calls.set(b.id, { line: this.line, name: b.name ?? "" });
        }
      }
    } else if (event.type === "user" && this.write === null) {
      for (const b of content) {
        const call = b.type === "tool_result" ? this.calls.get(b.tool_use_id ?? "") : undefined;
        if (call !== undefined) this.results.push({ call, line: this.line });
      }
    }
  }

  /** After a batch of lines: whether the tree changed, and if it did, the write. */
  async settle(): Promise<void> {
    const last = this.results.at(-1);
    this.results = [];
    if (last === undefined || this.write !== null) return;
    const now = await treeStatus(this.tree);
    if ([...now].some((l) => !this.baseline.has(l))) {
      this.write = { call_line: last.call.line, result_line: last.line, tool: last.call.name };
    }
  }
}
