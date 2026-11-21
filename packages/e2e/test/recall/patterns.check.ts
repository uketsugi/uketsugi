/**
 * The patterns of the items that miscounted, held to labelled records: each must match the records
 * that state its item and must not match the ones that only look like it. The records here are
 * written for this check in the words the product's records use; they are not an agent's text. The
 * full set (agents' records from kept runs, labelled by reading) is not published: set
 * `UKT_RECALL_LABELS` to its `labels.json` to hold the patterns to it too.
 *
 * D8 needs the cutting (the server cuts the lines it sends at the limit, with no error), or that long
 * text must go out as several NOTICEs because of it; a record that only says a greeting is split to
 * fit the limit does not state it.
 *
 * What went wrong before: P1 counted a record of the greeting's own format and missed the rule;
 * D3 counted any record that says "network staff"; D8 counted a limit on what clients send in; D13
 * counted "as registered" in `RegisteredChannel`, a channel's name, and any casefolded account.
 */
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as texts from "@uketsugi/contracts";
import { describe, expect, test } from "vitest";
import { DATA } from "../../src/recall/chain.ts";
import { loadItems, patternOf } from "../../src/recall/items.ts";

interface Labelled {
  /** States the item. */
  readonly matches: readonly string[];
  /** Only looks like it. */
  readonly mustNot: readonly string[];
}

/** The kept labelled set: `matches` and `must_not` as above, and the records its reader could not settle. */
interface Kept {
  matches: string[];
  must_not: string[];
  unsettled?: string[];
}

