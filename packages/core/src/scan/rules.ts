/**
 * The scanner's own rules: the secrets the vendored provider rules miss or find only at a word
 * boundary they insist on, and personal data. A provider whose keys the vendored rules find
 * wherever ours did (AWS access keys, GitLab tokens, Slack webhooks) has no rule here: its
 * findings are the vendored rule's, reported under the id `VENDORED_AS` gives it. Every pattern
 * is RE2 syntax run by re2js, so no text, however long, makes a rule slow.
 */
import cardValidator from "card-validator";
import { findPhoneNumbersInText } from "libphonenumber-js/min";
import { UUID_SHAPE } from "../facts/citations.ts";
import type { Span } from "./hidden.ts";
import { re2, shannonEntropy } from "./token-rules.ts";

/** One rule: an id a result may name, and where it matches. */
export interface Rule {
  readonly id: string;
  /** Personal data rather than a secret: left alone in a path or a URL, which are references. */
  readonly personal?: true;
  find(text: string): Span[];
}

interface Match extends Span {
  /** The whole match, which `keep` judges; the span is the part to replace. */
  readonly matched: string;
  readonly groups: readonly string[];
}

/** Every match of a pattern, as the span of capture group `group` (0 is the whole match). */
function matchesOf(text: string, pattern: string, group = 0): Match[] {
  const found: Match[] = [];
  const matcher = re2(pattern).matcher(text);
  while (matcher.find()) {
    const groups = Array.from({ length: matcher.groupCount() + 1 }, (_, n) => matcher.group(n));
    found.push({
      start: matcher.start(group),
      end: matcher.end(group),
      matched: groups[0] ?? "",
      groups: groups.map((value) => value ?? ""),
    });
  }
  return found;
}

/** What the scanner leaves where a match was: a text already scanned must scan clean. */
const REPLACED = "^\\[redacted:[a-z0-9-]+\\]$";

function rule(
  id: string,
  patterns: readonly string[],
  options: { group?: number; keep?: (match: Match, text: string) => boolean } = {},
): Rule {
  const keep = options.keep ?? (() => true);
  const fresh = (match: Match, text: string): boolean =>
    !re2(REPLACED).matcher(text.slice(match.start, match.end)).matches();
  return {
    id,
    find: (text) =>
      patterns.flatMap((pattern) =>
        matchesOf(text, pattern, options.group).filter(
          (match) => fresh(match, text) && keep(match, text),
        ),
      ),
  };
}

const MIN_ASSIGNED_ENTROPY = 3.5;
const PLACEHOLDER =
  "(?i)^(?:<.*>|x{3,}.*|\\*{3,}.*|.*changeme.*|.*example.*|your[-_].*|\\[redacted:[a-z0-9-]+\\].*)$";
/** `process.env.OPENAI_API_KEY` names where a value comes from; it is not the value. */
const DOTTED_PATH = "^[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)+$";

/** `rotating-keys-quarterly`, `stripe_secret_name`: lower-case words joined by `-`, `_` or `.` name a thing. */
const WORDS = "^[a-z]+(?:[-_.][a-z]+)*$";

/** Whether the value of `password = …` looks like a real secret: not a placeholder, not a name, not a plain word. */
function looksSecret(value: string): boolean {
  const named = [PLACEHOLDER, DOTTED_PATH, WORDS].some((shape) =>
    re2(shape).matcher(value).matches(),
  );
  return !named && shannonEntropy(value) >= MIN_ASSIGNED_ENTROPY;
}

const UUID = `(?i)\\b${UUID_SHAPE}\\b`;
const MIN_CARD_DIGITS = 13;
const MAX_CARD_DIGITS = 19;

/**
 * Payment card numbers: 13 to 19 digits in whole groups joined by single spaces or dashes, which a
 * card network would accept (prefix, length and check digit, by card-validator). Digits inside a
 * UUID are an identifier, not a card.
 */
function findCardNumbers(text: string): Span[] {
  const groups = matchesOf(text, "\\d+");
  const uuids = matchesOf(text, UUID);
  const spans: Span[] = [];
  for (let first = 0; first < groups.length; first += 1) {
    let digits = "";
    for (let last = first; last < groups.length; last += 1) {
      const group = groups[last];
      const before = groups[last - 1];
      if (group === undefined) break;
      const gap = last === first || before === undefined ? "" : text.slice(before.end, group.start);
      if (last > first && gap !== " " && gap !== "-") break;
      digits += group.matched;
      if (digits.length > MAX_CARD_DIGITS) break;
      if (digits.length < MIN_CARD_DIGITS || !cardValidator.number(digits).isValid) continue;
      const span = { start: groups[first]?.start ?? group.start, end: group.end };
      if (!uuids.some((uuid) => span.start < uuid.end && uuid.start < span.end)) spans.push(span);
    }
  }
  return spans;
}

const INVALID_SSNS = new Set(["078-05-1120", "219-09-9999"]);

/** A US social security number that could have been issued. */
function isIssuableSsn(ssn: string): boolean {
  const [area = "", group = "", serial = ""] = ssn.split("-");
  if (area === "000" || area === "666" || area.startsWith("9")) return false;
  return group !== "00" && serial !== "0000" && !INVALID_SSNS.has(ssn);
}

