/**
 * A person's own data: all of it, taken away as a document, and the deletion of the account
 * with all of it. What is theirs is what they wrote: their facts, the tasks they published, the
 * notes their agents left on tasks and in sessions, and their choices of projects. What they only
 * read is not.
 *
 * Deleting an account is deleting each project the person works in (`deleteProject`, which brings
 * what they shared home first and flags the facts that cited it), then what no project holds: their
 * confirmations and notes on other people's records, their credentials, and their name. The row of
 * the account stays with no name, so a person removed this way is refused at sign-in as one an
 * operator removed is. The log keeps what it holds of acts they did on other people's records, which
 * are ids and codes and no text, under that row.
 */
import type {
  AccountContents,
  AccountDeleted,
  AccountDeletion,
  MyData,
  ProjectContents,
} from "@uketsugi/contracts";
import { scopeOf } from "../context.ts";
import type { Caller, ReadScope } from "../domain.ts";
import { forbidden, invalidInput } from "../failure.ts";
import { apiFacts } from "../facts/views.ts";
import type { CorePorts } from "../ports.ts";
import { listProjects } from "../project.ts";
import { allFacts, factSection } from "./facts/export.ts";
import { flagCiting } from "./facts/write.ts";
import { deleteProject } from "./forget-project.ts";

type Ports = Pick<CorePorts, "store" | "clock" | "ids" | "embedder">;

/**
 * Where the person's records can be: their own audience and every group of the organization,
 * those they have left included, since what they shared stays in the group when they leave it.
 * Used only to find what they wrote, by author; what they may read is `scopeOf`.
 */
async function wherever(ports: Pick<CorePorts, "store">, caller: Caller): Promise<ReadScope> {
  const groups = await ports.store.directory.groups(caller.orgId);
  return {
    orgId: caller.orgId,
    audienceIds: [caller.privateAudienceId, ...groups.map((g) => g.id)],
  };
}

/** Everything the person wrote, as the document they download. */
export async function exportMine(ports: Ports, caller: Caller): Promise<MyData> {
  const { store } = ports;
  const scope = await wherever(ports, caller);
  // A record in a group the person has left is labelled with that group, as the contents page does.
  const groups = (await store.directory.groups(caller.orgId)).map(({ id, name }) => ({ id, name }));
  const me = caller.principalId;
  const mine = (await allFacts(ports, scope, {})).filter((fact) => fact.author === me);
  const asked = { person: me, limit: await store.tasks.count(scope, { person: me }) };
  const tasks = (await store.tasks.list(scope, asked)).filter((task) => task.publisher === me);
  const sessions = await store.sessions.recent(caller.orgId, me, Number.MAX_SAFE_INTEGER);
  return {
    version: 1,
    exported_at: ports.clock.now().toISOString(),
    projects: (await listProjects(ports, caller)).projects,
    facts: await apiFacts(ports, { ...caller, groups }, mine),
    tasks: tasks.map((task) => ({
      id: task.id,
      project: task.project,
      title: task.title,
      description: task.description,
      state: task.state,
      created_at: task.createdAt.toISOString(),
      updated_at: task.updatedAt.toISOString(),
    })),
    task_notes: (await store.tasks.notesBy(scope, me)).map((note) => ({
      task: note.taskId,
      kind: note.kind,
      text: note.text,
      at: note.at.toISOString(),
    })),
    session_notes: sessions.flatMap(({ project, clientName, note }) =>
      note === null || note.text === ""
        ? []
        : [
            {
              project,
              client: clientName,
              text: note.text,
              final: note.final,
              at: note.at.toISOString(),
            },
          ],
    ),
  };
}

/** The same, to be read: a Markdown document, a section a project. */
export function renderMine(data: MyData): string {
  const keys = [...new Set([...data.facts, ...data.tasks].map((record) => record.project))].sort();
  const sections = keys.flatMap((key) => {
    const facts = data.facts.filter((fact) => fact.project === key);
    const tasks = data.tasks.filter((task) => task.project === key);
    return [
      `# ${key}`,
      "",
      ...facts.map(factSection),
      ...tasks.flatMap((task) => [
        `## Task: ${task.title}`,
        "",
        ...(task.description === null ? [] : [task.description.trim(), ""]),
        `- State: ${task.state} · updated ${task.updated_at}`,
        ...data.task_notes
          .filter((note) => note.task === task.id)
          .map((note) => `- ${note.kind} ${note.at}: ${note.text.replace(/\s+/g, " ").trim()}`),
        `- Id: ${task.id}`,
        "",
      ]),
    ];
  });
  const mine = new Set(data.tasks.map((task) => task.id));
  const elsewhere = data.task_notes
    .filter((note) => !mine.has(note.task))
    .map(
      (note) =>
        `- ${note.at} · ${note.kind} on task ${note.task}: ${note.text.replace(/\s+/g, " ").trim()}`,
    );
  const notes = data.session_notes.flatMap((note) => [
    `- ${note.at} · ${note.client} · ${note.project ?? "no project"}: ${note.text.replace(/\s+/g, " ").trim()}`,
  ]);
  return [
    "# Everything of yours in uketsugi",
    "",
    `Exported at ${data.exported_at}`,
    "",
    ...sections,
    ...(elsewhere.length === 0 ? [] : ["# Notes on other people's tasks", "", ...elsewhere, ""]),
    ...(notes.length === 0 ? [] : ["# Session notes", "", ...notes, ""]),
  ].join("\n");
}

