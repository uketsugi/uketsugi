#!/usr/bin/env node
/**
 * `ukt`: the command line of the server on this machine. This file connects a terminal to the
 * program; each verb, with its options and its work, is in the file beside it.
 */
import { readFileSync } from "node:fs";
import { confirm, spinner } from "@clack/prompts";
import { Command, CommanderError, Option } from "commander";
import open from "open";
import { doctorVerb } from "./doctor.ts";
import { hostVerbs } from "./host-verbs.ts";
import { peopleVerbs } from "./people-verbs.ts";
import type { Program } from "./program.ts";
import { remoteVerbs } from "./remote-verbs.ts";
import { progressLine, runVerb, type Io } from "./report.ts";
import { serveVerb } from "./serve.ts";
import { storeVerbs } from "./store-verbs.ts";

/** The terminal a person runs `ukt` in. Prompts and the spinner are drawn only when one is there. */
export function terminal(): Io {
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  return {
    interactive,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    confirm: async (question) =>
      (await confirm({ message: question, initialValue: false })) === true,
    progress(title) {
      console.error(title);
      if (!interactive) return { update: () => undefined, stop: (line) => console.error(line) };
      const shown = spinner({ output: process.stderr });
      shown.start("starting");
      return {
        update: (label, done, total) =>
          shown.message(progressLine(label, done, total, process.stderr.columns ?? 80)),
        stop: (message) => shown.stop(message),
      };
    },
    open: (url) =>
      open(url).then(
        () => true,
        () => false,
      ),
  };
}

function version(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return manifest.version;
}

/** Parses `argv` (the arguments after the program's name), runs the verb, and returns the exit code. */
export async function main(
  argv: readonly string[],
  io: Io = terminal(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let code = 0;
  const ukt = new Command("ukt")
    .description("uketsugi: a shared memory for your AI agents, served from this machine.")
    .version(version())
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.out(text.trimEnd()),
      writeErr: (text) => io.err(text.trimEnd()),
    });
  const program: Program = {
    io,
    env,
    verb: (name, description) =>
      ukt
        .command(name)
        .description(description)
        .addOption(new Option("--data-dir <dir>", "the data directory").env("UKT_DATA_DIR"))
        .option("--json", "print one JSON envelope instead of text"),
    run: async (command, options, work) => {
      code = await runVerb(io, command, options.json === true, work);
    },
  };
  for (const add of [serveVerb, hostVerbs, peopleVerbs, doctorVerb, remoteVerbs, storeVerbs])
    add(program);
  try {
    await ukt.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
  return code;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
