/**
 * Activity: what the sessions of each client name and version did, then the sessions a language
 * model read, where the server has one, and the recent rulings. A session is counted once in each
 * column it earned: it searched, it published, it had a call refused for a missing project.
 */
import type { ActivityClient, ActivityReport, ActivitySession } from "@uketsugi/contracts";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useTable } from "@tanstack/react-table";
import { activityQuery } from "../api.ts";
import { Page } from "../shell.tsx";
import { columnsFor, DataTable, features } from "../table.tsx";
import { Ago, buttonClass, Card, Empty, FILTER_LINK, QueryState } from "../ui.tsx";
import { Rulings } from "./rulings.tsx";

const route = getRouteApi("/activity");

/** The periods the page offers, in days, and the one a bare address shows. Each is asked for by number. */
export const PERIODS = [1, 7, 30, 90] as const;
const DEFAULT_PERIOD = 7;

const column = columnsFor<ActivityClient>();

const columns = column.columns([
  column.accessor("client", { header: "Client" }),
  column.accessor((row) => row.version ?? "", {
    id: "version",
    header: "Version",
    cell: (cell) => (cell.getValue() === "" ? "not sent" : cell.getValue()),
  }),
  column.accessor("sessions", { header: "Sessions" }),
  column.accessor("searched", { header: "Searched" }),
  column.accessor("published", { header: "Published" }),
  column.accessor("refused", { header: "Refused for a missing project" }),
]);

function Clients({ report }: { report: ActivityReport }) {
  const table = useTable({ features, columns, data: report.clients });
  if (report.clients.length === 0) {
    return (
      <Empty sentence="No agent has connected yet">
        <Link to="/connect" className={buttonClass({ tone: "primary" })}>
          Connect an agent
        </Link>
      </Empty>
    );
  }
  const since = new Date(report.since).toLocaleDateString(undefined, { dateStyle: "medium" });
  return <DataTable table={table} caption={`Sessions by client since ${since}`} />;
}

/** A session the language model was given something of to read. */
type ReadSession = ActivitySession & { digest: NonNullable<ActivitySession["digest"]> };

const readColumn = columnsFor<ReadSession>();

const readColumns = readColumn.columns([
  readColumn.accessor("session", { header: "Session" }),
  readColumn.accessor("client", { header: "Client" }),
  readColumn.accessor((row) => row.project ?? "", { id: "project", header: "Project" }),
  readColumn.accessor((row) => row.digest.at ?? "", {
    id: "read",
    header: "Read",
    cell: (cell) => (cell.getValue() === "" ? "not yet" : <Ago at={cell.getValue()} />),
  }),
  readColumn.accessor((row) => row.digest.input_tokens, { id: "in", header: "Tokens in" }),
  readColumn.accessor((row) => row.digest.output_tokens, { id: "out", header: "Tokens out" }),
  readColumn.accessor((row) => row.digest.failure?.reason ?? "", {
    id: "provider",
    header: "Provider",
    cell: (cell) => (cell.getValue() === "" ? "" : `Failed or refused: ${cell.getValue()}`),
  }),
]);

/**
 * The person's recent sessions that the server's language model read once they were over, with
 * what each reading cost. On a server with no such model there are none, and nothing is shown.
 */
function ReadByModel({ sessions }: { sessions: ActivitySession[] }) {
  const read = sessions.filter((session): session is ReadSession => session.digest !== null);
  const table = useTable({ features, columns: readColumns, data: read });
  if (read.length === 0) return null;
  return (
    <Card label="Sessions a language model read">
      <h2 className="px-4 pt-4 font-semibold">Sessions a language model read</h2>
      <p className="px-4 pb-2 text-ink-muted">
        Once a session is over, the model this server was given reads what its agent said and writes
        down what the agent did not. The facts it wrote say so on the Facts page. Where the provider
        failed or refused the call (a key or an account it refuses), the reading waits, is tried
        again, and is given up after twelve hours: the provider's words are shown beside it.
      </p>
      <DataTable table={table} caption="Your recent sessions a language model read" />
    </Card>
  );
}

function Periods() {
  return (
    <nav aria-label="Period" className="flex flex-wrap gap-2">
      {PERIODS.map((days) => (
        <Link
          key={days}
          to="/activity"
          search={{ days: days === DEFAULT_PERIOD ? undefined : days }}
          activeOptions={{ exact: true }}
          className={FILTER_LINK}
        >
          {days === 1 ? "1 day" : `${days} days`}
        </Link>
      ))}
    </nav>
  );
}

export function ActivityPage() {
  const { days = DEFAULT_PERIOD } = route.useSearch();
  const activity = useQuery(activityQuery(days));
  return (
    <Page
      title="Activity"
      lead="What your agents' sessions did, and what was ruled on their facts."
    >
      <Periods />
      <Card label="Sessions by client">
        <h2 className="px-4 pt-4 pb-2 font-semibold">Sessions by client</h2>
        <QueryState query={activity} what="activity" inset="p-4">
          {(data) => <Clients report={data} />}
        </QueryState>
      </Card>
      {activity.data === undefined ? null : <ReadByModel sessions={activity.data.recent} />}
      <Rulings />
    </Page>
  );
}
