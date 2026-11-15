import { join } from "node:path";
import type * as embed from "@uketsugi/embed";
import { expect, test, vi } from "vitest";
import { resolveHome } from "../src/home.ts";
import { modelPart } from "../src/setup-parts.ts";
import { fakeIo, tempDir } from "./support.ts";

// A directory that holds the model, as its files verify: the pinned files are a 170 MB download.
vi.mock("@uketsugi/embed", async (original) => ({
  ...(await original<typeof embed>()),
  verifyModel: () => Promise.resolve({ ok: true, model: "the-model" }),
  installModel: () => Promise.reject(new Error("nothing is to be installed")),
}));

test("set-up does not say it installs a model that is in place", async () => {
  const home = resolveHome(join(await tempDir(), "data"), {});
  const titles: string[] = [];
  const io = {
    ...fakeIo(),
    progress: (title: string) => (
      titles.push(title),
      { update: () => undefined, stop: () => undefined }
    ),
  };

  const part = await modelPart(io, home, true);

  expect(part).toMatchObject({ pending: false, apply: null, state: "present" });
  expect(part.plan).toEqual([`in place, in ${home.modelDir}`]);
  expect(titles).toEqual([]);
});
