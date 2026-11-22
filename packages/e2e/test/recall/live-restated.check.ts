/**
 * What counts as stored: a fact that restates what the person said was stored, and the patterns must
 * say so. Each sentence the person is told in `live.json` is restated below as a fact in other words
 * (written for this check, not an agent's text), and each restatement must match its item's pattern;
 * the patterns must match none of the records that only look like the item. The kept agents' facts
 * and notes of the smoke run, labelled by hand for all five items, are held the same way when
 * `UKT_LIVE_LABELS` names their file (`handoff/lanes/live-build/work/labels.json`).
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { loadItems, patternOf } from "../../src/recall/items.ts";

const RESTATED: Record<string, string[]> = {
  P1: [
    "ChanServ's messages that nobody asked for are NOTICEs whose line starts with the channel name in square brackets, as registered.",
    "Anything ChanServ says unprompted goes out as a NOTICE beginning with [#Channel], not only the entry message.",
    "Rule: every unrequested ChanServ message, as opposed to a reply to a command, is a NOTICE prefixed with the channel in square brackets.",
    'Standing rule for ChanServ: anything it says to people that nobody asked for goes out as a NOTICE, and the line starts with the channel name in square brackets as registered, for example "[#Lobby] Welcome!". This applies to every unprompted ChanServ message, not only the entry message.',
  ],
  D2: [
    "Any ChanServ command made staff-only must send a server notice to the other operators each time it is used: STAFF <account> <COMMAND> <#channel>.",
    "Staff-only ChanServ commands announce each use on the channels snomask as `STAFF <account> <COMMAND> <#channel>`.",
    "When a staff-only command is used, the other operators are told with a server notice on the channels mask.",
  ],
  D1: [
    "ChanServ shows new dates and times in RFC 3339 in UTC, e.g. 2026-11-17T09:30:00Z; NOTE LIST keeps its own format.",
    "Everything new that ChanServ displays with a date and time uses RFC 3339 in UTC; notes are the one exception.",
    "New ChanServ timestamps are RFC3339 UTC (notes excepted).",
  ],
  D3: [
    "Whenever ChanServ tells a founder about something staff did, it names them only as `network staff`, never the account.",
    "Founders are only ever told 'network staff' when staff act on their channel, not which staff member.",
    "Staff actions are reported to the channel founder as `network staff` instead of the staff account.",
  ],
  D8: [
    "The server truncates any line it sends at 512 bytes, so long NOTICE text is cut.",
    "Outgoing IRC lines longer than 512 bytes are silently truncated.",
  ],
};

describe("a restated told sentence is a stored fact", async () => {
  const items = await loadItems();
  for (const [name, records] of Object.entries(RESTATED)) {
    test(`${name}: each of ${records.length} restatements matches its pattern`, () => {
      const rx = patternOf(items[name] as never) as RegExp;
      expect(records.filter((r) => !rx.test(r))).toEqual([]);
    });
  }

  test("no restatement of one item matches another item's pattern, except where one fact states two", () => {
    const stray = Object.entries(RESTATED).flatMap(([name, records]) =>
      Object.keys(RESTATED)
        .filter((other) => other !== name)
        .flatMap((other) =>
          records
            .filter((r) => (patternOf(items[other] as never) as RegExp).test(r))
            .map((r) => `${name} restatement matches ${other}: ${r.slice(0, 60)}`),
        ),
    );
    expect(stray).toEqual([]);
  });
});

interface Hand {
  readonly items: readonly string[];
  readonly records: readonly { id: string; text: string; states: readonly string[] }[];
}

const FILE = process.env["UKT_LIVE_LABELS"];
const hand: Hand | undefined =
  FILE !== undefined && existsSync(FILE)
    ? (JSON.parse(readFileSync(FILE, "utf8")) as Hand)
    : undefined;

if (hand === undefined) {
  test.skip("the hand labels of the smoke run's stored facts are absent (set UKT_LIVE_LABELS to handoff/lanes/live-build/work/labels.json)", () => {});
}

describe.skipIf(hand === undefined)(
  "the patterns agree with the hand labels of the smoke run's records",
  async () => {
    const items = await loadItems();
    const labelled = hand as Hand;
    test("every record is labelled, for every item, and each pattern says what its label says", () => {
      expect(labelled.items).toEqual(["P1", "D2", "D1", "D3", "D8"]);
      const disagree = labelled.records.flatMap((r) =>
        labelled.items
          .filter(
            (item) =>
              (patternOf(items[item] as never) as RegExp).test(r.text) !== r.states.includes(item),
          )
          .map(
            (item) =>
              `${r.id} ${item}: label ${r.states.includes(item) ? "states" : "does not state"} it`,
          ),
      );
      expect(disagree).toEqual([]);
      expect(labelled.records.length).toBeGreaterThanOrEqual(9);
    });
  },
);
