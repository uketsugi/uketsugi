import { createServer } from "node:net";
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

export interface FakeIoOptions {
  interactive?: boolean;
  answer?: boolean;
  secret?: string;
  /**
   * The programs of the machine a verb runs on. Left out, there are none: no service manager and
   * no harness, so no test reaches the ones of whoever runs it.
   */
  run?: Io["run"];
}

export function fakeIo(options: FakeIoOptions = {}): FakeIo {
  const io: FakeIo = {
    interactive: options.interactive ?? false,
    outLines: [],
    errLines: [],
    questions: [],
    opened: [],
    run: options.run ?? (() => Promise.resolve(null)),
    out: (line) => void io.outLines.push(line),
    err: (line) => void io.errLines.push(line),
    confirm: (question) => {
      io.questions.push(question);
      return Promise.resolve(options.answer ?? false);
    },
    secret: (question) => {
      io.questions.push(question);
      return Promise.resolve(options.secret ?? null);
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

/** A port nothing listens on now: where a test that must find no server points a verb, in place of the default one, which the machine's own server may hold. */
export async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((listening) => probe.listen(0, "127.0.0.1", listening));
  const { port } = probe.address() as { port: number };
  await new Promise((closed) => probe.close(closed));
  return port;
}
