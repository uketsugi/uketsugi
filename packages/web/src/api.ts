/**
 * The typed client of the server's `/api`. Every shape comes from `@uketsugi/contracts`; this file
 * adds only the transport: the cookie, the CSRF header on a change, and one failure type.
 */
import {
  API_CSRF_HEADER,
  API_ERROR_STATUS,
  isApiError,
  type ActivityReport,
  type ApiError,
  type ApiProject,
  type CapabilityDescriptor,
  type ConnectInfo,
  type DashboardSession,
  type FactConfirmed,
  type FactCorrected,
  type FactDetail,
  type FactPage,
  type NewProjectRequest,
  type NoteRemoved,
  type ProjectChoice,
  type ProjectChoiceRequest,
  type ProjectContents,
  type ProjectDeleted,
  type ProjectJoin,
  type ProjectJoined,
  type ProjectList,
  type RedactResult,
  type RevertResult,
  type RulingList,
  type TaskClosed,
  type TaskDetail,
  type TaskListParams,
  type TaskPage,
} from "@uketsugi/contracts";
import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";

type Params = Readonly<Record<string, string | number | undefined>>;

interface Change {
  readonly method: "POST" | "DELETE";
  /** The value `GET /api/session` returned; absent only for the request that signs in. */
  readonly csrf?: string;
  /** What the request sends, as JSON. */
  readonly body?: unknown;
}

/** A request the server refused, with the three parts every error carries. */
export class ApiFailure extends Error {
  readonly status: number;
  readonly parts: ApiError["error"];

  constructor(status: number, parts: ApiError["error"]) {
    super(parts.what);
    this.name = "ApiFailure";
    this.status = status;
    this.parts = parts;
  }
}

/** The parts of a failure whose body is not the server's error shape: a proxy's page, or no answer. */
function unreadable(status: number): ApiError["error"] {
  return {
    code: "unavailable",
    what: `The server answered ${status} with no explanation.`,
    meaning: "This page could not be loaded or the change was not made.",
    next: "Check that the server is running, then reload the page.",
    retry: true,
  };
}

async function failure(response: Response): Promise<ApiFailure> {
  const body: unknown = await response.json().catch(() => undefined);
  return new ApiFailure(
    response.status,
    isApiError(body) ? body.error : unreadable(response.status),
  );
}

