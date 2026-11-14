/**
 * Activity: what the sessions of each client name and version did, then the recent rulings. A
 * session is counted once in each column it earned: it searched, it published, it had a call
 * refused for a missing project.
 */
import type { ActivityClient, ActivityReport } from "@uketsugi/contracts";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useTable } from "@tanstack/react-table";
import { activityQuery } from "../api.ts";
import { Page } from "../shell.tsx";
import { columnsFor, DataTable, features } from "../table.tsx";
import { buttonClass, Card, Empty, ErrorPanel, FILTER_LINK, Loading } from "../ui.tsx";
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
        {activity.isPending ? (
          <Loading what="activity" />
        ) : activity.isError ? (
          <div className="p-4">
            <ErrorPanel error={activity.error} onRetry={() => void activity.refetch()} />
          </div>
        ) : (
          <Clients report={activity.data} />
        )}
      </Card>
      <Rulings />
    </Page>
  );
}
