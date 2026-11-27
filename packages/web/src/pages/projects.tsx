/**
 * Projects: the projects the person's agents work in, and who sees what the person publishes in
 * each. On a server with other people the person chooses here, per project, to share it or keep
 * it private, and can change their mind. Nobody else makes the choice, and no agent can. Below
 * the list a person makes a named project, for work that no origin remote names. A person also
 * deletes a project of theirs here, after being shown what goes.
 */
import type { ApiProject, ProjectChoice, ProjectChoiceRequest } from "@uketsugi/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTable } from "@tanstack/react-table";
import { createContext, use, useState } from "react";
import {
  chooseTreatment,
  deleteProject,
  projectContentsQuery,
  projectsQuery,
  refreshFacts,
} from "../api.ts";
import { Page, useChange, useSession } from "../shell.tsx";
import { columnsFor, DataTable, features } from "../table.tsx";
import {
  Button,
  Card,
  ChangeDialog,
  ConfirmDialog,
  count,
  Empty,
  ErrorPanel,
  Mark,
  QueryState,
  SEEN_BY,
} from "../ui.tsx";
import { NamedProjects } from "./named-project.tsx";

type Treatment = ProjectChoiceRequest["treatment"];

/** What each choice does, said before it is made. */
const ASK: Record<Treatment, { title: string; body: string; confirm: string }> = {
  shared: {
    title: "Share this project?",
    body: "Your facts here with a citation that can be looked up, and your tasks that are not steps of a plan, become visible to everyone on this server, under your name. That includes the ones you have already published. A fact stays yours alone while it has no such citation, while a duplicate merged into it has none, or while it cites a fact of yours that others cannot see; open the fact and it says which. You can take it back.",
    confirm: "Share the project",
  },
  private: {
    title: "Keep this project private?",
    body: "What you published here goes back to being yours alone: your facts and tasks leave everyone else's view, and other people's confirmations of them are dropped. What you wrote on other people's shared facts and tasks (a confirmation, a note, a claim) stays with them. What other people already read cannot be recalled.",
    confirm: "Keep it private",
  },
};

/** How a row makes a choice, whether choices can be made here, and the choice being made now. */
const Choosing = createContext<{
  sharing: boolean;
  pending: boolean;
  choose: (choice: ProjectChoiceRequest) => void;
}>({ sharing: false, pending: false, choose: () => undefined });

/** A choice that moves what the person published: asked before it is made. */
function AskFirst({ project, to }: { project: ApiProject; to: Treatment }) {
  const { choose, pending } = use(Choosing);
  const [open, setOpen] = useState(false);
  const ask = ASK[to];
  const label = to === "shared" ? "Share" : "Keep private";
  const confirm = () => {
    setOpen(false);
    choose({ project: project.key, treatment: to });
  };
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      trigger={<Button size="sm" disabled={pending} aria-label={`${label} ${project.key}…`} />}
      triggerText={`${label}…`}
      title={ask.title}
      keep="Leave it as it is"
      change={{ text: ask.confirm, tone: "primary", onClick: confirm }}
    >
      <span className="block font-mono break-all">{project.key}</span>
      <span className="mt-2 block">{ask.body}</span>
    </ConfirmDialog>
  );
}

/** What deleting the project takes, read when the question is opened, and what of other people's stays. */
function Contents({ project }: { project: string }) {
  const contents = useQuery(projectContentsQuery(project));
  return (
    <QueryState query={contents} what="what the project holds">
      {(held) => (
        <span className="mt-2 block">
          This deletes {count(held.facts, "fact")}, {count(held.tasks, "task")} and{" "}
          {count(held.sessions, "session")} of yours here, with the notes the sessions left, and
          what the server’s log holds of them.
          {held.others_facts + held.others_tasks === 0
            ? ""
            : ` ${count(held.others_facts, "fact")} and ${count(held.others_tasks, "task")} of other people’s stay.`}
        </span>
      )}
    </QueryState>
  );
}

/** Deletes everything of the person's in one project, asked about first and shown what goes. */
function Delete({ project }: { project: ApiProject }) {
  const deleted = useChange(
    (csrf) => deleteProject(project.key, csrf),
    (kept) => Promise.all([refreshFacts(kept), kept.invalidateQueries({ queryKey: ["tasks"] })]),
  );
  return (
    <ChangeDialog
      mutation={deleted}
      trigger={<Button size="sm" tone="danger" aria-label={`Delete ${project.key}…`} />}
      triggerText="Delete…"
      title="Delete this project?"
      keep="Keep the project"
      text="Delete the project"
    >
      <span className="block font-mono break-all">{project.key}</span>
      <Contents project={project.key} />
      <span className="mt-2 block">
        This cannot be undone. A copy can stay behind in the database’s own files and in a backup,
        which Uketsugi does not remove. An agent that works here again starts the project afresh.
      </span>
    </ChangeDialog>
  );
}

