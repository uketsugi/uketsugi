import { describe, expect, test } from "vitest";
import { scanFields, scanText } from "../src/scan/scanner.ts";

/** Built at run time so that no secret-shaped literal sits in the repository. */
const GITHUB = `ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`;
const STRIPE = `sk_live_${"4eC39HqLyjWDarjtT1zdp7dc"}`;
const SENDGRID = `SG.${"aB3dE6gH9jK2mN5pQ8sT1v"}.${"Zx4cV7bN0mQ3wE6rT9yU2iO5pA8sD1fG4hJ7kL0zXcV"}`;

describe("the scanner", () => {
  test.each([
    [
      `The deploy token is ${GITHUB}.`,
      "The deploy token is [redacted:github-token].",
      "github-token",
    ],
    [`Stripe key ${STRIPE}, rotated`, "Stripe key [redacted:stripe-key], rotated", "stripe-key"],
    [
      "DSN postgres://app:s3cr3tP4ss@db.internal:5432/prod",
      "DSN postgres://app:[redacted:url-credentials]@db.internal:5432/prod",
      "url-credentials",
    ],
    [
      "password = Tr0ub4dor&3xyz in config.yml",
      "password = [redacted:generic-assignment] in config.yml",
      "generic-assignment",
    ],
    [
      "Card 4111 1111 1111 1111 was charged",
      "Card [redacted:credit-card] was charged",
      "credit-card",
    ],
    ["SSN 536-90-4399 is on file", "SSN [redacted:us-ssn] is on file", "us-ssn"],
    ["Ask alice.smith@corp.io first", "Ask [redacted:email] first", "email"],
    ["Call +1 415 555 2671 at night", "Call [redacted:phone] at night", "phone"],
  ])("replaces the match in %j and names the rule", (text, stored, rule) => {
    expect(scanText(text)).toEqual({ text: stored, rules: [rule] });
  });

  test("a vendored provider rule finds a token ours do not know", () => {
    const scanned = scanText(`SENDGRID_API_KEY=${SENDGRID}`);
    expect(scanned.text).not.toContain(SENDGRID);
    expect(scanned.rules).toContain("sendgrid-api-token");
  });

  test("a match that starts inside another and runs past it is replaced to its own end", () => {
    const key = `sk-ant-api03-${"aB3dE6gH9jK2mN5pQ8sT1vZx4cV7bN0mQ3wE6rT9yU2i"}`;
    const glued = scanText(`from ops@corp.${key} today`);
    expect(glued.text).toBe("from [redacted:email][redacted:anthropic-key] today");
    expect(glued.rules).toEqual(["email", "anthropic-key"]);
    // Two card-shaped runs of digits overlap here; the second ends four digits after the first.
    const digits = scanText("reach me on +1 415 555 2671 4111 1111 1111 1111 please");
    expect(digits).toEqual({
      text: "reach me on +1 415 555 [redacted:credit-card] please",
      rules: ["credit-card"],
    });
  });

  test("a provider's token is replaced whole, however much longer it is than the provider's rule knows", () => {
    const run = (length: number) => "a1B2c3D4e5F6g7H8i9J0".repeat(8).slice(0, length);
    // GitHub documents its tokens by prefix and promises no length: a refresh token is longer
    // than a personal one, and an installation token is `ghs_APPID_JWT` since April 2026.
    const jwt = ["eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9", run(86), `${run(40)}-_${run(44)}`].join(
      ".",
    );
    const tokens = [
      ["github-token", `ghr_${run(76)}`],
      ["github-token", `ghs_${run(40)}`],
      ["github-token", `ghs_1234567_${jwt}`],
      ["github-token", `github_pat_${run(22)}_${run(70)}`],
      ["gitlab-token", `glpat-${run(26)}`],
    ] as const;
    for (const [rule, token] of tokens) {
      const sentence = scanText(`The job reads ${token} from its environment.`);
      expect(sentence, token.slice(0, 12)).toEqual({
        text: `The job reads [redacted:${rule}] from its environment.`,
        rules: [rule],
      });
      expect(scanText(`key:${token},next`).text).toBe(`key:[redacted:${rule}],next`);
    }
    // A prefix by itself, or with a placeholder after it, names a kind of token and is not one.
    const prose = "Installation tokens start with ghs_ and now read ghs_APPID_JWT.";
    expect(scanText(prose)).toEqual({ text: prose, rules: [] });
  });

  test("a private key goes whole, to its end marker or the end of the text", () => {
    const body = "MIIEowIBAAKCAQEAr7n\nq8Zk3v\n";
    const whole = `key:\n-----BEGIN RSA PRIVATE KEY-----\n${body}-----END RSA PRIVATE KEY-----\nafter`;
    expect(scanText(whole).text).toBe("key:\n[redacted:private-key]\nafter");
    expect(scanText(`-----BEGIN OPENSSH PRIVATE KEY-----\n${body}`).text).toBe(
      "[redacted:private-key]",
    );
  });

  test("text no reader can see is deleted, and a secret split by it is still found", () => {
    const hidden = scanText("safe \u001b[31mred\u001b[0m \u202Eflip \u{E0041}\u{E0042}tag\tkept\n");
    expect(hidden).toEqual({ text: "safe red flip tag\tkept\n", rules: ["hidden-text"] });
    const split = `${GITHUB.slice(0, 2)}\u200B${GITHUB.slice(2)}`;
    expect(scanText(`token ${split} end`).text).toBe("token [redacted:github-token] end");
    expect(
      scanText("flag \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}").rules,
    ).toEqual([]);
  });

  test.each([
    "apiKey = process.env.OPENAI_API_KEY is read at start",
    "password: changeme1234 is the default in the sample",
    "secret: rotating-keys-quarterly is the policy",
    "Clone git@github.com:acme/api.git and write to dev@example.com",
    "The cache key: user_session_v2_prefix is built in keys.ts",
    "Build 2026-11-13 failed on run 000-12-3456 of order 4f9d2c1e-8a7b-4c6d-9e0f-1a2b3c4d5e6f",
    "Dunning retries a declined card on days 1, 3, 5 and 7, then marks it past_due.",
  ])("leaves %j as written", (text) => {
    expect(scanText(text)).toEqual({ text, rules: [] });
  });

  test("a reference keeps an address that prose would lose, and never a secret", () => {
    const url = `https://wiki.corp.io/~alice.smith@corp.io/retries?token=${GITHUB}`;
    const scanned = scanText(url, { secretsOnly: true });
    expect(scanned.text).toBe(
      "https://wiki.corp.io/~alice.smith@corp.io/retries?token=[redacted:github-token]",
    );
    expect(scanText(url).rules).toEqual(["email", "github-token"]);
  });

  test("a scanned text scans clean, and a long hostile one is scanned in linear time", () => {
    const once = scanText(
      `password = Tr0ub4dor&3xyz and ${GITHUB} for alice.smith@corp.io at postgres://app:s3cr3tP4ss@db.internal/prod`,
    );
    expect(scanText(once.text)).toEqual({ text: once.text, rules: [] });
    const hostile = `${"a".repeat(100_000)}@ ${"1-".repeat(20_000)}`;
    expect(scanText(hostile).text).toHaveLength(hostile.length);
  });

  test("fields are scanned under their names, and an absent one stays absent", () => {
    const { fields, replaced } = scanFields({
      claim: `The token is ${GITHUB}`,
      detail: "nothing here",
      question: undefined,
    });
    expect(fields).toEqual({
      claim: "The token is [redacted:github-token]",
      detail: "nothing here",
      question: null,
    });
    expect(replaced).toEqual([{ field: "claim", rule: "github-token" }]);
  });
});
