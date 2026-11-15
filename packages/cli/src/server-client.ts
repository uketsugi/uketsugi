/**
 * The verbs' side of the running server: who is serving this data directory, and the few routes
 * the command line calls on it. Every failure comes back in the three parts.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  isApiError,
  type CapabilityDescriptor,
  type ConnectInfo,
  MCP_REVISIONS,
  type HostProof,
  type Invitation,
  type InviteRequest,
  type PeopleList,
  type ProjectList,
  type SignInCode,
  type TokenRevoked,
} from "@uketsugi/contracts";
import { hostProof } from "@uketsugi/server";
import { readHostKey, readRecord, readToken, type Home, type ServerRecord } from "./home.ts";
import { CliFailure, describe } from "./report.ts";

/** How long a request to the local server may take before it counts as no answer. */
const ANSWER_WITHIN_MS = 10_000;
/** How long the question "is a server there?" waits. */
const PROBE_WITHIN_MS = 3_000;
/** How long the server may take to copy a whole store. */
const SNAPSHOT_WITHIN_MS = 300_000;

/** A server that left a record, and the token to call it with. */
export interface Running extends ServerRecord {
  readonly token: string;
}

/** One request to the server. A refusal or silence becomes a `CliFailure`. */
async function request(
  server: ServerRecord,
  path: string,
  init: RequestInit = {},
  within: number = ANSWER_WITHIN_MS,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(new URL(path, server.url), {
      ...init,
      signal: AbortSignal.timeout(within),
    });
  } catch (error) {
    throw new CliFailure({
      what: `The server at ${server.url} did not answer (${describe(error)}).`,
      meaning: "A server left its record in the data directory, but nothing answers there now.",
      next: "If `ukt serve` is still running, stop it; then start it again.",
    });
  }
  if (response.ok) return response;
  const body: unknown = await response.json().catch(() => undefined);
  if (isApiError(body)) {
    const { what, meaning, next } = body.error;
    throw new CliFailure({ what, meaning, next });
  }
  throw new CliFailure({
    what: `The server at ${server.url} answered ${response.status} to ${path}.`,
    meaning:
      response.status === 401
        ? "It does not accept this data directory's token."
        : "It could not do what this command asked.",
    next:
      response.status === 401
        ? "Restart `ukt serve`: it takes up the token when it starts."
        : "Check that the server and this `ukt` are the same version (`ukt --version`), then restart `ukt serve`.",
  });
}

const signed = (server: Running): RequestInit => ({
  headers: { authorization: `Bearer ${server.token}`, accept: "application/json" },
});

/** What the server says of itself. Nobody needs to be signed in to ask. */
export async function capabilities(
  server: ServerRecord,
  within?: number,
): Promise<CapabilityDescriptor> {
  return (await (
    await request(server, "/api/capabilities", {}, within)
  ).json()) as CapabilityDescriptor;
}

/**
 * The server that holds this data directory right now: its record, if something answers there.
 * A record left by a server that was killed is not one. The store's own lock is what keeps a
 * second process out; this only lets a verb say so before it starts.
 */
export async function servingNow(home: Home): Promise<ServerRecord | null> {
  const record = await readRecord(home);
  if (record === null) return null;
  return capabilities(record, PROBE_WITHIN_MS).then(
    () => record,
    () => null,
  );
}

/**
 * What listens at an address, as far as a data directory can tell: its own server, something
 * else, or nothing. Its own server proves itself with a keyed digest of bytes made up here, which
 * only a holder of the host's secret can give, and which shows the secret to no one. A server
 * that died leaves its record behind, and a port is anyone's to listen on.
 */
export async function whoAnswers(home: Home, url: string): Promise<"own" | "other" | "nobody"> {
  const key = await readHostKey(home);
  const challenge = randomBytes(32).toString("hex");
  const path = `/api/host-proof?${new URLSearchParams({ challenge }).toString()}`;
  let response: Response;
  try {
    response = await fetch(new URL(path, url), { signal: AbortSignal.timeout(PROBE_WITHIN_MS) });
  } catch (error) {
    // Something that takes the connection and says nothing is there all the same.
    return error instanceof Error && error.name === "TimeoutError" ? "other" : "nobody";
  }
  const given = await response.json().then(
    (body: unknown) => (body as Partial<HostProof> | null)?.proof,
    () => undefined,
  );
  if (key === null || typeof given !== "string") return "other";
  const [proof, expected] = [Buffer.from(given), Buffer.from(hostProof(key, challenge))];
  return proof.length === expected.length && timingSafeEqual(proof, expected) ? "own" : "other";
}

/** Makes whatever answers at a recorded address prove it is this host's own server, before anything secret is sent there. */
async function requireOwnServer(home: Home, record: ServerRecord): Promise<void> {
  if ((await whoAnswers(home, record.url)) === "own") return;
  throw new CliFailure({
    what: `What answers at ${record.url} is not the server of the data directory ${home.dataDir}.`,
    meaning:
      "A server left its record there and is gone, and something else may be listening on its port. Nothing secret was sent to it.",
    next: "Start the server again with `ukt serve`, then run this again.",
  });
}

