/**
 * One table for every list: TanStack Table holds the columns, the rows and the sort order; this
 * file draws them as a real `<table>` with a caption, column headers and `aria-sort`.
 */
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
  type Header,
  type ReactTable,
  type RowData,
} from "@tanstack/react-table";
import { cx } from "class-variance-authority";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Button } from "./ui.tsx";

export const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
});

type Features = typeof features;

/** The column helper for rows of `TData`, bound to the features every table here uses. */
export function columnsFor<TData extends RowData>() {
  return createColumnHelper<Features, TData>();
}

const SORT = {
  asc: { aria: "ascending", icon: ArrowUp },
  desc: { aria: "descending", icon: ArrowDown },
} as const;

function HeaderCell<TData extends RowData>(props: {
  table: ReactTable<Features, TData>;
  header: Header<Features, TData, unknown>;
}) {
  const { table, header } = props;
  const sorted = header.column.getIsSorted();
  const label = <table.FlexRender header={header} />;
  const Icon = sorted === false ? ArrowUpDown : SORT[sorted].icon;
  return (
    <th
      scope="col"
      aria-sort={sorted === false ? undefined : SORT[sorted].aria}
      className="border-b border-line px-4 py-2 text-xs font-semibold tracking-wide text-ink-muted uppercase"
    >
      {header.column.getCanSort() ? (
        <button
          type="button"
          onClick={header.column.getToggleSortingHandler()}
          className="inline-flex cursor-pointer items-center gap-1 rounded-sm uppercase hover:text-ink"
        >
          {label}
          <Icon aria-hidden className="size-3" />
        </button>
      ) : (
        label
      )}
    </th>
  );
}

interface DataTableProps<TData extends RowData> {
  readonly table: ReactTable<Features, TData>;
  /** What the table lists, for a screen reader. */
  readonly caption: string;
  /** The row a drawer is open on, if any. */
  readonly current?: (row: TData) => boolean;
}

export function DataTable<TData extends RowData>({
  table,
  caption,
  current,
}: DataTableProps<TData>) {
  return (
    <table className="w-full border-collapse text-left">
      <caption className="sr-only">{caption}</caption>
      <thead>
        {table.getHeaderGroups().map((group) => (
          <tr key={group.id}>
            {group.headers.map((header) => (
              <HeaderCell key={header.id} table={table} header={header} />
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr
            key={row.id}
            className={cx(
              "border-b border-line last:border-b-0",
              current?.(row.original) === true && "bg-accent-soft",
            )}
          >
            {row.getAllCells().map((cell) => (
              <td key={cell.id} className="px-4 py-2.5 align-top tabular-nums">
                <table.FlexRender cell={cell} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The line under a list: how many rows it shows of how many matched, and the button that shows
 * more, where `more` says there are more to ask for. `waiting` keeps it from being pressed twice.
 */
export function ShowMore(props: { shown: string; more?: () => void; waiting: boolean }) {
  return (
    <div className="flex items-center gap-3 border-t border-line px-4 py-2.5 text-ink-muted">
      <p role="status">{props.shown}</p>
      {props.more === undefined ? null : (
        <Button size="sm" disabled={props.waiting} onClick={props.more}>
          Show more
        </Button>
      )}
    </div>
  );
}
