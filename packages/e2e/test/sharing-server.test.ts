/**
 * One server, two people, end to end over `/mcp`, `/api` and the dashboard's sign-in, with the
 * three credentials each doing only its own work: whoever runs the server adds a person with the
 * host's secret; each person chooses per project in a browser signed in with what no harness
 * holds; what one shares the other's agent finds, confirms, builds on and claims with its token;
 * what one keeps private no route shows the other; and a revoked credential stops while every
 * other goes on. On the embedded engine and on PostgreSQL.
 */
import {
  TREATMENT_TEXT,
  UNCHOSEN_NOTICE,
  type ActivityReport,
  type FactDetail,
  type FactPage,
  type Invitation,
  type PeopleList,
  type ProjectChoice,
  type ProjectList,
  type SearchFactsResult,
} from "@uketsugi/contracts";
import { connectMcp, type McpTestClient } from "@uketsugi/testkit";
import { afterAll, beforeAll, expect, test } from "vitest";
import { asHost, describeOnEachEngine, signIn, signInOnHost, type Host } from "./local-hosts.ts";

const ANN = "ukt_test_token_of_whoever_runs_the_server";
const PROJECT = "github.com/acme/billing-service";
const SECRET_CLAIM = "The staging database password rotates on Mondays";

/** What an invitation hands over, by what each secret is for. */
function secretsOf(invited: Invitation) {
  const of = (kind: "agent" | "person") =>
    invited.issued.find((entry) => entry.kind === kind) ?? { secret: "", id: "" };
  const [token, key] = [of("agent"), of("person")];
  return { bob: token.secret, bobsToken: token.id, bobsKey: key.secret, bobsKeyId: key.id };
}

