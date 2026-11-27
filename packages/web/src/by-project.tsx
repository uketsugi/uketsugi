/**
 * The frame of a page that lists records by project: the person's projects beside the list, one
 * of them chosen or all. Beside an open drawer the list keeps a width it can be read at.
 */
import type { ApiProject } from "@uketsugi/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cx } from "class-variance-authority";
import type { ReactNode } from "react";
import { projectsQuery } from "./api.ts";
import { Card, Mark, QueryFailed, SEEN_BY } from "./ui.tsx";

/** Whether this server has other people, so that a record is either shared with them or private. */
export function useSharing(): boolean {
  return useQuery(projectsQuery).data?.sharing === true;
}

/** Who sees a record, said only on a server with other people, where a record is shared or private. */
export function SeenByMark({
  audience,
  group,
}: {
  audience: "private" | "shared";
  /** The group a shared record is shared with, when it is one other than `everyone`. */
  group?: string | undefined;
}) {
  const words = audience === "shared" && group !== undefined ? `shared with ${group}` : audience;
  return useSharing() ? <Mark look={SEEN_BY[audience]}>{words}</Mark> : null;
}

/** The pages that list by project. Each keeps the chosen project in its address as `project`. */
type ListPage = "/facts" | "/tasks";

interface Choice {
  readonly page: ListPage;
  /** The key of the chosen project; undefined for every project. */
  readonly chosen: string | undefined;
  /** What a project's second line says of it on this page, if anything. */
  readonly about: (project: ApiProject) => string | null;
}

const PROJECT_LINK = "block space-y-0.5 px-4 py-2.5 hover:bg-sunken aria-[current]:bg-accent-soft";

/** A project to show the records of, or every project. The spaces keep its spoken name in words. */
function ProjectLink({ project, page, chosen, about }: Choice & { project?: ApiProject }) {
  const selected = chosen === project?.key;
  const line = project === undefined ? null : about(project);
  return (
    <Link
      to={page}
      search={{ project: project?.key }}
      activeOptions={{ exact: true }}
      aria-current={selected ? "true" : undefined}
      className={PROJECT_LINK}
    >
      <span className={cx("block break-words", selected && "font-semibold")}>
        {project === undefined ? "All projects" : (project.name ?? project.key)}
      </span>{" "}
      {line === null ? null : <span className="break-all text-ink-muted">{line}</span>}
    </Link>
  );
}

function Projects(choice: Choice) {
  const projects = useQuery(projectsQuery);
  return (
    <Card>
      <nav aria-label="Projects">
        <ul className="divide-y divide-line overflow-hidden rounded-lg">
          <li>
            <ProjectLink {...choice} />
          </li>
          {projects.data?.projects.map((each) => (
            <li key={each.key}>
              <ProjectLink {...choice} project={each} />
            </li>
          ))}
        </ul>
      </nav>
      {projects.isError ? <QueryFailed query={projects} inset="p-3" /> : null}
    </Card>
  );
}

/** The columns: the projects, then the list. */
const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[14rem_minmax(0,1fr)]";

/**
 * Beside an open drawer (`Page` leaves it its width from `xl` up) a screen under `2xl` has no room
 * for three columns: the list would be a few words wide. There the projects give the list their
 * column until the drawer closes; the list's heading still names the project.
 */
const BESIDE_DRAWER = {
  columns: "xl:max-2xl:grid-cols-[minmax(0,1fr)]",
  projects: "xl:max-2xl:hidden",
} as const;

/** The projects, then the list given as children. `drawerOpen` says a record's drawer is open. */
export function ByProject(props: Choice & { drawerOpen: boolean; children: ReactNode }) {
  const { drawerOpen, children, ...choice } = props;
  return (
    <div className={cx(COLUMNS, drawerOpen && BESIDE_DRAWER.columns)}>
      <div className={cx(drawerOpen && BESIDE_DRAWER.projects)}>
        <Projects {...choice} />
      </div>
      {children}
    </div>
  );
}
