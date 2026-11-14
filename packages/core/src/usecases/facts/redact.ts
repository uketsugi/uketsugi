import { eventBy, idOf, personActor, scopeOf } from "../../context.ts";
import type { Caller } from "../../domain.ts";
import { giveBackOf } from "../../facts/rulings.ts";
import { forbidden, notFound } from "../../failure.ts";
import type { CorePorts } from "../../ports.ts";
import { asPerson, holderOfFact } from "../../sharing.ts";
import { settle } from "./place.ts";
import { flagCiting } from "./write.ts";

/**
 * A person's redaction of their own fact (flow F9): one unit takes its text out of every structure
 * that holds it, and out of every fact it superseded, leaves stubs, writes one event per stub and
 * flags the facts that cite them. A fact that was merged away left its citations in the facts
 * ahead of it in its chain: they give them back in the same unit, and the later merges' events
 * lose the hashes of what they gave. Which facts those are is read inside the unit, where the
 * fact is found again as it stands by then, so a merge or a move that landed a moment before is
 * not missed. The chain it leaves is then put where it now belongs. The fact it was merged into
 * keeps its own text: that fact is redacted by itself. It cannot be undone; the person may
 * publish again. Redacting a fact that is already a stub changes nothing.
 */
export async function redactFact(
  ports: Pick<CorePorts, "store" | "clock" | "ids" | "embedder">,
  caller: Caller,
  input: { readonly id: string },
): Promise<{ id: string; redacted: true }> {
  const scope = scopeOf(caller);
  const fact = await ports.store.facts.get(scope, idOf(input.id));
  if (fact === null) throw notFound("listed fact", input.id);
  if (fact.author !== caller.principalId) {
    throw forbidden(
      `Fact ${fact.id} is another person's.`,
      "Only its author can redact it; flag it if it should not stand.",
    );
  }
  const by = { actor: personActor(caller), session: null };
  const who = { caller, project: fact.project, at: ports.clock.now() };
  await asPerson(ports, who, async (place) => {
    // The shared head first, if there is one: what follows may write rows that name shared facts.
    await place.shared();
    // Found again under the lock: the fact may have changed audience, or been merged, since it was read.
    const held = await holderOfFact(place, fact.id);
    if (held === null) throw notFound("listed fact", input.id);
    const { writes } = held;
    const owed = await giveBackOf(writes, held.fact);
    for (const id of await writes.facts.redact(fact.id)) {
      await writes.append(eventBy(by, "FactRedacted", id));
      await flagCiting(ports, writes, null, id);
    }
    await owed.apply(ports, place.at);
    await settle(
      ports,
      place,
      owed.ahead.map((ahead) => ahead.id),
    );
  });
  return { id: fact.id, redacted: true };
}
