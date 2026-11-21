/**
 * The product that is no product: the arm with no memory. It serves nothing (a port of 0 is no
 * server), installs nothing, delivers nothing, and runs the same sessions as any other row.
 */
import type { Adapter } from "./adapter.ts";

export const none: Adapter = {
  name: "none",
  memory: { call: [], touch: [] },
  boilerplate: [],
  configurations: ["none"],
  session: () => ({ allowedTools: "" }),
  serve: () =>
    Promise.resolve({ port: 0, url: "", stop: () => Promise.resolve(), exit: () => null }),
  seed: () => Promise.resolve(0),
  install: () => Promise.resolve([]),
  afterSession: () => Promise.resolve(),
  readStore: () => Promise.resolve([]),
  deliveries: () => [],
};
