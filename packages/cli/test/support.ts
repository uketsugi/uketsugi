import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { Io } from "../src/report.ts";

/** An `Io` that records what a verb printed and answers its questions from a script. */
export interface FakeIo extends Io {
  readonly outLines: string[];
  readonly errLines: string[];
  readonly questions: string[];
  readonly opened: string[];
}

export function fakeIo(options: { interactive?: boolean; answer?: boolean } = {}): FakeIo {
  const io: FakeIo = {
    interactive: options.interactive ?? false,
    outLines: [],
    errLines: [],
    questions: [],
    opened: [],
    out: (line) => void io.outLines.push(line),
    err: (line) => void io.errLines.push(line),
    confirm: (question) => {
      io.questions.push(question);
      return Promise.resolve(options.answer ?? false);
    },
    progress: () => ({ update: () => undefined, stop: () => undefined }),
    open: (url) => {
      io.opened.push(url);
      return Promise.resolve(true);
    },
  };
  return io;
}

const made: string[] = [];

/** A new temporary directory, removed after the test. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ukt-cli-"));
  made.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