/** Why the account cannot be deleted now; null when it can. */
async function blockedBy(ports: Pick<CorePorts, "store">, caller: Caller): Promise<string | null> {
  const people = await ports.store.directory.people(caller.orgId);
  const first = people.find((person) => person.administrator);
  if (first?.id !== caller.principalId || people.length < 2) return null;
  return "You are the administrator of this organization and other people are in it. Remove them from it first, then delete your account.";
}

/** What deleting the account takes, what it takes from each group, and what of other people's stays. */
export async function accountContents(ports: Ports, caller: Caller): Promise<AccountContents> {
  const { store } = ports;
  const held = await store.projects.authored(await wherever(ports, caller), caller.principalId);
  const groups = (await store.directory.groups(caller.orgId)).flatMap((group) => {
    const shared = held.byAudience.get(group.id);
    if (shared === undefined) return [];
    const others = group.members.filter((member) => member !== caller.principalId).length;
    return [{ name: group.name, other_members: others, ...shared }];
  });
  const mine = await store.projects.listOf(caller.orgId, caller.principalId);
  const there = await Promise.all(
    mine.map((project) =>
      store.projects.holdings(scopeOf(caller), caller.principalId, project.key),
    ),
  );
  return {
    facts: held.facts,
    tasks: held.tasks,
    sessions: held.sessions,
    task_notes: held.taskNotes,
    confirmations: held.confirmations,
    groups,
    others_facts: there.reduce((sum, one) => sum + one.othersFacts, 0),
    others_tasks: there.reduce((sum, one) => sum + one.othersTasks, 0),
    blocked: await blockedBy(ports, caller),
  };
}

/**
 * What the person shared with a group they have since left sits in that group, out of their
 * reach as a person; the facts there that cite it are flagged as `deleteProject` flags the ones
 * in the groups they are in.
 */
async function flagWhatCitedLeftGroups(ports: Ports, caller: Caller): Promise<void> {
  const groups = await ports.store.directory.groups(caller.orgId);
  const left = groups.filter((group) => !caller.groups.some((member) => member.id === group.id));
  for (const group of left) {
    const scope = { orgId: caller.orgId, audienceIds: [group.id] };
    const mine = (await allFacts(ports, scope, {})).filter((f) => f.author === caller.principalId);
    const target = { orgId: caller.orgId, audienceId: group.id, at: ports.clock.now() };
    await ports.store.unit(target, async (unit) => {
      for (const fact of mine) await flagCiting(ports, unit, null, fact.id);
    });
  }
}

/** Deletes the account as `accountContents` showed it, once the person has typed their name. */
export async function deleteAccount(
  ports: Ports,
  caller: Caller,
  input: AccountDeletion,
): Promise<AccountDeleted> {
  const blocked = await blockedBy(ports, caller);
  if (blocked !== null) throw forbidden(blocked, "Remove the other people, then try again.");
  if (input.name.trim() !== caller.displayName) {
    throw invalidInput(
      "The name typed is not the name of this account.",
      `Type ${caller.displayName} to confirm.`,
    );
  }
  const gone: Pick<ProjectContents, "facts" | "tasks" | "sessions"> = {
    facts: 0,
    tasks: 0,
    sessions: 0,
  };
  const projects = await ports.store.projects.listOf(caller.orgId, caller.principalId);
  for (const project of projects) {
    const one = await deleteProject(ports, caller, { project: project.key });
    gone.facts += one.facts;
    gone.tasks += one.tasks;
    gone.sessions += one.sessions;
  }
  await flagWhatCitedLeftGroups(ports, caller);
  const erased = await ports.store.directory.eraseAccount(
    caller.orgId,
    caller.principalId,
    ports.clock.now(),
  );
  return {
    facts: gone.facts + erased.facts,
    tasks: gone.tasks + erased.tasks,
    sessions: gone.sessions,
    credentials_ended: erased.credentials,
  };
}
