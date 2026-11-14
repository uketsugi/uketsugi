/**
 * The routes. Each page's filters and its open drawer live in the address, so a list keeps its
 * place across a reload and a link names exactly what was on screen.
 */
import type { TaskState } from "@uketsugi/contracts";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  type RouterHistory,
} from "@tanstack/react-router";
import { ActivityPage, PERIODS } from "./pages/activity.tsx";
import { ConnectPage } from "./pages/connect.tsx";
import { FactsPage } from "./pages/facts.tsx";
import { ProjectsPage } from "./pages/projects.tsx";
import { TasksPage } from "./pages/tasks.tsx";
import { Gate } from "./shell.tsx";
import { TASK_STATES } from "./ui.tsx";

type Search = Record<string, unknown>;

/** A text value from the address. The router reads `?q=12` as a number; a filter is always text. */
function text(value: unknown): string | undefined {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value !== "" ? value : undefined;
}

function period(value: unknown): number | undefined {
  return PERIODS.find((days) => days === value);
}

/** What each page keeps in the address. Every part is optional: a bare path is a whole page. */
interface FactsSearch {
  project?: string;
  q?: string;
  /** The fact whose drawer is open. */
  fact?: string;
}

interface TasksSearch {
  project?: string;
  /** The state the list is narrowed to; without it, every task that is not done. */
  status?: TaskState;
  /** The task whose drawer is open. */
  task?: string;
}

const root = createRootRoute({ component: Gate });

const home = createRoute({
  getParentRoute: () => root,
  path: "/",
  component: () => <Navigate to="/facts" replace />,
});

const facts = createRoute({
  getParentRoute: () => root,
  path: "/facts",
  validateSearch: (search: Search): FactsSearch => ({
    project: text(search.project),
    q: text(search.q),
    fact: text(search.fact),
  }),
  component: FactsPage,
});

const tasks = createRoute({
  getParentRoute: () => root,
  path: "/tasks",
  validateSearch: (search: Search): TasksSearch => ({
    project: text(search.project),
    status: TASK_STATES.find((state) => state === search.status),
    task: text(search.task),
  }),
  component: TasksPage,
});

const activity = createRoute({
  getParentRoute: () => root,
  path: "/activity",
  validateSearch: (search: Search): { days?: number } => ({ days: period(search.days) }),
  component: ActivityPage,
});

const projects = createRoute({
  getParentRoute: () => root,
  path: "/projects",
  component: ProjectsPage,
});

const connect = createRoute({
  getParentRoute: () => root,
  path: "/connect",
  validateSearch: (search: Search): { harness?: string } => ({ harness: text(search.harness) }),
  component: ConnectPage,
});

const routeTree = root.addChildren([home, facts, tasks, activity, projects, connect]);

/** The router over a history: the address bar in a browser, memory in a test. */
export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, history });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
