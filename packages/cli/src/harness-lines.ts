/**
 * What a person types to connect a harness to the server, which `ukt setup` and `ukt doctor`
 * print at their end. Every line comes from the rows the server describes (`ConnectInfo`, the
 * Connect page's own): nothing here knows one harness from another.
 */
import type { ConnectHarness, ConnectInfo } from "@uketsugi/contracts";

const INDENT = "  ";

/** What the person does with one harness: the line that adds the server, then what they type or do. */
function harnessLines(harness: ConnectHarness): string[] {
  const indented = (text: string): string[] => text.split("\n").map((line) => `${INDENT}${line}`);
  if (harness.add_kind === "url")
    return [harness.name, ...indented(`Give the client the address ${harness.add}`)];
  const how =
    harness.add_kind === "file"
      ? [harness.add_where ?? "Put this in its configuration file:", harness.add]
      : [harness.add];
  const then =
    harness.activate !== undefined
      ? `then type ${harness.activate} in a session`
      : `then put the block in ${harness.instruction_file ?? "its instruction file"}: \`ukt ui\` shows it`;
  return [harness.name, ...how.flatMap(indented), ...indented(then)];
}

/**
 * The lines that say what to do for each harness the server describes, and first whether any of
 * them sends a token. `tokenCommand` is the line that puts the token where the rest read it, as
 * this data directory is named. A server whose harnesses sign in themselves says why there is
 * no token (`signsInThemselves`), and that is said in its words.
 */
export function connectLines(
  info: ConnectInfo,
  tokenCommand: string,
  signsInThemselves?: string,
): string[] {
  return [
    signsInThemselves ??
      (info.needs_token
        ? `Every harness sends a token to this server. In the shell you add them from: ${tokenCommand}`
        : "No harness here needs a token: this server takes one on this machine by its address alone, while you are its only person."),
    ...info.harnesses.flatMap((harness) => harnessLines(harness)),
  ];
}
