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
import { describe, expect, test } from "vitest";
import { loadItems, patternOf } from "../../src/recall/items.ts";

interface Labelled {
  /** States the item. */
  readonly matches: readonly string[];
  /** Only looks like it. */
  readonly mustNot: readonly string[];
}

const LABELLED: Record<string, Labelled> = {
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
const kept: Record<string, { matches: string[]; must_not: string[] }> =
  FULL !== undefined && existsSync(FULL) ? (JSON.parse(readFileSync(FULL, "utf8")) as never) : {};

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
    }
  },
);
