/**
 * Small made-up evidence for the checks of the suite's counting: a case folder as a run keeps it
 * (`chain.json`, `arm.json`, `steps.jsonl`, `facts.json`, `transcripts/`, `requests.jsonl`), and
 * results built from records, so that no session and no server is needed to try how they are counted.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scoring } from "../../src/recall/evidence.ts";
import type { Item, Items } from "../../src/recall/items.ts";
import type { CaseRecord, Cell } from "../../src/recall/report.ts";
import { assemble } from "../../src/recall/results.ts";

export const ITEM: Item = {
  kind: "person",
  statement: "Every widget is blue.",
  plant: ["T1"],
  gap: ["T2"],
  tests: { T3: ["t3"], T4: ["t4"] },
  pattern: "widgets are blue",
};

export const ITEMS: Items = { W1: ITEM, W2: { ...ITEM, pattern: "gadgets are red" } };

export const SCORING: Scoring = {
  items: ITEMS,
  seedClaims: new Set(),
  boilerplate: [],
  mode: "quick",
};

/** What a search of the product answers, as the harness's transcript holds it. */
export function search(id: string, result: unknown, name = "mcp__uketsugi__search_facts"): string {
  const call = {
    type: "assistant",
    message: {
      id: `m-${id}`,
      content: [{ type: "tool_use", id, name, input: { project: "p", query: "q" } }],
    },
  };
  const answer = {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: [{ type: "text", text: JSON.stringify(result) }],
        },
      ],
    },
  };
  return `${JSON.stringify(call)}\n${JSON.stringify(answer)}\n`;
}

export interface MadeCase {
  /** `S1` is the plant; every other session is a probe. */
  readonly transcripts: Readonly<Record<string, string>>;
  readonly requests?: readonly object[];
  readonly item?: string;
}

/** Writes a case folder of one plant and the probes named in `transcripts`; each session has one step. */
export function makeCase(dir: string, made: MadeCase): void {
  const item = made.item ?? "W1";
  mkdirSync(join(dir, "transcripts"), { recursive: true });
  const ids = Object.keys(made.transcripts);
  const sessions = ids.map((id) => ({
    id,
    role: id === "S1" ? "plant" : "probe",
    steps: [{ task: id === "S1" ? "T1" : "T3" }],
  }));
  const write = (name: string, value: unknown): void =>
    writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  write("chain.json", {
    sessions,
    needs: { T3: [item] },
    items: { [item]: { kind: "person", tests: { T3: ["t3"] } } },
  });
  write("arm.json", { memory: { call: ["^mcp__uketsugi__"], touch: ["uketsugi"] } });
  write("facts.json", []);
  write(
    "steps.jsonl",
    ids
      .map((id) =>
        JSON.stringify({
          session: id,
          step: 0,
          kind: "task",
          transcript: `transcripts/${id}.0.jsonl`,
          killed: false,
          first_write: null,
        }),
      )
      .join("\n") + "\n",
  );
  for (const [id, text] of Object.entries(made.transcripts))
    writeFileSync(join(dir, "transcripts", `${id}.0.jsonl`), text);
  if (made.requests !== undefined)
    write("requests.jsonl", made.requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export const RECALLED = {
  recalled: true,
  late: false,
  via: "tool",
  call: "search_facts",
  evidence: [],
  old_value_delivered: false,
  delivered_chars: 100,
  delivered_records: 1,
  unneeded_records: 0,
  wrote: false,
};

export const key = (item: string, kind: "treatment" | "control" = "treatment", repeat = 0) =>
  ({ product: "p", config: "c", item, kind, repeat }) as const;

/** A measured case: the item's needed cells, `hits` of them recalled. */
export function measured(
  item: string,
  hits: number,
  of = 2,
  extra: Partial<CaseRecord> = {},
  kind: "treatment" | "control" = "treatment",
  repeat = 0,
): CaseRecord & { cells: Cell[] } {
  const cells = Array.from({ length: of }, (_, n) => ({
    ...key(item, kind, repeat),
    task: `T${n + 3}`,
    session: `S${n + 2}`,
    recalled: { ...RECALLED, recalled: n < hits },
    used: null,
  }));
  return { ...key(item, kind, repeat), no_model: 0, expected: of, ...extra, cells };
}

export const errored = (
  item: string,
  extra: Partial<CaseRecord> = {},
  kind: "treatment" | "control" = "treatment",
  repeat = 0,
): CaseRecord & { cells: Cell[] } => ({
  ...key(item, kind, repeat),
  expected: 2,
  error: "SyntaxError",
  ...extra,
  cells: [],
});

/** A result of the cases, as a run assembles it. */
export const resultOf = (records: readonly (CaseRecord & { cells: Cell[] })[]) =>
  assemble(
    {
      product: "p",
      configs: ["c"],
      model: "haiku",
      mode: "quick",
      shape: "cases",
      gap: 2,
      repeat: 1,
    },
    records,
  );
