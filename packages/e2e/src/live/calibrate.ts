/**
 * `live --calibrate`: measures (and keeps the provider sessions' transcripts under `<out>/cases/`, where the next run's first reading of the window is taken from) the machine and the provider (trials of `width.ts`) and writes
 * `width.json`. It needs ergo's trees, the installed release with its model, and the sign-in; the
 * decisions it takes from the trials are in `width.ts`.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterContext } from "../recall/adapter.ts";
import { Case } from "../recall/case.ts";
import { makeTree } from "../recall/chain.ts";
import { judge } from "../recall/judge.ts";
import { none } from "../recall/none.ts";
import type { Prepared } from "../recall/prepare.ts";
import type { Tools } from "../recall/preflight.ts";
import { startServer } from "../recall/server.ts";
import { copyEvidence } from "../recall/runner.ts";
import { spendOf } from "../recall/spend.ts";
import type { Workspace } from "../recall/workspace.ts";
import { machineWidth, providerWidth, widthOf, type MachineTrial } from "./width.ts";

const READ_ONLY =
  "Read-only task: look through this repository and tell me, in one paragraph, what the ChanServ code does. Do not edit, create or delete any file.";
const SESSION_MS = 120_000;
const TASKS = ["T4", "T8"] as const;

export interface CalibrateDeps {
  readonly prepared: Prepared;
  readonly context: AdapterContext;
  readonly tools: Tools;
  readonly workspace: Workspace;
  readonly out: string;
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

/** K judgements of the reference squashes at once, with K/2 servers (embedding model loaded) running beside them. */
async function machineTrial(
  d: CalibrateDeps,
  k: number,
  trees: Record<string, string>,
  solo: Record<string, number>,
): Promise<MachineTrial> {
  const servers = await Promise.all(
    range(k / 2).map((i) =>
      startServer({
        releaseHome: d.prepared.home,
        dataDir: d.workspace.at("calibrate", `server-${k}-${i}`, "data"),
        port: 0,
        modelDir: d.context.modelDir,
        log: d.workspace.at("calibrate", `server-${k}-${i}.log`),
      }),
    ),
  );
  try {
    const judged = await Promise.all(
      range(k).map(async (i) => {
        const task = TASKS[i % 2] as string;
        const began = Date.now();
        const result = await judge(d.prepared.judge, task, trees[task] as string);
        return { passed: result.passed, ratio: (Date.now() - began) / (solo[task] as number) };
      }),
    );
    return {
      k,
      allPassed: judged.every((j) => j.passed),
      serversUp: servers.every((s) => s.exit() === null),
      ratio: median(judged.map((j) => j.ratio)),
    };
  } finally {
    await Promise.all(servers.map((s) => s.stop()));
  }
}

/** K two-minute read-only sessions at once; whether the provider refused any of them, and what they used. */
async function providerTrial(
  d: CalibrateDeps,
  k: number,
  tree: string,
): Promise<{ refused: boolean; tokens: number }> {
  const ran = await Promise.all(
    range(k).map(async (i) => {
      const c = await Case.open({
        adapter: none,
        context: d.context,
        tools: d.tools,
        config: "none",
        name: `provider-${k}-${i}`,
        seeded: false,
      });
      try {
        const copy = d.workspace.at("calibrate", `tree-${k}-${i}`);
        await makeTree(d.prepared.chain, d.prepared.rebuilt, tree, copy);
        const result = await c.session({
          name: "p",
          tree: copy,
          prompt: READ_ONLY,
          capMs: SESSION_MS,
        });
        return {
          end: result.end,
          tokens: (await spendOf(c.dir).catch(() => ({ tokens: 0 }))).tokens,
        };
      } finally {
        await copyEvidence(c.dir, join(d.out, "cases", `provider-${k}-${i}`));
        await c.close();
      }
    }),
  );
  return {
    refused: ran.some((r) => r.end.kind === "void" && r.end.cause === "provider"),
    tokens: ran.reduce((s, r) => s + r.tokens, 0),
  };
}

export async function calibrate(
  d: CalibrateDeps,
): Promise<ReturnType<typeof widthOf> & { tokens: number }> {
  const { chain, rebuilt } = d.prepared;
  const trees: Record<string, string> = {};
  const solo: Record<string, number> = {};
  for (const task of TASKS) {
    trees[task] = d.workspace.at("calibrate", `squash-${task}`);
    await makeTree(chain, rebuilt, rebuilt.squash[task] as string, trees[task]);
    const began = Date.now();
    await judge(d.prepared.judge, task, trees[task]);
    solo[task] = Date.now() - began;
    console.log(`${task} judged alone in ${(solo[task] / 1000).toFixed(1)} s`);
  }
  const machine = await machineWidth(async (k) => {
    const trial = await machineTrial(d, k, trees, solo);
    console.log(
      `machine K=${k}: all passed ${trial.allPassed}, servers up ${trial.serversUp}, median ${trial.ratio.toFixed(2)} times solo`,
    );
    return trial;
  });
  let tokens = 0;
  const provider = await providerWidth(machine.k, async (k) => {
    const trial = await providerTrial(d, k, rebuilt.parent["T1"] as string);
    tokens += trial.tokens;
    console.log(
      `provider K=${k}: refused ${trial.refused}, ${(trial.tokens / 1e6).toFixed(1)} M tokens`,
    );
    return trial;
  });
  const width = { ...widthOf(machine, provider), tokens };
  await writeFile(join(d.out, "width.json"), JSON.stringify(width, null, 1));
  return width;
}
