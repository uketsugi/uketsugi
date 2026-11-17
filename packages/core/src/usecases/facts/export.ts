/**
 * The Markdown export: every fact the person may see, one document per project, written so that a
 * person can read it and another tool can take it in. A fact's text, its citations, its standing
 * and its id are all there; a redacted fact has no text and is left out.
 */
import { CITATION_WORD, type ApiFact } from "@uketsugi/contracts";
import { scopeOf } from "../../context.ts";
import type { Caller, Fact, ReadScope } from "../../domain.ts";
import { apiFacts, flaggedSuffix } from "../../facts/views.ts";
import type { CorePorts } from "../../ports.ts";
import { parseProject } from "../../project.ts";
import type { FactListQuery } from "../../store-port.ts";

/** One document of an export: a project's facts as Markdown. Where it is filed is the caller's to decide. */
export interface ExportFile {
  readonly project: string;
  readonly content: string;
}

const PAGE = 200;

type ReadPorts = Pick<CorePorts, "store" | "clock">;

/** Every fact of a scope that a listing matches, newest first, read a page at a time. */
export async function allFacts(
  ports: Pick<CorePorts, "store">,
  scope: ReadScope,
  query: Pick<FactListQuery, "project" | "author">,
): Promise<Fact[]> {
  const facts: Fact[] = [];
  for (;;) {
    const last = facts.at(-1);
    const before = last === undefined ? undefined : { updatedAt: last.updatedAt, id: last.id };
    const page = await ports.store.facts.list(scope, { ...query, before, limit: PAGE });
    facts.push(...page);
    if (page.length < PAGE) return facts;
  }
}

/** A fact as a section of a project's document. */
function section(fact: ApiFact): string {
  const flags = flaggedSuffix(fact.flags);
  return [
    `## ${(fact.claim ?? "").replace(/\s+/g, " ").trim()}`,
    "",
    ...(fact.detail === null ? [] : [fact.detail.trim(), ""]),
    ...(fact.question === null ? [] : [`- Question: ${fact.question.replace(/\s+/g, " ").trim()}`]),
    `- Status: ${fact.status} · ${fact.trust}${flags}`,
    `- Author: ${fact.author} · updated ${fact.updated_at}`,
    ...(fact.confirmed_at === null ? [] : [`- Confirmed: ${fact.confirmed_at}`]),
    ...(fact.superseded_by === null ? [] : [`- Superseded by: ${fact.superseded_by}`]),
    "- Citations:",
    ...fact.citations.map((citation) => {
      const reason = citation.reason === undefined ? "" : `, ${citation.reason}`;
      return `  - \`${citation.ref}\` (${CITATION_WORD[citation.class]}${reason})`;
    }),
    `- Id: ${fact.id}`,
    "",
  ].join("\n");
}

function document(project: string, facts: readonly ApiFact[], at: Date): string {
  const count = `${facts.length} fact${facts.length === 1 ? "" : "s"}`;
  const head = [`# ${project}`, "", `Exported from uketsugi at ${at.toISOString()} · ${count}`, ""];
  return [...head, ...facts.map(section)].join("\n");
}

/**
 * The export as documents, one per project that holds a fact with text. `project` narrows it to
 * one; a project that is unknown or empty gives no document.
 */
export async function exportMarkdown(
  ports: ReadPorts,
  caller: Caller,
  project?: string,
): Promise<ExportFile[]> {
  const only = project === undefined ? undefined : (parseProject(project)?.key ?? project);
  const stored = await allFacts(ports, scopeOf(caller), { project: only });
  const facts = await apiFacts(
    ports,
    caller,
    stored.filter((fact) => fact.claim !== null),
  );
  const at = ports.clock.now();
  const keys = [...new Set(facts.map((fact) => fact.project))].sort();
  return keys.map((key) => {
    const own = facts.filter((fact) => fact.project === key);
    return { project: key, content: document(key, own, at) };
  });
}
