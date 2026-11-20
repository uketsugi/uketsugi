/**
 * Run inside a sandbox by its own wrapper: `node relay-inside.ts <port>:<socket> ...` listens on each
 * loopback port and forwards its connections to the unix socket, so that an address such as
 * http://127.0.0.1:7410 means the same inside and outside.
 */
import { createServer, connect } from "node:net";

for (const pair of process.argv.slice(2)) {
  const [port, path] = pair.split(":");
  createServer((client) => {
    const upstream = connect(String(path));
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  }).listen(Number(port), "127.0.0.1");
}
