import { expect, test } from "vitest";
import { resolveHome } from "../src/home.ts";
import { servingOf } from "../src/program.ts";
import { tempDir } from "./support.ts";

// No mock of the server package here, unlike `verbs.test.ts`: this is the constant itself.
test("a server on a data directory that was told nothing listens on port 7410, which the README and the Dockerfile give", async () => {
  const home = resolveHome(await tempDir(), {});

  expect((await servingOf(home, {})).port).toBe("7410");
});
