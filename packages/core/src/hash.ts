import canonicalize from "canonicalize";
import type { ClassedCitation } from "./domain.ts";
import { normalizeText } from "./text/analyze.ts";

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of a text's UTF-8 bytes, in hex. */
export async function sha256Hex(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

/** The canonical JSON text of a value (RFC 8785): what is hashed, never the stored JSON. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value) ?? "null";
}

/** How a repeated publish of one claim by one author is recognised: the hash of the normalized claim. */
export function claimHashOf(claim: string): Promise<string> {
  return sha256Hex(normalizeText(claim));
}

/** The hash of everything a fact says: an event records it before and after a change. */
export function contentHashOf(content: {
  claim: string;
  detail: string | null;
  question: string | null;
  citations: readonly ClassedCitation[];
}): Promise<string> {
  const citations = content.citations.map((entry) => entry.citation);
  return sha256Hex(
    canonicalJson({
      claim: content.claim,
      detail: content.detail,
      question: content.question,
      citations,
    }),
  );
}

/** Bytes as lower-case hex. */
export function toHex(bytes: Uint8Array): string {
  return hex(bytes);
}
