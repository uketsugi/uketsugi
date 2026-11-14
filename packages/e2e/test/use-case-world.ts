/**
 * What the use-case tests stand on: a store of their own on each host, a clock the test moves,
 * counted ids, a stand-in model, and the calls of the store's owner, through the request pipeline
 * with no server between. The cases run on the embedded store, and on a PostgreSQL server when one
 * is given (see testkit's `postgres.ts`).
 */
import {
  createApp,
  createTokenIdentity,
  createWorker,
  ensureOwner,
  scopeOf,
  type App,
  type Caller,
  type CorePorts,
  type Embedder,
  type Fact,
  type ReadScope,
  type Store,
  type StoredEvent,
} from "@uketsugi/core";
import { openLocalPorts } from "@uketsugi/server";
import {
  createTestDatabase,
  FakeClock,
  FakeEmbedder,
  FakeIdGen,
  SAMPLE_PROJECT,
  TEST_POSTGRES_URL,
  toolCaller,
  type Called,
  type ToolCaller,
} from "@uketsugi/testkit";
import { afterAll, beforeAll, describe } from "vitest";

export const PROJECT = SAMPLE_PROJECT;
export const CLIENT = { name: "use-cases", version: null, conversationId: null };

/** A store of the test's own, and what lets go of it. */
interface Host {
  readonly store: Store;
  close(): Promise<void>;
}

async function embedded(): Promise<Host> {
  const local = await openLocalPorts({});
  return { store: local.ports.store, close: () => local.close() };
}

async function onServer(): Promise<Host> {
  const database = await createTestDatabase();
  const local = await openLocalPorts({ databaseUrl: database.url });
  return {
    store: local.ports.store,
    async close() {
      await local.close();
      await database.drop();
    },
  };
}

/** What a host's opening sets: read these inside a test, never while the tests are collected. */
interface Opened {
  readonly store: Store;
  readonly owner: Caller;
  readonly scope: ReadScope;
  /** The pipeline of a host with no model. */
  readonly app: App;
}

export interface World extends Opened {
  readonly clock: FakeClock;
  readonly ids: FakeIdGen;
  readonly embedder: FakeEmbedder;
  /** The owner's calls on a host with no model, and on one with the stand-in model. */
  readonly plain: ToolCaller;
  readonly embedding: ToolCaller;
  readonly portsWith: (model: Embedder | null) => CorePorts;
  readonly callsOn: (ports: CorePorts) => ToolCaller;
  readonly publish: (
    claim: string,
    citations?: unknown,
    as?: ToolCaller,
  ) => Promise<Called<"publish_fact">>;
  readonly factOf: (id: string) => Promise<Fact>;
  readonly eventsOf: (id: string) => Promise<StoredEvent[]>;
  readonly flagsOf: (id: string) => Promise<string[]>;
  /** Takes every job that is due off the queue and returns the kinds of those about one fact. */
  readonly takeJobs: (subject: string) => Promise<string[]>;
  /** Runs the jobs as a server does: a job a handler leaves is run too. */
  readonly runJobs: (ports: CorePorts) => Promise<void>;
}

function worldOn(open: () => Promise<Host>): World {
  const clock = new FakeClock();
  const ids = new FakeIdGen(23);
  const embedder = new FakeEmbedder();
  let host: Host | undefined;
  let opened: (Opened & { plain: ToolCaller; embedding: ToolCaller }) | undefined;
  const now = () => {
    if (opened === undefined) throw new Error("the host is read before it has opened");
    return opened;
  };

  const portsWith = (model: Embedder | null): CorePorts => ({
    store: now().store,
    clock,
    ids,
    embedder: model,
  });
  const appOf = (ports: CorePorts): App =>
    createApp({ ...ports, identity: createTokenIdentity(ports) });
  const callsOn = (ports: CorePorts): ToolCaller =>
    toolCaller(appOf(ports), now().owner, CLIENT, PROJECT);
  const plain: ToolCaller = (tool, args) => now().plain(tool, args);

  beforeAll(async () => {
    host = await open();
    const { store } = host;
    const without = { store, clock, ids, embedder: null };
    const owner = await ensureOwner(without);
    const app = appOf(without);
    const calls = (on: App) => toolCaller(on, owner, CLIENT, PROJECT);
    opened = {
      store,
      owner,
      scope: scopeOf(owner),
      app,
      plain: calls(app),
      embedding: calls(appOf({ ...without, embedder })),
    };
  });
  afterAll(() => host?.close());

  return {
    clock,
    ids,
    embedder,
    get store() {
      return now().store;
    },
    get owner() {
      return now().owner;
    },
    get scope() {
      return now().scope;
    },
    get app() {
      return now().app;
    },
    plain,
    embedding: (tool, args) => now().embedding(tool, args),
    portsWith,
    callsOn,
    publish: (claim, citations = "src/retry.ts:10-20", as = plain) =>
      as("publish_fact", { claim, citations }),
    async factOf(id) {
      const fact = await now().store.facts.get(now().scope, id);
      if (fact === null) throw new Error(`fact ${id} is not readable`);
      return fact;
    },
    async eventsOf(id) {
      const { store, scope, owner } = now();
      const events = await store.review.events(scope, owner.privateAudienceId, 0, 500);
      return events.filter((event) => event.subject === id);
    },
    flagsOf: async (id) =>
      (await now().store.review.openFlags(now().scope, [id])).map((flag) => flag.kind),
    async takeJobs(subject) {
      const { jobs } = now().store;
      const claimed = await jobs.claim(clock.now(), 1_000, 500);
      for (const job of claimed) await jobs.complete(job);
      return claimed.filter((job) => job.subject === subject).map((job) => job.kind);
    },
    async runJobs(ports) {
      const worker = createWorker(ports);
      while ((await worker.drain()) > 0);
    },
  };
}

/** Runs the cases on each host, each on a store of its own. */
export function describeUseCases(title: string, cases: (world: World) => void): void {
  describe(`${title} on the embedded store`, () => cases(worldOn(embedded)));
  describe.runIf(TEST_POSTGRES_URL !== "")(`${title} on a PostgreSQL server`, () =>
    cases(worldOn(onServer)),
  );
}
