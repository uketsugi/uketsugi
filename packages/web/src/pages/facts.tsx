/**
 * Facts: every fact the person can see, by project, newest first or by a search inside one
 * project. A row opens the fact's drawer, and the list keeps its place behind it.
 */
import { Input } from "@base-ui/react/input";
import type { ApiFact, ApiProject } from "@uketsugi/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useTable } from "@tanstack/react-table";
import { cx } from "class-variance-authority";
import { useMemo, type FormEvent } from "react";
import { exportHref, factsQuery } from "../api.ts";
import { ByProject, SeenByMark } from "../by-project.tsx";
import { Page } from "../shell.tsx";
import { columnsFor, DataTable, features, ShowMore } from "../table.tsx";
import {
  Ago,
  Button,
  buttonClass,
  Card,
  Empty,
  FlagMarks,
  QueryState,
  StatusMark,
  ToSay,
} from "../ui.tsx";
import { FactDrawer } from "./fact-drawer.tsx";

const route = getRouteApi("/facts");

/** What an empty Facts page offers: something to ask an agent. */
const FIRST_QUESTION = "How does this project build and run its tests?";

const NO_FACTS: ApiFact[] = [];

function FactCell({ fact }: { fact: ApiFact }) {
  const { project } = route.useSearch();
  const count = fact.citations.length;
  // The words break anywhere, so that a long project key never makes the table wider than its card.
  return (
    <div className="space-y-1 wrap-anywhere">
      <Link
        to="/facts"
        search={(shown) => ({ ...shown, fact: fact.id })}
        className={cx(
          "rounded-sm font-medium hover:underline",
          fact.claim === null && "text-ink-muted italic",
        )}
      >
        {fact.claim ?? "Redacted fact"}
      </Link>
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-ink-muted">
        {count === 1 ? "1 citation" : `${count} citations`} · by {fact.author}
        {fact.from_session === null ? "" : `, written by a model from session ${fact.from_session}`}
        {project === undefined ? ` · ${fact.project}` : ""}
        <SeenByMark audience={fact.audience} group={fact.group} />
        <FlagMarks flags={fact.flags} />
      </p>
    </div>
  );
}

const column = columnsFor<ApiFact>();

const columns = column.columns([
  column.display({
    id: "fact",
    header: "Fact",
    cell: ({ row }) => <FactCell fact={row.original} />,
  }),
  column.display({
    id: "status",
    header: "Status",
    cell: ({ row }) => <StatusMark fact={row.original} />,
  }),
  column.display({
    id: "checked",
    header: "Checked",
    cell: ({ row }) =>
      row.original.confirmed_at === null ? (
        <span className="text-ink-muted">not yet</span>
      ) : (
        <Ago at={row.original.confirmed_at} />
      ),
  }),
]);

/** One project's line under its name: its key when it has a display name, and how much it holds. */
function holds(project: ApiProject): string {
  const count = project.facts === 1 ? "1 fact" : `${project.facts} facts`;
  return project.name === null ? count : `${project.key} · ${count}`;
}

function SearchForm({ project, q }: { project: string; q: string | undefined }) {
  const navigate = route.useNavigate();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const typed = new FormData(event.currentTarget).get("q");
    const next = typeof typed === "string" && typed.trim() !== "" ? typed.trim() : undefined;
    void navigate({ search: (shown) => ({ ...shown, q: next }) });
  };
  return (
    <form role="search" key={`${project} ${q ?? ""}`} onSubmit={submit} className="flex gap-2">
      <Input
        type="search"
        name="q"
        defaultValue={q}
        aria-label={`Search facts in ${project}`}
        placeholder="Search facts…"
        className="h-7 w-64 max-w-full rounded-md border border-line-strong bg-surface px-2.5 placeholder:text-ink-muted"
      />
      <Button type="submit" size="sm">
        Search
      </Button>
    </form>
  );
}

function ListHeader({ project, q }: { project: string | undefined; q: string | undefined }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
      <h2 className="mr-auto font-semibold break-all">{project ?? "All projects"}</h2>
      {project === undefined ? (
        <p className="text-ink-muted">Choose a project to search its facts.</p>
      ) : (
        <SearchForm project={project} q={q} />
      )}
      <a href={exportHref(project)} download className={buttonClass({ size: "sm" })}>
        Export as Markdown
      </a>
    </div>
  );
}

function NoFacts({ q }: { q: string | undefined }) {
  if (q !== undefined) return <Empty sentence={`Nothing matched “${q}”.`} />;
  return (
    <Empty sentence="Facts appear here when your agents publish what they establish">
      <ToSay text={FIRST_QUESTION} label="a first question to ask an agent" />
    </Empty>
  );
}

function FactList() {
  const { project, q: typed, fact: open } = route.useSearch();
  const q = project === undefined ? undefined : typed;
  const list = useInfiniteQuery(factsQuery({ project, q }));
  const pages = list.data?.pages;
  const facts = useMemo(() => pages?.flatMap((page) => page.facts) ?? NO_FACTS, [pages]);
  const table = useTable({ features, columns, data: facts, getRowId: (fact) => fact.id });
  const matched = pages?.[0]?.matched;
  const shown = facts.length === 1 ? "1 fact shown" : `${facts.length} facts shown`;
  return (
    <Card label="Facts">
      <ListHeader project={project} q={q} />
      <QueryState query={list} what="facts" inset="p-4">
        {() =>
          facts.length === 0 ? (
            <NoFacts q={q} />
          ) : (
            <>
              <DataTable
                table={table}
                caption={q === undefined ? "Facts, newest first" : `Facts matching “${q}”`}
                current={(fact) => fact.id === open}
              />
              <ShowMore
                shown={matched === undefined ? shown : `${matched} matched · ${shown}`}
                more={list.hasNextPage ? () => void list.fetchNextPage() : undefined}
                waiting={list.isFetchingNextPage}
              />
            </>
          )
        }
      </QueryState>
    </Card>
  );
}

export function FactsPage() {
  const { project, fact } = route.useSearch();
  const drawerOpen = fact !== undefined;
  return (
    <Page
      title="Facts"
      lead="What agents have established, by project. Each fact carries where it comes from."
      drawerOpen={drawerOpen}
    >
      <ByProject page="/facts" chosen={project} about={holds} drawerOpen={drawerOpen}>
        <FactList />
      </ByProject>
      <FactDrawer />
    </Page>
  );
}
