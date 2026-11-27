/**
 * What the model step's cases stand on: the use-case world with a scripted model in the server's
 * ports, a project and a worker of each case's own, and the session's end as a hook sends it. No
 * request leaves the machine: the runner is a stand-in a case scripts.
 */
import {
  createApp,
  createTokenIdentity,
  createWorker,
  type Chore,
  type CorePorts,
  type DigestReport,
  type ModelRunner,
  type Session,
  type TurnSide,
} from "@uketsugi/core";
import { FakeRunner, toolCaller, type ToolCaller } from "@uketsugi/testkit";
import { CLIENT, type World } from "./use-case-world.ts";

/** What a scripted model answers each step with; a step left out answers with nothing found. */
export interface Script {
  extract?: (given: { said: unknown[]; recorded: string[] }) => unknown;
  judge?: (given: { pairs: { n: number; a: string; b: string }[] }) => unknown;
  choose?: (given: { stopped: string; facts: { n: number; claim: string }[] }) => unknown;
}

/** A scripted model. It serves everyone unless `serves` says whom. */
export function scripted(script: Script, serves?: FakeRunner["serves"]): FakeRunner {
  const answer = (chore: Chore): unknown => {
    const given: unknown = JSON.parse(chore.material);
    if (chore.step === "digest.extract")
      return (
        script.extract?.(given as Parameters<NonNullable<Script["extract"]>>[0]) ?? { facts: [] }
      );
    if (chore.step === "digest.judge")
      return (
        script.judge?.(given as Parameters<NonNullable<Script["judge"]>>[0]) ?? { verdicts: [] }
      );
    return script.choose?.(given as Parameters<NonNullable<Script["choose"]>>[0]) ?? { show: [] };
  };
  return new FakeRunner(answer, serves);
}

/** A candidate as a model proposes it. */
export function candidate(claim: string, citations: string[], question = "", detail = "") {
  return { claim, question, citations, detail };
}

/** An agent's last message that names what it found and where. */
export const FOUND = [
  "I traced the retry path. The webhook queue retries a failed delivery five times with",
  "exponential backoff, capped at 30 seconds: see src/queue/retry.ts:40-62. Deliveries are",
  "deduplicated on the event id in src/queue/dedupe.ts. The cap was raised from 10 seconds in",
  "commit 4f2a9c1d because the payments provider throttles bursts.",
].join(" ");

let projects = 0;

/**
 * A project of a case's own on the world's host, the owner's calls in it on a server with this
 * model (or with none), and that server's worker.
 */
export function serverWith(w: World, runner: ModelRunner | undefined) {
  projects += 1;
  const project = `github.com/acme/digest-${projects}`;
  const ports: CorePorts = { ...w.portsWith(w.embedder), ...(runner ? { runner } : {}) };
  const reports: DigestReport[] = [];
  const failures: unknown[] = [];
  const worker = createWorker(ports, {
    onDigest: (report) => reports.push(report),
    onFailure: (_work, error) => failures.push(error),
  });
  const served: CorePorts = { ...ports, store: worker.store };
  const app = createApp({ ...served, identity: createTokenIdentity(served) });
  /** The conversation the owner's calls and its hook's words belong to. */
  const conversation = { client: CLIENT.name, id: `conversation-${projects}`, project };
  const call: ToolCaller = toolCaller(
    app,
    w.owner,
    { ...CLIENT, conversationId: conversation.id },
    project,
  );
  /** A conversation of the same person's that is not the one `call` speaks in. */
  const another: ToolCaller = toolCaller(
    app,
    w.owner,
    { ...CLIENT, conversationId: `${conversation.id}-next` },
    project,
  );
  /** A conversation of another harness of the same person's, in the same project. */
  const by = (client: string): ToolCaller =>
    toolCaller(app, w.owner, { ...CLIENT, name: client, conversationId: `${client}-1` }, project);
  /** What the agent last said, as its harness's hook sends it when a turn ends. */
  const note = (text: string) => app.noteSession(w.owner, conversation, text);
  /** One side of a turn, as a hook sends it where the person turned on sending each turn. */
  const turn = (side: TurnSide) => app.keepTurn(w.owner, conversation, side);
  /** The agent's last message and then the conversation's end, as a hook sends the two. */
  const end = async (text: string) => {
    await note(text);
    await app.endSession(w.owner, conversation);
  };
  const drain = async () => {
    while ((await worker.drain()) > 0);
  };
  const session = async (): Promise<Session> => {
    const { orgId, principalId } = w.owner;
    const latest = await w.store.sessions.latest(orgId, principalId, project);
    if (latest === null) throw new Error("the project has no session");
    return latest;
  };
  return {
    project,
    ports: served,
    call,
    another,
    by,
    note,
    turn,
    end,
    drain,
    stop: () => worker.stop(),
    session,
    reports,
    failures,
  };
}
