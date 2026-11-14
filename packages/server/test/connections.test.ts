import { SESSION_IDLE_MS } from "@uketsugi/core";
import { FakeClock, FakeIdGen } from "@uketsugi/testkit";
import { describe, expect, test } from "vitest";
import { createConnections } from "../src/connections.ts";

const API = "github.com/acme/api";
const WEB = "github.com/acme/web";

/**
 * A harness process as the server sees one: every request numbered from zero, the two lists it
 * opens with first (Claude Code 2.1.325 sends `prompts/list` as 0 and `tools/list` as 1).
 */
function world() {
  const clock = new FakeClock();
  const connections = createConnections({ clock, ids: new FakeIdGen() });
  const start = (project: string, person = "person", client = "claude-code") => {
    let number = 0;
    const send = (named: string | null, at = number) =>
      connections.of({ person, client, number: at, call: named !== null, project: named });
    const next = (named: string | null) => {
      const id = send(named);
      number += 1;
      return id;
    };
    next(null);
    next(null);
    return {
      /** A tool call in the process's project; its connection's id. */
      call: () => next(project),
      /** A request that names no project: a command's text, say. */
      ask: () => next(null),
      /** The request with this number, out of turn. */
      send: (at: number, named: string | null = project) => send(named, at),
      skip: (requests: number) => void (number += requests),
    };
  };
  return { clock, connections, start };
}

describe("the connection a request came on", () => {
  test("one process is one connection, from its first request to its last", () => {
    const { start } = world();
    const process = start(API);
    const first = process.call();
    expect(first).not.toBeNull();
    expect([process.call(), process.ask(), process.call()]).toEqual([first, first, first]);
  });

  test("a process that starts after another stopped is a connection of its own, wherever the first one's numbers ended", () => {
    for (const earlier of [1, 3, 9]) {
      for (const commands of [0, 1, 2]) {
        const { start, clock } = world();
        const stopped = start(API);
        const before = Array.from({ length: earlier }, () => stopped.call()).at(-1);
        clock.advance(2000);
        const started = start(API);
        for (let typed = 0; typed < commands; typed += 1) started.ask();
        const after = started.call();
        expect(after, `${earlier} calls, then ${commands} commands`).not.toBeNull();
        expect(after, `${earlier} calls, then ${commands} commands`).not.toBe(before);
        expect(started.call()).toBe(after);
      }
    }
  });

  test("two processes at work in two projects stay apart while their numbers cross", () => {
    const { start } = world();
    const api = start(API);
    const inApi = api.call();
    const web = start(WEB);
    const inWeb = web.call();
    expect(inWeb).not.toBe(inApi);
    // Whichever sends next at each step, a call is taken for its own project's connection.
    for (let step = 0; step < 6; step += 1) {
      expect(api.call()).toBe(inApi);
      expect(web.call()).toBe(inWeb);
      expect(web.call()).toBe(inWeb);
    }
    expect(api.call()).toBe(inApi);
  });

  test("two processes that start together are two connections", () => {
    const { connections } = world();
    const send = (number: number, project: string | null) =>
      connections.of({
        person: "person",
        client: "claude-code",
        number,
        call: project !== null,
        project,
      });
    // Their opening requests arrive interleaved.
    for (const number of [0, 0, 1, 1]) send(number, null);
    const one = send(2, API);
    const other = send(2, WEB);
    expect(one).not.toBeNull();
    expect(other).not.toBeNull();
    expect(other).not.toBe(one);
    expect([send(3, API), send(3, WEB)]).toEqual([one, other]);
  });

  test("requests sent at once stay on their connection in whatever order they arrive", () => {
    const { start } = world();
    const process = start(API);
    const id = process.call();
    expect([process.send(5), process.send(3), process.send(4)]).toEqual([id, null, null]);
    process.skip(3);
    expect(process.call()).toBe(id);
  });

  test("a request that continues no connection and begins none has no connection", () => {
    const { start, connections } = world();
    // A server that has just started hears from a process that has long been running.
    const call = { person: "person", client: "claude-code", call: true, project: API };
    expect(connections.of({ ...call, number: 57 })).toBeNull();
    // So does one that knows another process only.
    const known = start(WEB);
    known.call();
    expect(known.send(40, API)).toBeNull();
    expect(known.send(3, API)).toBeNull();
  });

  test("a connection is forgotten once it has been quiet for longer than a session lasts", () => {
    const { start, clock } = world();
    const process = start(API);
    const id = process.call();
    clock.advance(SESSION_IDLE_MS);
    expect(process.call()).toBe(id);
    clock.advance(SESSION_IDLE_MS + 1);
    expect(process.call()).toBeNull();
  });

  test("people and clients are followed apart, and only a whole number is a place in the numbering", () => {
    const { start, connections } = world();
    const mine = start(API).call();
    expect(start(API, "another person").call()).not.toBe(mine);
    expect(start(API, "person", "another client").call()).not.toBe(mine);
    const asked = { person: "person", client: "x", call: false, project: null };
    for (const number of ["server-discover-probe-1", 1.5, -1, null, undefined]) {
      expect(connections.of({ ...asked, number })).toBeNull();
    }
  });

  test("a tool call begins no connection: a client that connects anew for every call is not a process starting each time", () => {
    const { connections } = world();
    const call = { person: "person", client: "a-script", call: true, project: API };
    // Each call arrives as the first request of a connection of its own, numbered from zero.
    expect([0, 1, 0, 1].map((number) => connections.of({ ...call, number }))).toEqual([
      null,
      null,
      null,
      null,
    ]);
    // A request that is no call does begin one, and the calls after it are its own.
    const begun = connections.of({ ...call, call: false, project: null, number: 0 });
    expect(begun).not.toBeNull();
    expect(connections.of({ ...call, number: 1 })).toBe(begun);
  });
});