const LABELLED: Record<string, Labelled> = {
  D1: {
    matches: [
      "ChanServ shows every new date and time as RFC 3339 in UTC, like 2026-11-17T09:30:00Z.",
      "Anything ChanServ prints with a date and time is RFC 3339, except the NOTE LIST lines.",
      "Dates the report shows are RFC 3339 in UTC, as ChanServ does everywhere else now: every date and time.",
    ],
    mustNot: [
      "NOTE LIST lines keep the format `#<number> <date and time> UTC <account>: <text>`.",
      "The changelog parser accepts RFC 3339 timestamps.",
      "Timestamps in the datastore are stored as Unix seconds.",
      "The welcome-back window is measured in hours from the account's last join.",
    ],
  },
  D2: {
    matches: [
      "Every use of a staff-only command must send STAFF <account> <COMMAND> <#channel> to the other operators.",
      "A staff-only command, when used, sends a server notice on the channels snomask naming the account, command and channel.",
      "Rule for later: the other operators get a server notice `STAFF <account> <COMMAND> <#channel>` whenever a staff-only command runs.",
    ],
    mustNot: [
      "Founders are told only `network staff` about staff actions.",
      "Only the founder or network staff may set the entry message.",
      "Registering a channel sends operators a server notice on the channels snomask.",
      "The STAFF capability is checked before the command runs.",
    ],
  },
  P1: {
    matches: [
      "House style: ChanServ's unsolicited notices about a channel are NOTICEs that start with [#Channel] and then the text.",
      "Whenever ChanServ speaks on its own initiative about a channel, the NOTICE begins with the channel name in square brackets, spelled as it was registered.",
      "The transfer-offer notice is unsolicited and has no [#channel] prefix, so it does not follow the house style.",
      "ChanServ's own-initiative messages about a channel are NOTICEs that begin with the channel name in square brackets.",
    ],
    mustNot: [
      "On join ChanServ sends the greeting as a NOTICE `[#Channel] <text>` to the joining client only.",
      "A long greeting is split into several NOTICE lines, each beginning with [#chan], at 510 bytes.",
      'ENTRYMSG refuses a message whose "[#Channel] text" notice would be over 400 bytes.',
      "The greeting is sent with client.Send because it is unsolicited. The bracketed name is channel.Name().",
      "Registering a channel sends operators a `Channel registered [#chan] by [nick]` server notice.",
      "Mails about a freeze must have a subject that starts with the network name in square brackets.",
    ],
  },
  D3: {
    matches: [
      'When ChanServ tells a channel founder about something staff did, it says "network staff" and never the account.',
      "Founders are told only `network staff` about staff actions; NOTE LIST is the exception.",
      "Tell founders 'network staff', not the staff account.",
      'A founder who is not staff sees "network staff" in place of the author of a staff note.',
    ],
    mustNot: [
      "Only the founder or network staff with chanreg may set the entry message.",
      "Network staff decided that ChanServ times will move to RFC 3339.",
      'Admin changes are recorded under their own account, not as "network staff", in the history.',
      "How does NOTE keep notes hidden from people who are not the founder or network staff?",
      "Every use of a command that only network staff may use sends a STAFF notice to operators.",
    ],
  },
  D8: {
    matches: [
      "Outgoing IRC lines are truncated to 512 bytes without an error, so a NOTICE with long text is silently cut.",
      "The serializer truncates any outgoing line over MaxLineLen with no error to the caller.",
      "Server-sent lines past the limit are cut on the wire.",
      "Lines we send are cut at 512 bytes.",
      "The irc library truncates lines over 512 bytes silently when sending.",
      "Anything the server writes past 512 bytes is truncated, with no error.",
      "The server truncates what it sends at 512 bytes and raises no error.",
      "Since one line is cut at 512 bytes, long text goes out as several NOTICEs.",
      "A line is clipped silently when it exceeds MaxLineLen on send.",
    ],
    mustNot: [
      "Incoming client lines over 512 bytes are rejected with 417 Input line too long rather than truncated.",
      "A client line longer than 512 bytes is silently truncated before the handler runs when allow-truncation is true.",
      "An entry message is limited to 200 characters, counted as runes; longer input is refused rather than truncated.",
      "An over-long outgoing line is dropped rather than truncated.",
      "Each note is limited to 300 bytes so that a LIST line stays within the 512-byte limit.",
      "The server reads and writes lines of at most MaxLineLen bytes.",
      "Incoming lines the library reads are truncated at 512 bytes before the handler runs.",
      "A line from a client is cut at 512 bytes before the handler runs.",
      "Search results are truncated to 400 characters when sent to the model.",
      "A greeting is split into NOTICE lines that fit the 510-byte line limit.",
      "Long greeting text is split into several NOTICEs, each fitting the 510-byte line limit.",
      "Entry messages are wrapped into several NOTICEs, each within the line limit.",
      "The token builder does not split a token longer than the 512-byte limit.",
    ],
  },
  D13: {
    matches: [
      "Account names are casefolded for comparing; show people client.AccountName(), the name as registered.",
      "The report prints the founder's account name exactly as registered, which LoadAccount(name).Name gives, not the casefolded form.",
      "Show the registered spelling of the account, not the key it is looked up by.",
    ],
    mustNot: [
      "Per-account join times are stored as RegisteredChannel.AccountJoins (casefolded account to last join time).",
      "Notices begin with the channel name as registered, e.g. [#Lobby].",
      "ChannelsForAccount lists the registered channels whose founder is the given casefolded account.",
      "The successor is stored casefolded as RegisteredChannel.Successor.",
      "Account verification codes are kept under account.verificationcode <casefolded account>.",
    ],
  },
};

describe("the patterns of the items that miscounted", async () => {
  const items = await loadItems();
  for (const [name, labelled] of Object.entries(LABELLED)) {
    const rx = patternOf(items[name] as never) as RegExp;
    test(`${name} matches each record that states it`, () => {
      expect(labelled.matches.filter((r) => !rx.test(r))).toEqual([]);
    });
    test(`${name} matches none of the records that only look like it`, () => {
      expect(labelled.mustNot.filter((r) => rx.test(r))).toEqual([]);
    });
  }
});

