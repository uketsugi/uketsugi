/**
 * The run's `result.json` and what is done with it afterwards: assembling it from the cases, scoring
 * an earlier run again from the evidence it kept (`rescore`, no session), and completing a run with
 * a second one (`merge`: a case of the first that errored is replaced by the same case of the second;
 * a case that ran cleanly stays as it was, so no control is counted twice).
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { scoreCase, type CaseKey, type Scoring } from "./evidence.ts";
import { FORMAT, summarize, totals, type CaseRecord, type Cell, type Result } from "./report.ts";
import { caseName } from "./runner.ts";

const keyOf = (r: {
  product: string;
  config: string;
  item: string;
  kind: string;
  repeat: number;
}): string => `${r.product}|${r.config}|${r.item}|${r.kind}|${r.repeat}`;

/** `result.json` from the cases' records: their cells are lifted out, and the summary is made. */
export function assemble(
  settings: Record<string, unknown>,
  records: readonly (CaseRecord & { cells?: Cell[] })[],
): Result {
  const cells = records.flatMap((r) => r.cells ?? []);
  const cases = records.map((r) => {
    const rest: CaseRecord & { cells?: Cell[] } = { ...r };
    delete rest.cells;
    return rest;
  });
  const result = { format: FORMAT, ...settings, cells, cases, recall: {} } as unknown as Result;
  summarize(result);
  result.totals = totals(result);
  return result;
}

export async function readResultFile(path: string): Promise<Result> {
  return JSON.parse(await readFile(path, "utf8")) as Result;
}

const readResult = (folder: string, name = "result.json"): Promise<Result> =>
  readResultFile(join(folder, name));

/** A case of an earlier run scored again from its kept evidence. */
async function rescoreCase(
  folder: string,
  old: Result,
  scoring: Scoring,
  r: CaseRecord,
): Promise<CaseRecord & { cells?: Cell[] }> {
  const out = join(
    folder,
    "cases",
    caseName({ config: r.config, item: r.item, kind: r.kind, repeat: r.repeat }),
  );
  const record: CaseRecord & { cells?: Cell[] } = { ...r };
  delete record.cells;
  delete record.stored;
  if (record.setup === undefined && existsSync(join(out, "results.json"))) {
    const kept = JSON.parse(await readFile(join(out, "results.json"), "utf8")) as {
      sessions: Record<string, { setup?: unknown }>;
    };
    record.setup = Object.fromEntries(
      Object.entries(kept.sessions).map(([sid, s]) => [sid, s.setup]),
    );
  }
  if (record.error === undefined && existsSync(join(out, "facts.json"))) {
    const key: CaseKey = {
      product: r.product,
      config: r.config,
      item: r.item,
      kind: r.kind,
      repeat: r.repeat,
    };
    Object.assign(record, await scoreCase(out, key, { ...scoring, mode: old.mode }));
  }
  return record;
}

/** The result of an earlier run measured again from the evidence it kept. Writes `result.rescored.json` in its folder. */
export async function rescore(folder: string, scoring: Scoring): Promise<Result> {
  const old = await readResult(folder);
  const records = [];
  for (const r of old.cases) records.push(await rescoreCase(folder, old, scoring, r));
  const settings = Object.fromEntries(
    Object.entries(old).filter(([k]) => !["cells", "cases", "recall", "totals"].includes(k)),
  );
  const result = assemble(settings, records);
  await writeFile(join(folder, "result.rescored.json"), JSON.stringify(result, null, 1));
  return result;
}

/** The first run completed by the others, in order. Reads `result.rescored.json` where there is one. Writes `result.merged.json` in the first folder. */
export async function merge(folders: readonly string[]): Promise<Result> {
  const load = (f: string): Promise<Result> =>
    readResult(
      f,
      existsSync(join(f, "result.rescored.json")) ? "result.rescored.json" : "result.json",
    );
  const out = await load(folders[0] as string);
  for (const folder of folders.slice(1)) {
    const next = await load(folder);
    const done = new Set(out.cases.filter((r) => r.error === undefined).map(keyOf));
    const take = next.cases.filter((r) => !done.has(keyOf(r)) && r.error === undefined);
    const keys = new Set(take.map(keyOf));
    out.superseded = [
      ...(out.superseded ?? []),
      ...out.cases.filter((r) => keys.has(keyOf(r))),
      ...(next.superseded ?? []),
      ...next.cases.filter(
        (r) => r.error !== undefined && (done.has(keyOf(r)) || keys.has(keyOf(r))),
      ),
    ];
    out.cases = [...out.cases.filter((r) => !keys.has(keyOf(r))), ...take];
    out.cells = [
      ...out.cells.filter((c) => !keys.has(keyOf(c))),
      ...next.cells.filter((c) => keys.has(keyOf(c))),
    ];
  }
  out["merged_from"] = [...folders];
  summarize(out);
  out.totals = totals(out);
  await writeFile(join(folders[0] as string, "result.merged.json"), JSON.stringify(out, null, 1));
  return out;
}
