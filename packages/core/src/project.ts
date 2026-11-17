import type { ApiProject, NewProjectRequest, ProjectList } from "@uketsugi/contracts";
import { scopeOf } from "./context.ts";
import type { Caller, PersonProject, Project, ProjectRef } from "./domain.ts";
import { invalidInput, projectRequired, ToolFailure } from "./failure.ts";
import type { CorePorts } from "./ports.ts";
import { canShare, standing } from "./sharing.ts";

const REPOSITORY = /^[a-z0-9._-]+\.[a-z0-9._-]+(\/[a-z0-9._-]+){2}$/;
const NAMED = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

/**
 * The project a call names, in its canonical spelling, or null when the text is not one.
 *
 * A repository is `host/owner/name`. Its HTTPS and SSH remotes are accepted too
 * (`https://host/owner/name.git`, `git@host:owner/name`, `ssh://git@host:22/owner/name`), in any
 * case, with or without `.git` or a trailing slash, so two clones of one origin name one project.
 * A named project is `<owner>/<slug>`: lower case, digits and hyphens. This is the spelling rule
 * the recording experiments ran with; a wider rule needs a recording run.
 */
export function parseProject(input: unknown): ProjectRef | null {
  if (typeof input !== "string") return null;
  const trimmed = input
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .trim();
  if (NAMED.test(trimmed)) return { kind: "named", key: trimmed };
  const key = trimmed
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "") // scheme
    .replace(/^[^@/]+@/, "") // user@
    .replace(/^([^/:]+):(?!\d+\/)/, "$1/") // host:owner/name
    .replace(/^([^/:]+):\d+\//, "$1/") // host:port/owner/name
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  return REPOSITORY.test(key) ? { kind: "repository", key } : null;
}

/**
 * The project one of the dashboard's lists is narrowed to, by its canonical key; undefined for
 * every project. `things` is what the list holds, for the refusal of a filter that names none.
 */
export function projectFilter(named: string | undefined, things: string): string | undefined {
  if (named === undefined) return undefined;
  const ref = parseProject(named);
  if (ref === null) {
    throw invalidInput(
      "The project filter does not name a project.",
      `Choose a project from the list, or leave the filter out to see every project's ${things}.`,
    );
  }
  return ref.key;
}

/** The owner part of a named project that belongs to one person. */
const PERSONAL_OWNER = "me";

/**
 * Whether a project is one person's own and cannot be shared. Every named project is: a person
 * makes one as `me/<slug>`, a name that is each person's own, and none has a wider owner yet.
 */
export function isPersonal(project: ProjectRef): boolean {
  return project.kind === "named";
}
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** The most named projects a refusal lists. */
const REFUSAL_LIST_LIMIT = 20;

type ProjectPorts = Pick<CorePorts, "store" | "clock">;

/**
 * The project's record, or null when a named project is unknown to the caller. A repository
 * exists once it is named. A named project is its maker's own: one another person made reads as
 * unknown, exactly as one nobody made. Nothing is asked: a project met for the first time is used
 * here and kept private, and on a server with several people it stays private until its person
 * chooses to share it.
 */
export async function resolveProject(
  ports: ProjectPorts,
  caller: Caller,
  ref: ProjectRef,
): Promise<Project | null> {
  const { projects } = ports.store;
  if (ref.kind === "repository") return projects.ensure(caller.orgId, ref);
  const made = await projects.choice(caller.orgId, caller.principalId, ref.key);
  return made === null ? null : projects.find(caller.orgId, ref.key);
}

/** The project a piece of text names, as `parseProject` reads it and `resolveProject` finds it; null for none. */
export async function projectNamed(
  ports: ProjectPorts,
  caller: Caller,
  text: unknown,
): Promise<Project | null> {
  const ref = parseProject(text);
  return ref === null ? null : resolveProject(ports, caller, ref);
}