const FULL = process.env["UKT_RECALL_LABELS"];
const kept: Record<string, Kept> =
  FULL !== undefined && existsSync(FULL) ? (JSON.parse(readFileSync(FULL, "utf8")) as never) : {};

/** The full set is private; without it the check says that it was skipped instead of passing silently. */
if (Object.keys(kept).length === 0) {
  test.skip("the full labelled set is absent, so the patterns were not held to kept records (set UKT_RECALL_LABELS to labels.json)", () => {});
}

describe.skipIf(Object.keys(kept).length === 0)(
  "the full labelled set of kept records (UKT_RECALL_LABELS)",
  async () => {
    const items = await loadItems();
    for (const [name, labelled] of Object.entries(kept)) {
      const rx = patternOf(items[name] as never) as RegExp;
      test(`${name}: ${labelled.matches.length} records state it, ${labelled.must_not.length} do not`, () => {
        expect(labelled.matches.filter((r) => !rx.test(r))).toEqual([]);
        expect(labelled.must_not.filter((r) => rx.test(r))).toEqual([]);
      });
      for (const r of labelled.unsettled ?? []) {
        test.todo(`${name}: the reader could not settle: ${r.slice(0, 120)}`);
      }
    }
  },
);

/** The words of a text, lower-cased, without punctuation. */
const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];

/** The first run of `n` or more words that two texts share, or null. */
function sharedRun(a: string, b: string, n = 4): string | null {
  const wb = words(b);
  const inB = new Set<string>();
  for (let i = 0; i + n <= wb.length; i++) inB.add(wb.slice(i, i + n).join(" "));
  const wa = words(a);
  for (let i = 0; i + n <= wa.length; i++) {
    const run = wa.slice(i, i + n).join(" ");
    if (inB.has(run)) return run;
  }
  return null;
}

/** Every string the product shows an agent (`texts.ts`), a text with a slot taken at its two readings. */
function productTexts(): string[] {
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (typeof v === "object" && v !== null) Object.values(v).forEach(add);
  };
  for (const v of Object.values(texts)) add(v);
  out.push(texts.noConfidentMatch(1), texts.noConfidentMatch(2), texts.promptText("setup", null));
  return out;
}

type Prompts = Record<string, { prompt: string }>;

/** The lines of each prompt of `live.json` that `chain.json`'s prompt for the task lacks: the reworded ones. */
async function rewordedLines(): Promise<Record<string, string[]>> {
  const chain = (JSON.parse(await readFile(join(DATA, "chain.json"), "utf8")) as { tasks: Prompts })
    .tasks;
  const live = JSON.parse(await readFile(join(DATA, "live.json"), "utf8")) as Prompts;
  return Object.fromEntries(
    Object.entries(live)
      .filter(([task]) => task !== "told")
      .map(([task, entry]) => {
        const old = new Set((chain[task]?.prompt ?? "").split("\n"));
        return [task, entry.prompt.split("\n").filter((l) => !old.has(l))];
      }),
  );
}

describe("the reworded sentences are not the product's text", () => {
  test("a clause copied from the product's text is caught", () => {
    const copy =
      "Remember: when you establish something a later session would need, publish it at once.";
    expect(sharedRun(copy, texts.BLOCK_TEXT)).toBe("when you establish something");
    expect(sharedRun("Please let a founder set a greeting.", texts.BLOCK_TEXT)).toBeNull();
  });

  test("no reworded sentence shares four words in a row with it", async () => {
    const reworded = await rewordedLines();
    expect(Object.values(reworded).flat().length).toBeGreaterThan(0);
    const clashes = Object.entries(reworded).flatMap(([task, lines]) =>
      lines.flatMap((l) =>
        productTexts().flatMap((p) => {
          const run = sharedRun(l, p);
          return run === null ? [] : [`${task}: "${run}" in: ${l.slice(0, 80)}`];
        }),
      ),
    );
    expect(clashes).toEqual([]);
  });
});
