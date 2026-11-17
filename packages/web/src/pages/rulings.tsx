/**
 * Recent rulings, on Activity: each decision a person or a job made about a fact, who made it and
 * why, with its own revert. A ruling that cannot be undone has none.
 */
import type { ApiRuling } from "@uketsugi/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTable } from "@tanstack/react-table";
import { Undo2 } from "lucide-react";
import { createContext, use } from "react";
import { refreshFacts, revertRuling, rulingsQuery } from "../api.ts";
import { useSession } from "../shell.tsx";
import { columnsFor, DataTable, features } from "../table.tsx";
import {
  Ago,
  Button,
  Card,
  Empty,
  ErrorPanel,
  inWords,
  Mark,
  QueryState,
  type Look,
} from "../ui.tsx";

/** How a row asks for its ruling to be reverted, and which ruling is being reverted now. */
const Reverting = createContext<{ revert: (id: string) => void; pending?: string }>({
  revert: () => undefined,
});

const REVERTED: Look = { tone: "neutral", icon: Undo2 };

function RevertCell({ ruling }: { ruling: ApiRuling }) {
  const { revert, pending } = use(Reverting);
  if (ruling.reverted_by !== null) return <Mark look={REVERTED}>reverted</Mark>;
  if (!ruling.revertible) return null;
  return (
    <Button
      size="sm"
      disabled={pending !== undefined}
      aria-label={`Revert ${inWords(ruling.decision)} of fact ${ruling.fact}`}
      onClick={() => revert(ruling.id)}
    >
      Revert
    </Button>
  );
}

const column = columnsFor<ApiRuling>();

const columns = column.columns([
  column.display({
    id: "decision",
    header: "Ruling",
    cell: ({ row }) => inWords(row.original.decision),
  }),
  column.display({
    id: "fact",
    header: "Fact",
    cell: ({ row }) => (
      <Link
        to="/facts"
        search={{ fact: row.original.fact }}
        className="rounded-sm font-mono text-[0.8125rem] break-all underline"
      >
        {row.original.fact}
      </Link>
    ),
  }),
  column.display({
    id: "actor",
    header: "Decided by",
    cell: ({ row }) =>
      row.original.runner === undefined
        ? row.original.actor
        : `${row.original.actor} · ${row.original.runner}`,
  }),
  column.display({
    id: "reasons",
    header: "Reason",
    cell: ({ row }) => row.original.reasons.map(inWords).join(", "),
  }),
  column.display({ id: "at", header: "When", cell: ({ row }) => <Ago at={row.original.at} /> }),
  column.display({
    id: "revert",
    header: "Revert",
    cell: ({ row }) => <RevertCell ruling={row.original} />,
  }),
]);

const NO_RULINGS: ApiRuling[] = [];

export function Rulings() {
  const session = useSession();
  const client = useQueryClient();
  const rulings = useQuery(rulingsQuery);
  const revert = useMutation({
    mutationFn: (id: string) => revertRuling(id, session.csrf),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: rulingsQuery.queryKey }),
        refreshFacts(client),
      ]),
  });
  const table = useTable({
    features,
    columns,
    data: rulings.data?.rulings ?? NO_RULINGS,
    getRowId: (ruling) => ruling.id,
  });
  const said = !revert.isSuccess
    ? ""
    : revert.data.reverted
      ? "The ruling was reverted."
      : "That ruling had been reverted already.";
  return (
    <Card label="Recent rulings">
      <h2 className="px-4 pt-4 pb-2 font-semibold">Recent rulings</h2>
      <p role="status" className="px-4 pb-2 text-ink-muted empty:hidden">
        {said}
      </p>
      {revert.isError ? (
        <div className="px-4 pb-3">
          <ErrorPanel error={revert.error} />
        </div>
      ) : null}
      <QueryState query={rulings} what="rulings" inset="p-4">
        {(data) =>
          data.rulings.length === 0 ? (
            <Empty sentence="No ruling has been made yet" />
          ) : (
            <Reverting
              value={{
                revert: revert.mutate,
                pending: revert.isPending ? revert.variables : undefined,
              }}
            >
              <DataTable table={table} caption="Recent rulings, newest first" />
            </Reverting>
          )
        }
      </QueryState>
    </Card>
  );
}