/** One request. The address is made absolute so that it reads the same in a browser and a test. */
async function request<T>(path: string, params: Params = {}, change?: Change): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (change?.csrf !== undefined) headers[API_CSRF_HEADER] = change.csrf;
  if (change?.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(url, {
    method: change?.method ?? "GET",
    credentials: "same-origin",
    headers,
    ...(change?.body === undefined ? {} : { body: JSON.stringify(change.body) }),
  });
  if (!response.ok) throw await failure(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** The three parts of any failure: the server's own, or what a request with no answer means. */
export function partsOf(error: unknown): ApiError["error"] {
  if (error instanceof ApiFailure) return error.parts;
  return {
    code: "unavailable",
    what: "The server could not be reached.",
    meaning: "What this page shows may be out of date, and a change was not made.",
    next: "Check that the server is running, then try again.",
    retry: true,
  };
}

/** Whether a failure means nobody is signed in. */
export function isSignedOut(error: unknown): boolean {
  return error instanceof ApiFailure && error.status === API_ERROR_STATUS.unauthorized;
}

export const sessionQuery = queryOptions({
  queryKey: ["session"],
  queryFn: () => request<DashboardSession>("/api/session"),
  retry: false,
  staleTime: Infinity,
});

export const capabilitiesQuery = queryOptions({
  queryKey: ["capabilities"],
  queryFn: () => request<CapabilityDescriptor>("/api/capabilities"),
  staleTime: Infinity,
});

export const connectQuery = queryOptions({
  queryKey: ["connect"],
  queryFn: () => request<ConnectInfo>("/api/connect"),
  staleTime: Infinity,
});

export const projectsQuery = queryOptions({
  queryKey: ["projects"],
  queryFn: () => request<ProjectList>("/api/projects"),
});

/** Asks again for what a change to facts can change: every list and view of them, and the projects' counts. */
export function refreshFacts(client: QueryClient): Promise<unknown> {
  return Promise.all([
    client.invalidateQueries({ queryKey: ["facts"] }),
    client.invalidateQueries({ queryKey: projectsQuery.queryKey }),
  ]);
}

/** The facts list, a page at a time. A search needs a project and has one page. */
export function factsQuery(filter: { project?: string; q?: string }) {
  return infiniteQueryOptions({
    queryKey: ["facts", "list", filter],
    queryFn: ({ pageParam }) =>
      request<FactPage>("/api/facts", { ...filter, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next,
  });
}

export function factQuery(id: string) {
  return queryOptions({
    queryKey: ["facts", "one", id],
    queryFn: () => request<FactDetail>(`/api/facts/${encodeURIComponent(id)}`),
  });
}

/** How often tasks are read again: a lease ends by the clock, and agents work while the page is open. */
const TASKS_REFRESH_MS = 30_000;

/**
 * The tasks list, in the order an agent could pick the tasks up: every project's or one's, the
 * ones that are not done or the ones in one state. A longer list replaces the shorter in place.
 */
export function tasksQuery(filter: Pick<TaskListParams, "project" | "status" | "limit">) {
  return queryOptions({
    queryKey: ["tasks", "list", filter],
    queryFn: () => request<TaskPage>("/api/tasks", filter),
    placeholderData: keepPreviousData,
    refetchInterval: TASKS_REFRESH_MS,
  });
}

export function taskQuery(id: string) {
  return queryOptions({
    queryKey: ["tasks", "one", id],
    queryFn: () => request<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`),
    refetchInterval: TASKS_REFRESH_MS,
  });
}

/** Activity over the last `days`. `refresh` re-reads it on that interval, in milliseconds. */
export function activityQuery(days: number, refresh?: number) {
  return queryOptions({
    queryKey: ["activity", days],
    queryFn: () => request<ActivityReport>("/api/activity", { days }),
    refetchInterval: refresh,
  });
}

export function redactFact(id: string, csrf: string): Promise<RedactResult> {
  return request<RedactResult>(
    `/api/facts/${encodeURIComponent(id)}/redact`,
    {},
    { method: "POST", csrf },
  );
}

/** Replaces the claim, and with `detail` the detail, of one of the person's own facts. */
export function correctFact(
  id: string,
  words: { claim: string; detail?: string | null },
  csrf: string,
): Promise<FactCorrected> {
  return request<FactCorrected>(
    `/api/facts/${encodeURIComponent(id)}/correct`,
    {},
    { method: "POST", csrf, body: words },
  );
}

/** Says the person has checked a fact. */
export function confirmFact(id: string, csrf: string): Promise<FactConfirmed> {
  return request<FactConfirmed>(
    `/api/facts/${encodeURIComponent(id)}/confirm`,
    {},
    { method: "POST", csrf, body: {} },
  );
}

/** Closes a task: it is done, whoever holds it. */
export function closeTask(id: string, csrf: string): Promise<TaskClosed> {
  return request<TaskClosed>(
    `/api/tasks/${encodeURIComponent(id)}/close`,
    {},
    { method: "POST", csrf },
  );
}

/** Removes the note a session left, by the session's display id. */
export function removeNote(session: string, csrf: string): Promise<NoteRemoved> {
  return request<NoteRemoved>(
    `/api/sessions/${encodeURIComponent(session)}/note`,
    {},
    { method: "DELETE", csrf },
  );
}

/** What deleting a project takes, asked when the person opens the question. */
export function projectContentsQuery(project: string) {
  return queryOptions({
    queryKey: ["projects", "contents", project],
    queryFn: () => request<ProjectContents>("/api/projects/contents", { project }),
    gcTime: 0,
  });
}

export function deleteProject(project: string, csrf: string): Promise<ProjectDeleted> {
  return request<ProjectDeleted>(
    "/api/projects",
    {},
    { method: "DELETE", csrf, body: { project } },
  );
}

/** The newest rulings, each with whether it can be reverted. */
export const rulingsQuery = queryOptions({
  queryKey: ["rulings"],
  queryFn: () => request<RulingList>("/api/rulings"),
});

export function revertRuling(id: string, csrf: string): Promise<RevertResult> {
  return request<RevertResult>(
    `/api/rulings/${encodeURIComponent(id)}/revert`,
    {},
    { method: "POST", csrf },
  );
}

export function signOut(csrf: string): Promise<void> {
  return request<undefined>("/api/session", {}, { method: "DELETE", csrf });
}

/** Signs this browser in as the person a dashboard key belongs to. */
export function signIn(key: string): Promise<void> {
  return request<undefined>("/sign-in", {}, { method: "POST", body: { key } });
}

/** Makes the person's choice for one project: shared with everyone on the server, or theirs alone. */
export function chooseTreatment(
  choice: ProjectChoiceRequest,
  csrf: string,
): Promise<ProjectChoice> {
  return request<ProjectChoice>("/api/projects/choice", {}, { method: "POST", csrf, body: choice });
}

/** Joins one of the person's projects into another: it cannot be undone. */
export function joinProject(join: ProjectJoin, csrf: string): Promise<ProjectJoined> {
  return request<ProjectJoined>("/api/projects/join", {}, { method: "POST", csrf, body: join });
}

/** Makes a named project of the person's own, `me/<slug>`, for work no repository names. */
export function createProject(project: NewProjectRequest, csrf: string): Promise<ApiProject> {
  return request<ApiProject>("/api/projects", {}, { method: "POST", csrf, body: project });
}

/** Where the Markdown export of one project, or of every project, downloads from. */
export function exportHref(project: string | undefined): string {
  const url = new URL("/api/export", window.location.origin);
  if (project !== undefined) url.searchParams.set("project", project);
  return `${url.pathname}${url.search}`;
}
