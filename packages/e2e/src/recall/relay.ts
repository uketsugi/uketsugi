/**
 * Byte relays between a sandbox with no network and the host. Each port a sandbox may reach is a unix
 * socket in one folder (bound into the sandbox at /run/ukt): the host half (`serveUnixToTcp`) connects
 * every connection to a socket to `127.0.0.1:<port>`, and inside the sandbox `relay-inside.ts` listens
 * on a loopback port and forwards to the socket.
 */
import { createServer, connect, type Socket } from "node:net";
import { rm } from "node:fs/promises";

export interface Relay {
  close(): void;
}

/** Host side: a connection to the socket at `path` is a connection to `127.0.0.1:port`. */
export async function serveUnixToTcp(path: string, port: number): Promise<Relay> {
  await rm(path, { force: true });
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect({ host: "127.0.0.1", port });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return {
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
