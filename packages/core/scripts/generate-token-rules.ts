/**
 * Turns gitleaks' rule file, vendored beside this script as `gitleaks.toml`, into the data the
 * scanner runs: `src/scan/token-rules.json`. `pnpm generate` writes the file; a test fails when
 * the file and the source disagree. To take a newer gitleaks, replace `gitleaks.toml` with its
 * `config/gitleaks.toml`, set `SOURCE` to its tag and its SHA-256, and regenerate.
 *
 * gitleaks is MIT licensed, Copyright (c) 2019 Zachary Rice; the notice travels in the output.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

const SOURCE = {
  url: "https://github.com/gitleaks/gitleaks/blob/v8.30.1/config/gitleaks.toml",
  sha256: "e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf",
};
const LICENSE =
  'MIT License. Copyright (c) 2019 Zachary Rice. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.';
const NOTE =
  "Patterns are copied verbatim from the source and run by re2js, which takes Go (RE2) syntax as written. A scanned field has no path, so the source's path-only rule (pkcs12-file), its four rules that fire only in files their path names (freemius-secret-key, hashicorp-tf-password, kubernetes-secret-yaml, nuget-config-password) and every allowlist path condition are left out.";

const SOURCE_URL = new URL("./gitleaks.toml", import.meta.url);
const OUTPUT_URL = new URL("../src/scan/token-rules.json", import.meta.url);

interface SourceAllowlist {
  condition?: string;
  regexTarget?: string;
  regexes?: string[];
  stopwords?: string[];
  /** Left out: a scanned field has no path. */
  paths?: string[];
}
interface SourceRule {
  id: string;
  regex?: string;
  /** A rule with a path fires only in files the path names; a scanned field is in none. */
  path?: string;
  keywords?: string[];
  entropy?: number;
  secretGroup?: number;
  allowlists?: SourceAllowlist[];
}

/** An allowlist without its path condition; null when a path was all it had. */
function allowlistOf(source: SourceAllowlist): object | null {
  const { condition, regexTarget, regexes, stopwords } = source;
  if (regexes === undefined && stopwords === undefined) return null;
  return { condition, regexTarget, regexes, stopwords };
}

function ruleOf(source: SourceRule): object {
  const allowlists = (source.allowlists ?? []).flatMap((entry) => allowlistOf(entry) ?? []);
  return {
    id: source.id,
    regex: source.regex,
    keywords: source.keywords ?? [],
    entropy: source.entropy,
    secretGroup: source.secretGroup,
    allowlists: allowlists.length === 0 ? undefined : allowlists,
  };
}

/** The scanner's rule data for a gitleaks rule file. */
export function tokenRules(toml: string): object {
  const sha256 = createHash("sha256").update(toml).digest("hex");
  if (sha256 !== SOURCE.sha256) {
    throw new Error(`gitleaks.toml is not the pinned file: its SHA-256 is ${sha256}`);
  }
  const source = parse(toml) as unknown as { allowlist: SourceAllowlist; rules: SourceRule[] };
  const scannable = source.rules.filter(
    (rule) => rule.regex !== undefined && rule.path === undefined,
  );
  const document = {
    source: SOURCE.url,
    sourceSha256: SOURCE.sha256,
    license: LICENSE,
    note: NOTE,
    allowlist: allowlistOf(source.allowlist),
    rules: scannable.map(ruleOf),
  };
  // Through JSON once, so that what is returned is what the file holds: no absent values.
  return JSON.parse(JSON.stringify(document)) as object;
}

/** The data as the vendored source generates it now, and the path it belongs at. */
export function generatedTokenRules(): { path: string; document: object } {
  return {
    path: fileURLToPath(OUTPUT_URL),
    document: tokenRules(readFileSync(SOURCE_URL, "utf8")),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { path, document } = generatedTokenRules();
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
}
