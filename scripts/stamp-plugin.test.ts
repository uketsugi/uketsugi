import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { MANIFEST, stamped } from "./stamp-plugin.ts";

const manifest = readFileSync(
  join(import.meta.dirname, "../packages/server/plugins", MANIFEST),
  "utf8",
);

test("the plugin's manifest in the tree names no version; a release's names the one it is built under", () => {
  expect(JSON.parse(manifest)).not.toHaveProperty("version");
  const built = JSON.parse(stamped(manifest, "0.3.0+abc1234")) as Record<string, unknown>;
  expect(built).toMatchObject({ name: "uketsugi", version: "0.3.0+abc1234" });
  expect(built).toEqual({ ...(JSON.parse(manifest) as object), version: "0.3.0+abc1234" });
});
