/** The rows a fact's text gives, kept beside it for search and for doubt: its identifiers and the facts it cites. */
import type { Db } from "./codec.ts";

/**
 * Writes the rows a fact's text gives, for each of `factIds`: the identifiers it holds and the
 * facts it cites. Each list given replaces that table's rows; one left out is left as it is. A
 * redaction gives both empty, for every fact it takes the text of.
 */
export async function writeDerived(
  db: Db,
  orgId: string,
  factIds: readonly string[],
  derived: { readonly idents?: readonly string[]; readonly citedFacts?: readonly string[] },
): Promise<void> {
  const ids = [...factIds];
  const { idents, citedFacts } = derived;
  const given = [
    ...(idents === undefined ? [] : ["factIdents" as const]),
    ...(citedFacts === undefined ? [] : ["citedFacts" as const]),
  ];
  for (const table of given)
    await db.deleteFrom(table).where("orgId", "=", orgId).where("factId", "in", ids).execute();
  const identRows = ids.flatMap((factId) =>
    [...new Set(idents)].map((ident) => ({ orgId, factId, ident })),
  );
  const citedRows = ids.flatMap((factId) =>
    [...new Set(citedFacts)].map((citedFact) => ({ orgId, factId, citedFact })),
  );
  if (identRows.length > 0) await db.insertInto("factIdents").values(identRows).execute();
  if (citedRows.length > 0) await db.insertInto("citedFacts").values(citedRows).execute();
}
