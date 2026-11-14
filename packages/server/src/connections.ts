/**
 * Which connection a request came on, for a client that sends no conversation id of its own.
 * Claude Code sends nothing that tells two of its processes apart, so the server could not tell a
 * process that has just started from the one that stopped a moment ago. What it does send is a
 * number: an MCP client numbers its requests from zero on each connection it opens, and one
 * process keeps one connection, its subagents included (seen with Claude Code 2.1.325). So a
 * connection is followed by its numbering, and its id stands where a conversation id would.
 *
 * Only a connection seen from its beginning is followed, and a beginning is one of the requests
 * a client opens with: its lists, never a tool call. A request that continues no connection and
 * begins none gets no id, and core lets a call without one go on in the session its client has
 * open. That is the case when the connection began before this server process did, when it went
 * quiet for longer than a session lasts, and for a client that opens a connection for every call
 * it makes: such a client is not a process starting anew each time.
 */
import { SESSION_IDLE_MS, type Clock, type IdGen } from "@uketsugi/core";

/**
 * How far past a connection's last number a request may be and still be its next. Requests sent
 * at once arrive in any order, and one that was refused before it got here took a number too.
 */
const REACH = 16;

/** The highest number the request a connection begins with may have: zero, or one where its handshake took zero. */
const BEGINS_BY = 1;

/** The most connections followed for one person; the one heard from longest ago is dropped first. */
const MOST = 64;

interface Connection {
  readonly id: string;
  readonly client: string;
  /** The number of its latest request. */
  last: number;
  /** The project its calls name, as they spell it; null until it has made one. */
  project: string | null;
  seenAt: number;
}

/** One request, as far as it says where it came from. */
export interface Arrival {
  readonly person: string;
  readonly client: string;
  /** The request's JSON-RPC id. Only a whole number is a place in a connection's numbering. */
  readonly number: unknown;
  /** Whether the request is a tool call. */
  readonly call: boolean;
  /** The project a tool call names, as it spells it; null for any other request, and for a call that names none. */
  readonly project: string | null;
}

export interface Connections {
  /** The id of the connection a request came on; null where the server did not see it begin. */
  of(arrival: Arrival): string | null;
}

/**
 * Whether a request can be the next on a connection: a number just past its last, from the same
 * client, and for a tool call the same project. Two processes at work in two repositories then
 * stay apart even while their numbers cross.
 */
function continues(connection: Connection, arrival: Arrival, number: number): boolean {
  const { project } = arrival;
  return (
    connection.client === arrival.client &&
    number > connection.last &&
    number - connection.last <= REACH &&
    (project === null || connection.project === null || connection.project === project)
  );
}

/**
 * The connection a request is the next on. The nearest below wins; of two as near, the one heard
 * from last, which is the one that has just started where the other is a process that stopped.
 * `live` has the one heard from last at its end.
 */
function continued(
  live: readonly Connection[],
  arrival: Arrival,
  number: number,
): Connection | undefined {
  let found: Connection | undefined;
  for (const connection of live.toReversed()) {
    const nearer = found === undefined || connection.last > found.last;
    if (nearer && continues(connection, arrival, number)) found = connection;
  }
  return found;
}

/** A request's place in a connection's numbering, where its id is one: a whole number from zero. */
function placeOf(id: unknown): number | null {
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? id : null;
}

/** The connections of one server process. None is kept past the time a session may stay quiet. */
export function createConnections(ports: { clock: Clock; ids: IdGen }): Connections {
  /** Each person's connections, the one heard from last at the end. */
  const byPerson = new Map<string, Connection[]>();
  return {
    of(arrival) {
      const { person, client, project } = arrival;
      const number = placeOf(arrival.number);
      if (number === null) return null;
      const seenAt = ports.clock.now().getTime();
      const live = (byPerson.get(person) ?? []).filter(
        (connection) => seenAt - connection.seenAt <= SESSION_IDLE_MS,
      );
      const known = continued(live, arrival, number);
      const begins = known === undefined && !arrival.call && number <= BEGINS_BY;
      const begun: Connection | undefined = begins
        ? { id: ports.ids.uuid(), client, last: number, project: null, seenAt }
        : undefined;
      const found = known ?? begun;
      const others = live.filter((connection) => connection !== found);
      if (found === undefined) {
        byPerson.set(person, others);
        return null;
      }
      found.last = number;
      found.project ??= project;
      found.seenAt = seenAt;
      byPerson.set(person, [...others, found].slice(-MOST));
      return found.id;
    },
  };
}
