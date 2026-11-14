/**
 * The team fact set, in `data/team-memory`: 100 answers a team's memory would hold and 200 questions
 * asked of it, 70 answerable and 30 unanswerable in each half. The ranking values were chosen on the
 * `dev` half, so the `heldout` half is the headline.
 *
 * `vectors.json` and `vectors.f32` are a record in the predecessor's own format (a header, and one
 * `<kind>\0<text>` key per vector) of what the pinned model gives each text a run embeds, so a run
 * needs no model: each answer as a fact is embedded (its question, the answer and its citation,
 * one per line, which is also what the predecessor embedded) and each question asked. They are the
 * predecessor's recorded vectors; `embed/test/recorded-vectors.live.ts` checks every one against
 * the pinned model as the product's own embedder runs it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EmbedError, type Embedder } from "@uketsugi/core";

export interface Answer {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  /** A file path or a document's title. */
  readonly citation: string;
}

export interface Question {
  readonly id: string;
  readonly kind: "paraphrase" | "agent_short" | "identifier" | "no_answer_near" | "no_answer_far";
  readonly text: string;
  /** The ids of the answers that answer it; empty when the set holds none. */
  readonly answers: readonly string[];
  readonly split: "dev" | "heldout";
}

export interface FactSet {
  readonly answers: readonly Answer[];
  readonly questions: readonly Question[];
  /** The recorded vector of a text, however its white space runs; undefined when the set has none. */
  vectorOf(text: string): Float32Array | undefined;
  /** The recorded vectors behind the Embedder port. A text with no vector is an error, never a guess. */
  readonly embedder: Embedder;
  /** The texts the embedder was asked for and had no vector for. */
  readonly unknown: string[];
}

const DATA_DIR = fileURLToPath(new URL("../../data/team-memory/", import.meta.url));

/** What an answer's recorded vector was made from: its question, the answer and its citation. */
export function documentText(answer: Answer): string {
  return `${answer.question}\n${answer.answer}\n${answer.citation}`;
}

function jsonLines<T>(path: string): T[] {
  const lines = readFileSync(path, "utf8").split("\n");
  return lines.filter((line) => line !== "").map((line) => JSON.parse(line) as T);
}

const keyOf = (text: string): string => text.replace(/\s+/g, " ").trim();

export function loadTeamMemory(dir: string = DATA_DIR): FactSet {
  const answers = jsonLines<Answer>(`${dir}/answers.jsonl`);
  const questions = jsonLines<Question>(`${dir}/questions.jsonl`);
  const { header, keys } = JSON.parse(readFileSync(`${dir}/vectors.json`, "utf8")) as {
    header: { embedModel: string; dims: number };
    keys: string[];
  };
  const { embedModel, dims } = header;
  const bytes = readFileSync(`${dir}/vectors.f32`);
  const all = new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  if (keys.length * dims !== all.length) throw new Error("vectors.f32 does not match its keys");
  // The model embeds a text the same way whichever kind it is asked as, so the text alone is the key.
  const rows = new Map(keys.map((key, row) => [keyOf(key.slice(key.indexOf("\0") + 1)), row]));

  const unknown: string[] = [];
  const vectorOf = (text: string): Float32Array | undefined => {
    const row = rows.get(keyOf(text));
    return row === undefined ? undefined : all.slice(row * dims, (row + 1) * dims);
  };
  return {
    answers,
    questions,
    vectorOf,
    unknown,
    embedder: {
      model: embedModel,
      dims,
      async embed(asked) {
        return asked.map((text) => {
          const vector = vectorOf(text);
          if (vector !== undefined) return vector;
          unknown.push(text);
          throw new EmbedError(`no recorded vector for "${text.slice(0, 60)}"`, false);
        });
      },
    },
  };
}