describeOnEachEngine("two people on one server", (open) => {
  let hosted: Host;
  let url: string;
  /** Bob's harness token and its id, and the key that signs Bob himself in. */
  let bob = "";
  let bobsToken = "";
  let bobsKey = "";
  let bobsKeyId = "";
  let ann: McpTestClient;
  let agent: McpTestClient;
  const facts = { early: "", word: "", built: "" };
  let task = "";

  const json = { "content-type": "application/json" };
  const as =
    (token: string) =>
    (path: string, init: RequestInit = {}) =>
      fetch(`${url}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...json } });
  const post = (token: string, path: string, body: unknown = {}) =>
    as(token)(path, { method: "POST", body: JSON.stringify(body) });
  const read = async <T>(response: Promise<Response>): Promise<T> => (await response).json() as T;

  async function call<T = Record<string, unknown>>(by: McpTestClient, tool: string, args: object) {
    const result = await by.callTool(tool, { project: PROJECT, ...args });
    return { ...result, content: result.structuredContent as T };
  }

  /** A request as whoever runs the server, with the host's own secret. */
  const host = (path: string, body?: unknown) =>
    asHost(url)(path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
  /** A browser signed in to the dashboard with a person's own key; the operator's, by a link from the host. */
  const browser = (key: string) => signIn(url, key);
  const annsBrowser = () => signInOnHost(url);

  beforeAll(async () => {
    hosted = await open(ANN);
    url = hosted.server.url;
    ann = await connectMcp({
      url: `${url}/mcp`,
      token: ANN,
      client: { name: "ann-agent", version: "1" },
    });
  });

  afterAll(async () => {
    await agent.close();
    await ann.close();
    await hosted.close();
  });

  test("whoever runs the server adds a person, and lists each credential's kind, label, making and last use", async () => {
    const unnamed = await host("/api/people", { name: "bob" });
    expect(unnamed.status).toBe(422);
    expect(await unnamed.text()).toContain("has no name yet");
    const invited = await host("/api/people", {
      name: "bob",
      label: "bob's laptop",
      operator_name: "ann",
    });
    expect(invited.status).toBe(201);
    const first = (await invited.json()) as Invitation;
    expect(first).toMatchObject({
      person: "bob",
      added: true,
      issued: [{ kind: "agent", label: "bob's laptop" }, { kind: "person" }],
    });
    ({ bob, bobsToken, bobsKey, bobsKeyId } = secretsOf(first));
    agent = await connectMcp({
      url: `${url}/mcp`,
      token: bob,
      client: { name: "bob-agent", version: "1" },
    });
    expect((await call(agent, "search_facts", { query: "anything" })).isError).toBe(false);
    // Each secret does its own work only: the key calls nothing, and the token signs nobody in.
    expect((await as(bobsKey)("/api/projects")).status).toBe(401);
    expect((await browser(bob)).status).toBe(401);
    expect((await browser(bobsKey)).session.person).toBe("bob");

    const { people } = await read<PeopleList>(host("/api/people"));
    expect(people.map((person) => person.name)).toEqual(["ann", "bob"]);
    expect(people[0]?.tokens).toMatchObject([
      { kind: "agent", label: "given at start", revoked_at: null },
    ]);
    expect(people[1]?.tokens).toMatchObject([
      { id: bobsToken, kind: "agent", label: "bob's laptop", revoked_at: null },
      { id: bobsKeyId, kind: "person", label: "bob's dashboard key", revoked_at: null },
    ]);
    const { created_at: made, last_used_at: used } = people[1]?.tokens[0] ?? { created_at: "x" };
    expect(Date.parse(used ?? "")).toBeGreaterThanOrEqual(Date.parse(made));
    expect(JSON.stringify(people)).not.toContain(bob);
    expect(JSON.stringify(people)).not.toContain(bobsKey);
    // A name that is taken is not handed that person's memory: nothing is issued until it is said which.
    const again = await host("/api/people", { name: "Bob" });
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("bob is already on this server.");
  });

  test("what reaches every person's data or administers the server needs the host's own secret, which no harness holds", async () => {
    // A person's token, and the operator's own harness token, from this machine: all refused.
    for (const token of [bob, ANN, bobsKey]) {
      const tried = [
        as(token)("/api/backup"),
        as(token)("/api/people"),
        post(token, "/api/people", { name: "bob", another: "agent" }),
        post(token, "/api/people", { name: "mallory" }),
        post(token, `/api/tokens/${bobsToken}/revoke`),
        post(token, "/api/sign-in-codes"),
      ];
      for (const response of await Promise.all(tried)) {
        expect(response.status).toBe(403);
        expect(await response.text()).toContain("whoever runs the server");
      }
    }
    expect((await fetch(`${url}/api/backup`)).status).toBe(403);
    expect((await host("/api/backup")).status).toBe(hosted.snapshots ? 200 : 422);
    const { people } = await read<PeopleList>(host("/api/people"));
    expect(people.map((person) => [person.name, person.tokens.length])).toEqual([
      ["ann", 1],
      ["bob", 2],
    ]);
    // How much work waits is everyone's taken together: only the host is told.
    expect(await (await fetch(`${url}/healthz`)).json()).not.toHaveProperty("jobs");
    expect(await (await as(bob)("/healthz")).json()).not.toHaveProperty("jobs");
    expect(await (await host("/healthz")).json()).toHaveProperty("jobs");
  });

  test("a project is private until its person shares it in the dashboard, and no token alone can", async () => {
    const early = await call<{ id: string; treatment: string }>(ann, "publish_fact", {
      claim: "Invoice webhooks retry five times with exponential backoff",
      citations: ["services/billing/webhooks/retry.ts:41-88@a41d07c"],
    });
    expect(early.text).toContain(`project: ${PROJECT} · used here, private`);
    expect(early.text).toContain(UNCHOSEN_NOTICE);
    const word = await call<{ id: string }>(ann, "publish_fact", {
      claim: SECRET_CLAIM,
      citations: [{ kind: "person", who: "the on-call engineer" }],
    });
    [facts.early, facts.word] = [early.content.id, word.content.id];
    const before = await call<SearchFactsResult>(agent, "search_facts", {
      query: "webhooks retry",
    });
    expect(before.content).toMatchObject({ matched: 0, treatment: TREATMENT_TEXT.private });

    // The choice takes a signed-in browser, and a harness's token signs nobody in: the three
    // requests an agent would make with its token end at the first.
    const byToken = await post(ANN, "/api/projects/choice", {
      project: PROJECT,
      treatment: "shared",
    });
    expect(byToken.status).toBe(403);
    expect(await byToken.text()).toContain("a token is not enough");
    expect((await browser(ANN)).status).toBe(401);
    expect((await browser("ukp_not_a_key")).status).toBe(401);
    const hers = await annsBrowser();
    expect(hers).toMatchObject({ status: 303, session: { person: "ann" } });
    const chosen = await hers.choose(PROJECT, "shared");
    expect((await chosen.json()) as ProjectChoice).toEqual({
      project: PROJECT,
      treatment: "shared",
      moved: { facts: 1, tasks: 0 },
    });

    const after = await call<SearchFactsResult>(agent, "search_facts", {
      query: "webhooks retry",
    });
    expect(after.content.facts).toMatchObject([{ id: facts.early, author: "ann" }]);
    expect(after.text).toContain("by ann");
    expect(after.text).toContain(`project: ${PROJECT} · used here, private`);
    const next = await call<{ treatment: string }>(ann, "search_facts", {
      query: "webhooks retry",
    });
    expect(next.text).toContain(`project: ${PROJECT} · used here, shared`);
    expect(next.text).toContain("by you");
  });

  test("no route shows a person what another keeps private", async () => {
    const his = await browser(bobsKey);
    expect(his.session.person).toBe("bob");
    const everything = await Promise.all(
      [
        "/api/facts?limit=100",
        "/api/export",
        "/api/rulings",
        "/api/activity?days=1",
        "/api/projects",
      ].map(async (path) => (await his.get(path)).text()),
    );
    expect(everything.join("\n")).not.toContain(SECRET_CLAIM);
    expect(everything.join("\n")).not.toContain("ann-agent");
    expect((await his.get(`/api/facts/${facts.word}`)).status).toBe(404);
    const byId = await call<SearchFactsResult>(agent, "search_facts", { id: facts.word });
    expect(byId.content.matched).toBe(0);
    const cited = await call(agent, "publish_fact", {
      claim: "Passwords rotate weekly",
      citations: [{ kind: "fact", fact: facts.word }],
    });
    expect(cited.text).toContain("which is not visible here");

    const page = await read<FactPage>(his.get("/api/facts?limit=100"));
    expect(page.facts.map((fact) => [fact.id, fact.author, fact.audience])).toEqual([
      [facts.early, "ann", "shared"],
    ]);
    // Each fact says who sees it: its author reads which of hers the others can read.
    const own = await read<FactPage>((await annsBrowser()).get("/api/facts?limit=100"));
    expect(own.facts.map((fact) => [fact.id, fact.audience]).sort()).toEqual(
      [
        [facts.early, "shared"],
        [facts.word, "private"],
      ].sort(),
    );
    const mine = await read<ProjectList>(his.get("/api/projects"));
    expect(mine).toMatchObject({
      sharing: true,
      projects: [{ key: PROJECT, treatment: "private", chosen: false }],
    });
    const activity = await read<ActivityReport>(his.get("/api/activity?days=1"));
    expect(activity.clients.map((client) => client.client)).toEqual(["bob-agent"]);
    // Nothing of a fact's private past: its history starts for him where it was shared.
    const detail = await read<FactDetail>(his.get(`/api/facts/${facts.early}`));
    expect(detail.history.map((entry) => entry.kind)).toEqual(["FactShared"]);
    const hers = await read<FactDetail>((await annsBrowser()).get(`/api/facts/${facts.early}`));
    expect(hers.history.map((entry) => entry.kind).sort()).toEqual(["FactPublished", "FactShared"]);
  });

  test("the second person's agent confirms, builds on and claims what the first shared, once they share too", async () => {
    const published = await call<{ task: { id: string } }>(ann, "publish_task", {
      title: "Move the retry schedule into configuration",
    });
    task = published.content.task.id;
    const confirm = { id: facts.early, confirm: { checked: "read retry.ts at a41d07c" } };
    const early = await call(agent, "update_fact", confirm);
    expect(early.isError).toBe(true);
    expect(early.text).toContain("this project is private for your person");
    expect((await call(agent, "claim_task", { id: task })).isError).toBe(true);

    const his = await browser(bobsKey);
    expect(((await (await his.choose(PROJECT, "shared")).json()) as ProjectChoice).treatment).toBe(
      "shared",
    );
    const confirmed = await call<{ status: string }>(agent, "update_fact", confirm);
    expect(confirmed.content.status).toBe("confirmed");
    const built = await call<{ id: string; citations: { class: string }[] }>(
      agent,
      "publish_fact",
      {
        claim: "A webhook that fails five times is parked for a person to replay",
        citations: [{ kind: "fact", fact: facts.early }],
      },
    );
    expect(built.content.citations).toMatchObject([{ class: "checkable" }]);
    facts.built = built.content.id;
    const claimed = await call<{ lease: string }>(agent, "claim_task", { id: task });
    expect(claimed.isError).toBe(false);
    await call(agent, "update_task", {
      id: task,
      lease: claimed.content.lease,
      note: "Read from config now.",
    });

    const seen = await call<SearchFactsResult>(ann, "search_facts", {
      query: "webhook retries parked replay",
    });
    expect(seen.content.facts.map((fact) => [fact.id, fact.author, fact.trust]).sort()).toEqual(
      [
        [facts.built, "bob", "unreviewed"],
        [facts.early, "you", "reviewed"],
      ].sort(),
    );
    const held = await call<{ tasks: object[] }>(ann, "search_tasks", { id: task });
    expect(held.content.tasks).toMatchObject([{ holder: "bob", note: "Read from config now." }]);
  });

  test("a person changes their mind, and what they shared is theirs alone again", async () => {
    const hers = await annsBrowser();
    const back = (await (await hers.choose(PROJECT, "private")).json()) as ProjectChoice;
    expect(back).toMatchObject({ treatment: "private", moved: { facts: 1, tasks: 1 } });
    const found = await call<SearchFactsResult>(agent, "search_facts", {
      query: "webhook retries parked replay",
    });
    expect(found.content.facts.map((fact) => [fact.id, fact.flags])).toEqual([
      [facts.built, ["source_changed"]],
    ]);
    expect((await call(agent, "search_tasks", { id: task })).isError).toBe(true);
    const own = await call<SearchFactsResult>(ann, "search_facts", { id: facts.early });
    expect(own.content.facts).toMatchObject([{ status: "unconfirmed", author: "you" }]);
    expect(own.text).toContain(`project: ${PROJECT} · used here, private`);
  });

  test("one credential is revoked and stops, and every other one goes on working", async () => {
    const another = await host("/api/people", {
      name: "Bob",
      another: "agent",
      label: "bob's desktop",
    });
    const other = (await another.json()) as Invitation;
    expect(other).toMatchObject({
      person: "bob",
      added: false,
      issued: [{ kind: "agent", label: "bob's desktop" }],
    });
    const his = await browser(bobsKey);
    expect((await host("/api/tokens/not-a-token/revoke", {})).status).toBe(404);

    // His harness token goes: the tools and the token's reads stop, his dashboard does not.
    const revoked = await host(`/api/tokens/${bobsToken}/revoke`, {});
    expect(await revoked.json()).toEqual({ id: bobsToken, revoked: true });
    expect((await as(bob)("/api/projects")).status).toBe(401);
    expect(
      (await call(agent, "search_facts", { query: "anything" }).catch(() => null)) ?? {},
    ).not.toMatchObject({
      isError: false,
    });
    expect((await his.get("/api/projects")).status).toBe(200);
    expect((await as(other.issued[0]?.secret ?? "")("/api/projects")).status).toBe(200);
    expect((await as(ANN)("/api/projects")).status).toBe(200);

    // His key goes: the session it opened ends at once, and it signs nobody in again.
    expect(await (await host(`/api/tokens/${bobsKeyId}/revoke`, {})).json()).toMatchObject({
      revoked: true,
    });
    expect((await his.get("/api/projects")).status).toBe(401);
    expect((await browser(bobsKey)).status).toBe(401);
    expect((await as(other.issued[0]?.secret ?? "")("/api/projects")).status).toBe(200);
    const { people } = await read<PeopleList>(host("/api/people"));
    expect(people[1]?.tokens.map((token) => [token.kind, token.revoked_at !== null])).toEqual([
      ["agent", true],
      ["person", true],
      ["agent", false],
    ]);
    expect(await (await host(`/api/tokens/${bobsToken}/revoke`, {})).json()).toEqual({
      id: bobsToken,
      revoked: false,
    });
  });
});
