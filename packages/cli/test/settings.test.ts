import { Command } from "commander";
import { expect, test } from "vitest";
import { keepSettings, readSettings, resolveHome } from "../src/home.ts";
import { serving, servingOf, toldOf } from "../src/program.ts";
import { SERVING, SERVING_KEYS, type Serving } from "../src/settings.ts";
import { tempDir } from "./support.ts";

/** A value of each kind the table can hold, so a setting added to the table needs nothing here. */
const SAMPLE = { text: "7777", names: ["one.example", "two.example"], flag: true } as const;
const everySetting = Object.fromEntries(
  SERVING_KEYS.map((key) => [key, SAMPLE[SERVING[key].kind]]),
) as Serving;

test("every setting in the table is an option of `ukt setup`, carried by what a verb was told, kept, read back and used by a start", async () => {
  const command = serving(new Command());
  expect(command.options.map((option) => option.long)).toEqual(
    SERVING_KEYS.map((key) => SERVING[key].option.split(" ")[0]),
  );

  expect(toldOf({ ...everySetting, dataDir: "x" } as Serving)).toEqual(everySetting);
  const home = resolveHome(await tempDir(), {});
  expect(await keepSettings(home, everySetting)).toBe(true);
  expect(await readSettings(home)).toMatchObject(everySetting);
  expect(await servingOf(home, {})).toMatchObject(everySetting);
});