function TreatmentCell({ project }: { project: ApiProject }) {
  const { treatment } = project;
  return (
    <Mark look={SEEN_BY[treatment]}>
      {project.chosen ? treatment : `${treatment} · not chosen yet`}
    </Mark>
  );
}

function ChoiceCell({ project }: { project: ApiProject }) {
  const { sharing, pending, choose } = use(Choosing);
  if (!sharing) return null;
  if (project.kind !== "repository") return <span className="text-ink-muted">yours alone</span>;
  if (project.treatment === "shared") return <AskFirst project={project} to="private" />;
  return (
    <span className="flex flex-wrap gap-2">
      <AskFirst project={project} to="shared" />
      {project.chosen ? null : (
        <Button
          size="sm"
          disabled={pending}
          aria-label={`Keep ${project.key} private`}
          onClick={() => choose({ project: project.key, treatment: "private" })}
        >
          Keep private
        </Button>
      )}
    </span>
  );
}

/** A folder's key, `file://<machine>/<path>`, as its machine and its path. */
function Name({ project }: { project: ApiProject }) {
  if (project.kind === "path") {
    const folder = project.key.slice("file://".length);
    const at = folder.indexOf("/");
    return (
      <span className="flex flex-col break-all">
        <span className="text-ink-muted">{folder.slice(0, at)}</span>
        <span className="font-mono">{folder.slice(at)}</span>
      </span>
    );
  }
  return (
    <span className="break-all">
      {project.name === null ? project.key : `${project.name} (${project.key})`}
    </span>
  );
}

const column = columnsFor<ApiProject>();

const columns = column.columns([
  column.display({
    id: "project",
    header: "Project",
    cell: ({ row }) => <Name project={row.original} />,
  }),
  column.accessor("facts", { header: "Facts you can see" }),
  column.display({
    id: "treatment",
    header: "Treated as",
    cell: ({ row }) => <TreatmentCell project={row.original} />,
  }),
  column.display({
    id: "choice",
    header: "Change",
    cell: ({ row }) => <ChoiceCell project={row.original} />,
  }),
  column.display({
    id: "delete",
    header: "Delete",
    cell: ({ row }) => <Delete project={row.original} />,
  }),
]);

/** What a choice did, in a sentence. */
function outcome({ project, treatment, moved }: ProjectChoice): string {
  const what = `${count(moved.facts, "fact")} and ${count(moved.tasks, "task")}`;
  return treatment === "shared"
    ? `${project} is shared: ${what} of yours became visible to everyone on this server.`
    : `${project} is private: ${what} of yours went back to being yours alone.`;
}

function Listed({ projects }: { projects: ApiProject[] }) {
  const table = useTable({ features, columns, data: projects });
  if (projects.length === 0) {
    return <Empty sentence="No agent of yours has worked in a project yet" />;
  }
  return <DataTable table={table} caption="Your projects and how each is treated" />;
}

const NONE: ApiProject[] = [];

export function ProjectsPage() {
  const { csrf } = useSession();
  const client = useQueryClient();
  const projects = useQuery(projectsQuery);
  const choice = useMutation({
    mutationFn: (made: ProjectChoiceRequest) => chooseTreatment(made, csrf),
    onSuccess: () => refreshFacts(client),
  });
  const sharing = projects.data?.sharing === true;
  return (
    <Page
      title="Projects"
      lead="The projects your agents work in, and who sees what you publish in each."
    >
      <p>
        {sharing
          ? "A project is private until you share it. Sharing shows everyone on this server your facts there with a citation that can be looked up, and your tasks that are not steps of a plan. Everything else stays yours, and a fact that stays private says why when you open it. Whoever operates this server can read all of it."
          : "Nobody else is on this server, so everything here is private to you."}
      </p>
      <p role="status">{choice.isSuccess ? outcome(choice.data) : ""}</p>
      {choice.isError ? <ErrorPanel error={choice.error} /> : null}
      <Card label="Your projects">
        <QueryState query={projects} what="your projects" inset="p-4">
          {(data) => (
            <Choosing value={{ sharing, pending: choice.isPending, choose: choice.mutate }}>
              <Listed projects={data.projects} />
            </Choosing>
          )}
        </QueryState>
      </Card>
      <NamedProjects projects={projects.data?.projects ?? NONE} />
    </Page>
  );
}
