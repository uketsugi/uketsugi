/**
 * What the dashboard says to a person about how to get in and where the token is. The server says
 * it once, in the capability descriptor, and the pages show it: an edition with another way in
 * gives its own, and no page holds a copy.
 */
import { TOKEN_ENV, type CapabilityDescriptor } from "@uketsugi/contracts";

export type DashboardWords = CapabilityDescriptor["dashboard"];
/** The words of an edition whose harnesses sign in themselves: it gives no token, so it says none of the token's. */
export type SignInWords = Extract<DashboardWords, { no_token: string }>;
export type TokenWords = Exclude<DashboardWords, SignInWords>;

/** Whether these are the words of an edition whose harnesses sign in themselves. */
export function signsIn(words: DashboardWords): words is SignInWords {
  return "no_token" in words;
}

/** The open edition's: a person runs `ukt ui` on the server's host, or pastes the key they were given. */
export const OPEN_DASHBOARD_WORDS: TokenWords = {
  sign_in: [
    "On the computer the server runs on, run `ukt ui` in a terminal: it opens the dashboard signed in, or prints a link that does.",
    "From any other computer, paste the dashboard key you were given.",
  ],
  key_form: true,
  token_command: `export ${TOKEN_ENV}="$(ukt token)"`,
  token_row: `read from the environment variable \`${TOKEN_ENV}\`; this page never shows the token itself. On the server's host, \`ukt token\` prints yours.`,
  shell_intro: `Run these in one terminal on the server's host. The first line puts your token in \`${TOKEN_ENV}\`, where the rest read it:`,
  shell_elsewhere: `On another machine, set \`${TOKEN_ENV}\` to the token you were given in place of the first line.`,
  token_change:
    "{harness} keeps the token it was added with. To give it another, after `ukt token --rotate` for one, first remove the server with `{remove}`, then run the lines above again.",
};