/**
 * The record and the host's secret of the server running on a data directory, once the server
 * has proven it is that one; or a failure that says how to get there.
 */
async function running(home: Home): Promise<{ record: ServerRecord; key: string }> {
  const record = await readRecord(home);
  if (record === null)
    throw new CliFailure({
      what: `No server is running on the data directory ${home.dataDir}.`,
      meaning: "This command asks the running server, so it did nothing.",
      next: "Start the server in another terminal with `ukt serve`, then run this again.",
    });
  const key = await readHostKey(home);
  if (key === null)
    throw new CliFailure({
      what: `There is no host secret in ${home.hostKeyFile}.`,
      meaning:
        "The server on this data directory was not started by this `ukt`, so it cannot be asked from here.",
      next: "Stop the server and start it again with `ukt serve`: it makes the secret when it starts.",
    });
  await requireOwnServer(home, record);
  return { record, key };
}

/**
 * The running server of a data directory, to be asked as whoever runs it: with the host's own
 * secret, which administering the server takes and no harness holds.
 */
export async function connectAsHost(home: Home): Promise<Running> {
  const { record, key } = await running(home);
  return { ...record, token: key };
}

/** The running server of a data directory with its token, or a failure that says how to get there. */
export async function connect(home: Home): Promise<Running> {
  const { record } = await running(home);
  const token = await readToken(home);
  if (token === null)
    throw new CliFailure({
      what: `There is no token in ${home.tokenFile}.`,
      meaning: "The server cannot be asked without it.",
      next: "Stop `ukt serve`, run `ukt setup`, then start the server and run this again.",
    });
  return { ...record, token };
}

/** What the Connect page shows this machine's shell: the address, whether a harness here sends a token, and each harness's lines. */
export async function connectInfo(server: Running): Promise<ConnectInfo> {
  return (await (await request(server, "/api/connect", signed(server))).json()) as ConnectInfo;
}

/**
 * Asks `/mcp` for its tools as a harness added by the address does: sent with the token only
 * where the server says a harness here must send one. A refusal is the server's own words. It
 * leaves no record, which a tool call would (every tool names a project). Sent as the 2025-11-25
 * revision, which a server serves with no handshake first.
 */
export async function toolsListed(server: Running, info: ConnectInfo): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_REVISIONS[0],
    ...(info.needs_token ? { authorization: `Bearer ${server.token}` } : {}),
  };
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const response = await request(server, "/mcp", { method: "POST", headers, body });
  const text = await response.text();
  const answered = /^data: (.*)$/m.exec(text)?.[1] ?? text;
  const tools = (JSON.parse(answered) as { result?: { tools?: unknown[] } }).result?.tools;
  if (!Array.isArray(tools) || tools.length === 0)
    throw new CliFailure({
      what: `The server did not list its tools: ${answered.slice(0, 300)}`,
      meaning: "It runs, but a harness added by its address would find no tools.",
      next: "`ukt doctor` shows what else is wrong.",
    });
}

/** The person's projects: an answer proves the token is accepted and the store answers. */
export async function projects(server: Running): Promise<ProjectList> {
  return (await (await request(server, "/api/projects", signed(server))).json()) as ProjectList;
}

/** A code that signs a browser in to the dashboard once. */
export async function signInCode(server: Running): Promise<SignInCode> {
  const init = { ...signed(server), method: "POST" };
  return (await (await request(server, "/api/sign-in-codes", init)).json()) as SignInCode;
}

/** One project's facts as a Markdown document. */
export async function exportMarkdown(server: Running, project: string): Promise<string> {
  const path = `/api/export?${new URLSearchParams({ project }).toString()}`;
  return (await request(server, path, signed(server))).text();
}

/** Everyone on the server with their tokens: for whoever runs it. */
export async function people(server: Running): Promise<PeopleList> {
  return (await (await request(server, "/api/people", signed(server))).json()) as PeopleList;
}

/** Adds a person with a first token, or issues another token to one who is there. */
export async function invite(server: Running, input: InviteRequest): Promise<Invitation> {
  const { headers } = signed(server);
  const init = {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(input),
  };
  return (await (await request(server, "/api/people", init)).json()) as Invitation;
}

/** Ends one token; the others go on working. */
export async function revoke(server: Running, tokenId: string): Promise<TokenRevoked> {
  const path = `/api/tokens/${encodeURIComponent(tokenId)}/revoke`;
  const init = { ...signed(server), method: "POST" };
  return (await (await request(server, path, init)).json()) as TokenRevoked;
}

/** A snapshot of the whole store, taken by the server while it serves. */
export async function snapshot(server: Running): Promise<Blob> {
  return (await request(server, "/api/backup", signed(server), SNAPSHOT_WITHIN_MS)).blob();
}