/** The person's named projects. */
async function namedProjects(ports: ProjectPorts, caller: Caller): Promise<PersonProject[]> {
  const projects = await ports.store.projects.listOf(caller.orgId, caller.principalId);
  return projects.filter((project) => project.kind === "named");
}

/**
 * The refusal of a call whose project is missing, malformed or not a known named project. Its text
 * is the fixed sentence; when the person has named projects, they follow it, since an agent
 * outside a repository can only learn a project's name from the person or from here.
 */
class ProjectRefusal extends ToolFailure {
  private readonly listed: string;

  constructor(named: readonly PersonProject[]) {
    const { text } = projectRequired();
    const keys = named.map((project) => project.key);
    super(
      "project_required",
      keys.length === 0 ? text : { ...text, details: { named_projects: keys } },
    );
    const shown = named
      .slice(0, REFUSAL_LIST_LIMIT)
      .map(({ key, displayName }) => (displayName === null ? key : `${key} (${displayName})`));
    const more = named.length - shown.length;
    this.listed =
      shown.length === 0
        ? ""
        : `\nYour named projects: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
  }

  override toText(): string {
    return `${super.toText()}${this.listed}`;
  }
}

/** The teaching refusal for this caller: the fixed text, then the person's named projects. */
export async function projectRefusal(ports: ProjectPorts, caller: Caller): Promise<ToolFailure> {
  return new ProjectRefusal(await namedProjects(ports, caller));
}

/**
 * Creates a named project of the person's own, `me/<slug>`, for work outside a repository. Only a
 * person creates one, on the dashboard; an agent never does. The slug never changes.
 */
export async function createNamedProject(
  ports: ProjectPorts,
  caller: Caller,
  input: NewProjectRequest,
): Promise<ApiProject> {
  const slug = input.slug.trim();
  if (!SLUG.test(slug)) {
    // A person reads this on the dashboard, so it is in their words and not a caller's.
    throw new ToolFailure("invalid_input", {
      what: `"${slug}" cannot be a project's slug.`,
      meaning: "Nothing was created.",
      next: "Use lower-case letters, digits and hyphens, starting with a letter or a digit, 63 characters at most.",
    });
  }
  const { projects } = ports.store;
  const ref: ProjectRef = { kind: "named", key: `${PERSONAL_OWNER}/${slug}` };
  // A personal project is its maker's own: whether someone else has one of this slug is not said.
  const mine = await projects.listOf(caller.orgId, caller.principalId);
  if (mine.some((project) => project.key === ref.key)) {
    throw new ToolFailure("conflict", {
      what: `The project ${ref.key} already exists.`,
      meaning: "Nothing was created: a slug names one project and never changes.",
      next: "Use the existing project, or choose another slug.",
    });
  }
  const displayName = input.name?.trim() || null;
  const project = await projects.ensure(caller.orgId, ref);
  // Its maker's choice is what makes it one of their projects before any session names it.
  const { orgId, principalId } = caller;
  await projects.choose(orgId, principalId, project.key, "private", displayName ?? undefined);
  return apiProject(caller, { ...project, choice: "private", displayName }, 0);
}

/** A project as the dashboard shows it to one person. */
function apiProject(caller: Caller, project: PersonProject, facts: number): ApiProject {
  return {
    key: project.key,
    kind: project.kind,
    name: project.displayName,
    facts,
    ...standing(caller, project.choice),
  };
}

/**
 * The projects the person works in, each with how they treat it and how many live facts they can
 * see in it. Another person's projects are not listed, shared or not.
 */
export async function listProjects(
  ports: Pick<CorePorts, "store">,
  caller: Caller,
): Promise<ProjectList> {
  const { projects, facts } = ports.store;
  const scope = scopeOf(caller);
  const rows = (await projects.listOf(caller.orgId, caller.principalId)).map(async (project) =>
    apiProject(caller, project, await facts.count(scope, project.key)),
  );
  return { projects: await Promise.all(rows), sharing: canShare(caller) };
}
