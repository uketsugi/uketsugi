import {
  NOTHING_FOUND,
  type FactDetail,
  type FactPage,
  type RulingList,
} from "@uketsugi/contracts";
import { eventually, type McpTestClient } from "@uketsugi/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PROJECT, startServer, type RunningServer } from "./running-server.ts";

/** Built at run time so that no secret-shaped literal sits in the repository. */
const TOKEN_IN_CLAIM = `ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`;

interface FactView {
  id: string;
  claim: string;
  status: string;
  flags: string[];
  superseded_by?: string;
  citations: { ref: string; class: string }[];
}

describe("the write path over /mcp: the scan, duplicates, corrections and redaction", () => {
  let server: RunningServer;
  let client: McpTestClient;
  /** The person's own browser: redacting and undoing a merge are theirs to do, not a token's. */
  let person: Awaited<ReturnType<RunningServer["browser"]>>;

  beforeAll(async () => {
    server = await startServer();
    client = await server.connect("write-path");
    person = await server.browser();
  });
  afterAll(() => server.close());

  async function call(tool: string, args: Record<string, unknown>) {
    const result = await client.callTool(tool, { project: PROJECT, ...args });
    expect(result.isError, result.text).toBe(false);
    return { text: result.text, content: result.structuredContent ?? {} };
  }
  const publish = async (claim: string, citations: unknown = "src/billing/retry.ts:41-88") =>
    (await call("publish_fact", { claim, citations })).content as {
      id: string;
      similar?: object[];
    };
  const byId = async (id: string) =>
    (await call("search_facts", { id })).content.facts as FactView[];
  const everything = async () =>
    [
      await (await server.api("/api/facts?limit=100")).text(),
      await (await server.api("/api/export")).text(),
    ].join("\n");
  /** Waits for the server's own worker to get to a job a call left behind. */
  function atLast<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
    return eventually(async () => {
      const value = await read();
      expect(done(value)).toBe(true);
      return value;
    }, 10);
  }

  test("a secret in a claim is replaced before anything is stored, and the result says so", async () => {
    const published = await call("publish_fact", {
      claim: `The deploy job authenticates with ${TOKEN_IN_CLAIM}`,
      detail: "Ask alice.smith@corp.io before rotating it.",
      citations: [{ kind: "web", url: `https://ci.corp.io/jobs/7?token=${TOKEN_IN_CLAIM}` }],
    });
    expect(published.content).toMatchObject({
      created: true,
      redacted: [
        { field: "claim", rule: "github-token" },
        { field: "detail", rule: "email" },
        { field: "citations[0].url", rule: "github-token" },
      ],
    });
    expect(published.text).toContain("redacted before storing: claim (github-token)");
    expect(published.text).not.toContain(TOKEN_IN_CLAIM);

    const [stored] = await byId(String(published.content.id));
    expect(stored?.claim).toBe("The deploy job authenticates with [redacted:github-token]");
    const found = await call("search_facts", { query: `deploy job ${TOKEN_IN_CLAIM}` });
    expect(JSON.stringify(found.content)).not.toContain(TOKEN_IN_CLAIM);
    const held = await everything();
    expect(held).toContain("[redacted:github-token]");
    expect(held).not.toContain(TOKEN_IN_CLAIM);
    expect(held).not.toContain("alice.smith");
  });

  test("a duplicate merges into the better fact under a ruling, and the ruling reverts", async () => {
    const first = await publish("Dunning retries a declined card on days one, three and five");
    server.clock.advance(1_000);
    const second = await publish(
      "dunning retries a declined card on days one, three, and five.",
      "docs/dunning.md#L4-L9",
    );
    expect(second.similar).toMatchObject([{ id: first.id }]);

    const merged = await atLast(
      () => byId(first.id),
      (facts) => facts.length === 2,
    );
    expect(merged).toMatchObject([
      { id: first.id, status: "superseded", superseded_by: second.id },
      { id: second.id, status: "unconfirmed" },
    ]);
    expect(merged[1]?.citations.map((citation) => citation.ref)).toEqual([
      "docs/dunning.md:4-9",
      "src/billing/retry.ts:41-88",
    ]);
    const { rulings } = (await (await server.api("/api/rulings")).json()) as RulingList;
    const ruling = rulings.find((entry) => entry.fact === first.id);
    expect(ruling).toMatchObject({
      decision: "merge_duplicate",
      actor: "consolidate",
      runner: "rules",
      revertible: true,
    });

    const reverted = await person.post(`/api/rulings/${ruling?.id}/revert`);
    expect(await reverted.json()).toEqual({ id: ruling?.id, reverted: true });
    expect(await byId(first.id)).toMatchObject([{ id: first.id, status: "unconfirmed" }]);
    const [kept] = await byId(second.id);
    expect(kept?.citations.map((citation) => citation.ref)).toEqual(["docs/dunning.md:4-9"]);
    const after = (await (await server.api("/api/rulings")).json()) as RulingList;
    expect(after.rulings[0]).toMatchObject({ decision: "revert", actor: "you", revertible: false });
  });

  test("a chain of three merges names its live fact in every result, and a revert moves only its own link", async () => {
    const chain: string[] = [];
    for (const mark of ["", ".", "!"]) {
      server.clock.advance(1_000);
      const previous = chain.at(-1);
      chain.push((await publish(`Uploads are scanned before storage${mark}`)).id);
      if (previous !== undefined)
        await atLast(
          () => byId(previous),
          (found) => found.length === 2,
        );
    }
    const [a = "", b = "", c = ""] = chain;
    /** What a search by id and the dashboard's list each name as the fact that replaced `a`. */
    const shown = async () => {
      const page = (await (await server.api("/api/facts?limit=100")).json()) as FactPage;
      const row = page.facts.find((fact) => fact.id === a);
      return { named: [(await byId(a))[0]?.superseded_by, row?.superseded_by], row };
    };
    const before = await shown();
    expect(before.named).toEqual([c, c]);
    const exported = await (await server.api("/api/export")).text();
    expect(exported.split(`- Superseded by: ${c}`)).toHaveLength(3);
    const update = await client.callTool("update_fact", { project: PROJECT, id: a, detail: "x" });
    expect(update.text).toContain(`Send the update to ${c}`);
    const again = { claim: "Uploads are scanned twice", citations: "a.ts:1", supersedes: a };
    const correction = await client.callTool("publish_fact", { project: PROJECT, ...again });
    expect(correction.text).toContain(`Pass ${c} as supersedes`);
    const citing = await call("publish_fact", { claim: "Quarantine follows", citations: [a] });
    expect(citing.content.citations).toMatchObject([{ ref: `fact ${c}` }]);

    const { rulings } = (await (await server.api("/api/rulings")).json()) as RulingList;
    const merge = rulings.find((entry) => entry.fact === b);
    await person.post(`/api/rulings/${merge?.id}/revert`);
    const after = await shown();
    expect(after.named).toEqual([b, b]);
    expect(after.row).toEqual({ ...before.row, superseded_by: b });
  });

  /** Publishes wordings of one claim in turn, each with its own citation, and waits for each merge. */
  async function mergedInTurn(wordings: readonly (readonly [string, string])[]): Promise<string[]> {
    const ids: string[] = [];
    for (const [claim, citation] of wordings) {
      server.clock.advance(1_000);
      const previous = ids.at(-1);
      ids.push((await publish(claim, citation)).id);
      if (previous !== undefined)
        await atLast(
          () => byId(previous),
          (found) => found.length === 2,
        );
    }
    return ids;
  }
  const refsOf = async (id: string) =>
    (await byId(id)).at(-1)?.citations.map((citation) => citation.ref);

  test("redacting a fact that was merged away takes its citations out of the fact that took them", async () => {
    const said = ["Dana said the quokka quorum is five", "Lee saw the quokka quorum hold at five"];
    const [first = "", second = "", third = ""] = await mergedInTurn([
      ["The quokka service needs a quorum of five", said[0] ?? ""],
      ["the quokka service needs a quorum of five.", said[1] ?? ""],
      ["The quokka service needs a quorum of five!", "src/quokka/quorum.ts:3"],
    ]);
    expect(await refsOf(first)).toEqual(["src/quokka/quorum.ts:3", said[1], said[0]]);

    const redacted = await person.post(`/api/facts/${second}/redact`);
    expect(await redacted.json()).toEqual({ id: second, redacted: true });
    expect(await refsOf(third)).toEqual(["src/quokka/quorum.ts:3"]);
    const held = await everything();
    expect(held).not.toContain("Dana said");
    expect(held).not.toContain("Lee saw");
    expect(held).toContain("The quokka service needs a quorum of five!");
  });

  test("merges reverted oldest first leave each fact with its own citation and no other's", async () => {
    const [first = "", second = "", third = ""] = await mergedInTurn([
      ["Thumbnails are rendered at three sizes", "docs/thumbs-a.md:1"],
      ["thumbnails are rendered at three sizes.", "docs/thumbs-b.md:1"],
      ["Thumbnails are rendered at three sizes!", "docs/thumbs-c.md:1"],
    ]);
    const all = ["docs/thumbs-c.md:1", "docs/thumbs-b.md:1", "docs/thumbs-a.md:1"];
    expect(await refsOf(first)).toEqual(all);
    const { rulings } = (await (await server.api("/api/rulings")).json()) as RulingList;
    for (const merged of [first, second]) {
      const ruling = rulings.find((entry) => entry.fact === merged);
      const reverted = await person.post(`/api/rulings/${ruling?.id}/revert`);
      expect(await reverted.json()).toEqual({ id: ruling?.id, reverted: true });
    }
    expect(await refsOf(first)).toEqual(["docs/thumbs-a.md:1"]);
    expect(await refsOf(second)).toEqual(["docs/thumbs-b.md:1"]);
    expect(await refsOf(third)).toEqual(["docs/thumbs-c.md:1"]);
  });

  test("an author's update flags the fact that cites the one it changed", async () => {
    const source = await publish("Proration credits the unused days of the old plan");
    const citing = await call("publish_fact", {
      claim: "An upgrade mid-cycle never refunds to the card",
      citations: [source.id],
    });
    expect(citing.content.citations).toMatchObject([{ kind: "fact", class: "checkable" }]);

    const updated = await call("update_fact", {
      id: source.id,
      claim: "Proration credits the unused days of the old plan, computed to the day in UTC",
    });
    expect(updated.content).toMatchObject({ id: source.id, status: "unconfirmed" });
    const [flagged] = await byId(String(citing.content.id));
    expect(flagged).toMatchObject({ flags: ["source_changed"] });
    const [changed] = await byId(source.id);
    expect(changed?.claim).toContain("computed to the day in UTC");
  });

  test("a redaction leaves a stub and nothing an agent or the dashboard can read", async () => {
    const fact = await publish("The zyzzyva signer holds the quarterly export key");
    const found = await call("search_facts", { query: "zyzzyva signer" });
    expect(found.content).toMatchObject({ shown: 1 });

    const redacted = await person.post(`/api/facts/${fact.id}/redact`);
    expect(await redacted.json()).toEqual({ id: fact.id, redacted: true });
    const gone = await call("search_facts", { query: "zyzzyva signer" });
    expect(gone.content).toMatchObject({ matched: 0, shown: 0 });
    expect(gone.text.split("\n")[0]).toBe(NOTHING_FOUND);
    expect(await byId(fact.id)).toEqual([]);
    const detail = (await (await server.api(`/api/facts/${fact.id}`)).json()) as FactDetail;
    expect(detail.fact).toMatchObject({ redacted: true, claim: null, citations: [] });
    const { facts } = (await (await server.api("/api/facts?limit=100")).json()) as FactPage;
    expect(facts.find((entry) => entry.id === fact.id)).toMatchObject({ redacted: true });
    const filtered = await server.api("/api/facts?project=not%20a%20project");
    expect(filtered.status).toBe(422);
    expect(detail.history[0]?.kind).toBe("FactRedacted");
    expect(await everything()).not.toContain("zyzzyva");
  });
});
