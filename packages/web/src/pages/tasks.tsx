/**
 * Tasks: the work agents published, in every project the person can see or in one, in the order
 * an agent's own list has it: what was handed over, what a lapsed lease left, open work, then
 * what is held. A row opens the task's drawer, and the list keeps its place behind it.
 */
import type { ApiProject, ApiTask, TaskState } from "@uketsugi/contracts";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useTable } from "@tanstack/react-table";
import { useState } from "react";
import { tasksQuery } from "../api.ts";
import { ByProject, useSharing } from "../by-project.tsx";
import { Page } from "../shell.tsx";
import { columnsFor, DataTable, features, ShowMore } from "../table.tsx";
import {
  Ago,
  Card,
  count,
  Empty,
  FILTER_LINK,
  inWords,
  QueryState,
  sentence,
  TASK_STATES,
  TaskStateMark,
  ToSay,
} from "../ui.tsx";
import { Lease, TaskDrawer } from "./task-drawer.tsx";

const route = getRouteApi("/tasks");

/** What an empty Tasks page offers: something to ask of an agent. */
const FIRST_TASK =
  "Publish a task for what is left to do here, so that a later session can pick it up.";

/**
 * How many tasks the list asks for and how many more each "Show more" adds, and the most a request
 * may ask for: the default and the maximum of the contract's `TaskListParams.limit`, which the
 * page's test holds them to. The schema itself stays out of the bundle.
 */
const STEP = 100;
const MOST = 500;

const NO_TASKS: ApiTask[] = [];

function TaskCell({ task }: { task: ApiTask }) {
  const { project } = route.useSearch();
  const sharing = useSharing();
  const about = [
    ...(task.publisher === undefined ? [] : [`by ${task.publisher}`]),
    ...(project === undefined ? [task.project] : []),
    ...(task.tracked === true ? ["step of a plan"] : []),
    ...(sharing ? [task.audience] : []),
  ];
  // The words break anywhere, so that a long project key never makes the table wider than its card.
  return (
    <div className="space-y-1 wrap-anywhere">
      <Link
        to="/tasks"
        search={(shown) => ({ ...shown, task: task.id })}
        className="rounded-sm font-medium hover:underline"
      >
        {task.title}
      </Link>
      <p className="text-ink-muted">
        {[...about, "changed"].join(" · ")} <Ago at={task.updated_at} />
      </p>
      {task.note === undefined ? null : (
        <p className="line-clamp-2">
          <span className="text-ink-muted">
            {task.note_kind === "handoff" ? "Handoff note" : "Note"}
            {task.note_by === undefined ? "" : ` by ${task.note_by}`}:
          </span>{" "}
          {task.note}
        </p>
      )}
    </div>
  );
}

/** Where a task stands, and under it whose lease holds it or ran out. */
function StateCell({ task }: { task: ApiTask }) {
  return (
    <div className="space-y-1">
      <TaskStateMark task={task} />
      <Lease task={task} />
    </div>
  );
}

const column = columnsFor<ApiTask>();

const columns = column.columns([
  column.display({
    id: "task",
    header: "Task",
    cell: ({ row }) => <TaskCell task={row.original} />,
  }),
  column.display({
    id: "state",
    header: "State",
    cell: ({ row }) => <StateCell task={row.original} />,
  }),
]);

/** The states to narrow the list to. Without one it holds every task that is not done. */
function States() {
  const { project, status } = route.useSearch();
  return (
    <nav aria-label="State" className="flex flex-wrap gap-2">
      {[undefined, ...TASK_STATES].map((state) => (
        <Link
          key={state ?? "not done"}
          to="/tasks"
          search={{ project, status: state }}
          activeOptions={{ exact: true }}
          aria-current={state === status ? "true" : undefined}
          className={FILTER_LINK}
        >
          {state === undefined ? "Not done" : sentence(inWords(state))}
        </Link>
      ))}
    </nav>
  );
}

function NoTasks({ status }: { status: TaskState | undefined }) {
  if (status !== undefined) return <Empty sentence={`No task is ${inWords(status)} here.`} />;
  return (
    <Empty sentence="No task is waiting or under way. Tasks appear here when an agent publishes one">
      <ToSay text={FIRST_TASK} label="a first task to ask an agent for" />
    </Empty>
  );
}

function TaskList() {
  const { project, status, task: open } = route.useSearch();
  const [limit, setLimit] = useState(STEP);
  const list = useQuery(tasksQuery({ project, status, limit }));
  const tasks = list.data?.tasks ?? NO_TASKS;
  const table = useTable({ features, columns, data: tasks, getRowId: (task) => task.id });
  const matched = list.data?.matched ?? 0;
  const shown = `${count(tasks.length, "task")} shown`;
  return (
    <Card label="Tasks">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <h2 className="mr-auto font-semibold break-all">{project ?? "All projects"}</h2>
        <States />
      </div>
      <QueryState query={list} what="tasks" inset="p-4">
        {() =>
          tasks.length === 0 ? (
            <NoTasks status={status} />
          ) : (
            <>
              <DataTable
                table={table}
                caption={
                  status === undefined
                    ? "Tasks that are not done, in the order an agent could pick them up"
                    : `Tasks that are ${inWords(status)}`
                }
                current={(task) => task.id === open}
              />
              <ShowMore
                shown={matched > tasks.length ? `${matched} matched · ${shown}` : shown}
                more={
                  matched > tasks.length && limit < MOST
                    ? () => setLimit(Math.min(limit + STEP, MOST))
                    : undefined
                }
                waiting={list.isPlaceholderData}
              />
            </>
          )
        }
      </QueryState>
    </Card>
  );
}

/** A project's line under its name: its key, when it has a display name. */
function keyOf(project: ApiProject): string | null {
  return project.name === null ? null : project.key;
}

export function TasksPage() {
  const { project, task } = route.useSearch();
  const drawerOpen = task !== undefined;
  return (
    <Page
      title="Tasks"
      lead="The work agents published, by project: what is open, who holds what, and what was handed over or finished."
      drawerOpen={drawerOpen}
    >
      <ByProject page="/tasks" chosen={project} about={keyOf} drawerOpen={drawerOpen}>
        <TaskList />
      </ByProject>
      <TaskDrawer />
    </Page>
  );
}