const EXAMPLE_DOMAINS = new Set(["example.com", "example.org", "example.net"]);

/** `git@github.com:acme/api.git` is a remote, not an address; `user@host:22` is an address and a port. */
function isRemote(match: Match, text: string): boolean {
  const after = text.slice(match.end, match.end + 2);
  return after.startsWith(":") && /^[^\s:\d]$/.test(after.slice(1));
}

/** How far back a URL's scheme is looked for: a login longer than this is not one. */
const LOGIN_CHARS = 300;

/** `scheme://user:password@host`: what stands before the `@` of a URL's authority is a login, not an address. */
function isUrlLogin(match: Match, text: string): boolean {
  const before = text.slice(Math.max(0, match.start - LOGIN_CHARS), match.start);
  const word = before.split(/\s/).at(-1) ?? "";
  const scheme = word.lastIndexOf("://");
  return scheme >= 0 && !word.slice(scheme + 3).includes("/");
}

function isPersonalAddress(match: Match, text: string): boolean {
  const domain = match.matched.slice(match.matched.lastIndexOf("@") + 1).toLowerCase();
  return !EXAMPLE_DOMAINS.has(domain) && !isRemote(match, text) && !isUrlLogin(match, text);
}

/** A bare run of digits is an order id as often as a phone number, so a match needs a separator, a bracket or a leading plus. */
function findPhoneNumbers(text: string): Span[] {
  return findPhoneNumbersInText(text, "US")
    .map((found) => ({ start: found.startsAt, end: found.endsAt }))
    .filter((span) => /^\+|[ .\-(]/.test(text.slice(span.start, span.end)));
}

const KEY_BLOCK = "[A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----";
const ASSIGNED =
  "(?i)\\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\\b\\s*[:=]\\s*['\"]?([^\\s'\"]{8,})";

/** The rules, in the order a result names them. */
export const RULES: readonly Rule[] = [
  rule(
    "aws-secret-key",
    ["(?i)aws.{0,20}(?:secret|private).{0,20}['\"=: ]\\s*([A-Za-z0-9/+=]{40})\\b"],
    { group: 1 },
  ),
  // GitHub names its tokens by prefix and promises no length: a refresh token is longer than a
  // personal one, and since April 2026 an installation token is `ghs_APPID_JWT`, which no rule
  // that counts 36 characters finds. The run after the prefix is the token, dotted parts included.
  rule("github-token", [
    "\\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_-]{36,}(?:\\.[A-Za-z0-9_-]{16,})*",
  ]),
  rule("slack-token", ["\\bxox[abposr]-[A-Za-z0-9-]{10,}\\b"]),
  rule("stripe-key", ["\\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\\b"]),
  rule("openai-key", ["\\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\\b"], {
    keep: (match) => !match.matched.startsWith("sk-ant-"),
  }),
  rule("anthropic-key", ["\\bsk-ant-[A-Za-z0-9_-]{32,}\\b"]),
  rule("google-api-key", ["\\bAIza[0-9A-Za-z_-]{35}\\b"]),
  // The whole block goes, to its end marker or, when that is missing, to the end of the text.
  rule("private-key", [`(?s)-----BEGIN ${KEY_BLOCK}.*?(?:-----END ${KEY_BLOCK}|\\z)`]),
  rule("jwt", ["\\beyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b"]),
  rule("url-credentials", ["\\b[a-z][a-z0-9+.-]*://[^/\\s:@]*:([^/\\s@]{3,})@"], { group: 1 }),
  rule("generic-assignment", [ASSIGNED], {
    group: 2,
    keep: (match) => looksSecret(match.groups[2] ?? ""),
  }),
  { id: "credit-card", find: findCardNumbers },
  rule("us-ssn", ["\\b\\d{3}-\\d{2}-\\d{4}\\b"], { keep: (match) => isIssuableSsn(match.matched) }),
  {
    ...rule("email", ["\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b"], {
      keep: isPersonalAddress,
    }),
    personal: true,
  },
  { id: "phone", personal: true, find: findPhoneNumbers },
];

/** The id of ours that a vendored rule reports under, where both cover one provider. */
export const VENDORED_AS: Readonly<Record<string, string>> = {
  "aws-access-token": "aws-access-key",
  "github-pat": "github-token",
  "github-oauth": "github-token",
  "github-app-token": "github-token",
  "github-refresh-token": "github-token",
  "github-fine-grained-pat": "github-token",
  "gitlab-pat": "gitlab-token",
  "gitlab-pat-routable": "gitlab-token",
  "slack-bot-token": "slack-token",
  "slack-user-token": "slack-token",
  "slack-app-token": "slack-token",
  "slack-legacy-bot-token": "slack-token",
  "slack-legacy-token": "slack-token",
  "slack-legacy-workspace-token": "slack-token",
  "slack-config-access-token": "slack-token",
  "slack-config-refresh-token": "slack-token",
  "slack-webhook-url": "slack-webhook",
  "stripe-access-token": "stripe-key",
  "openai-api-key": "openai-key",
  "anthropic-api-key": "anthropic-key",
  "anthropic-admin-api-key": "anthropic-key",
  "gcp-api-key": "google-api-key",
  "jwt-base64": "jwt",
};
