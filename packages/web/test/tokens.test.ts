/**
 * The colour part of the accessibility target, measured on the design tokens: jsdom lays nothing
 * out, so axe cannot measure contrast on a rendered page.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Color from "colorjs.io";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/styles.css"), "utf8");

/** The tokens of one theme: the first `:root` block is light, the second dark. */
function theme(index: number): Map<string, string> {
  const block = css.split(":root {")[index + 1]?.split("}")[0] ?? "";
  return new Map(
    [...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6});/g)].map((match) => [
      match[1] ?? "",
      match[2] ?? "",
    ]),
  );
}

const SURFACES = ["canvas", "sidebar", "surface", "sunken", "accent-soft", "neutral-soft"];

/** Each text colour with every background a component draws it on. */
const TEXT: Record<string, string[]> = {
  ink: SURFACES,
  "ink-muted": SURFACES,
  "on-accent": ["accent"],
  "accent-ink": ["accent-soft"],
  "ok-ink": ["ok-soft"],
  "warn-ink": ["warn-soft"],
  "neutral-ink": ["neutral-soft"],
  "info-ink": ["info-soft"],
  "danger-ink": ["danger-soft"],
  danger: ["surface"],
  "on-danger": ["danger"],
  "code-ink": ["code"],
};

/** Each control's border and each focus ring with every background it is drawn against. */
const CONTROLS: Record<string, string[]> = {
  focus: ["canvas", "sidebar", "surface", "sunken", "accent-soft"],
  "focus-on-code": ["code"],
  "line-strong": ["canvas", "surface"],
  "code-muted": ["code"],
  accent: ["surface"],
};

/** The pairs whose contrast is under `floor`, as "ink on canvas 4.2". */
function under(tokens: Map<string, string>, pairs: Record<string, string[]>, floor: number) {
  return Object.entries(pairs).flatMap(([fore, backs]) =>
    backs.flatMap((back) => {
      const ratio = new Color(tokens.get(fore) ?? "").contrast(tokens.get(back) ?? "", "WCAG21");
      return ratio < floor ? [`${fore} on ${back} ${ratio.toFixed(2)}`] : [];
    }),
  );
}

describe.each([
  ["light", theme(0)],
  ["dark", theme(1)],
])("the %s theme", (_name, tokens) => {
  it("keeps every text colour at 4.5 to 1 or more on each surface it is drawn on", () => {
    expect(under(tokens, TEXT, 4.5)).toEqual([]);
  });

  it("keeps every control border and focus ring at 3 to 1 or more", () => {
    expect(under(tokens, CONTROLS, 3)).toEqual([]);
  });

  it("defines the same tokens as the other theme", () => {
    expect([...tokens.keys()]).toEqual([...theme(0).keys()]);
  });
});

describe("the tab's icon", () => {
  it("is drawn in each theme's accent, as the mark in the navigation is", () => {
    const icon = readFileSync(join(import.meta.dirname, "../src/favicon.svg"), "utf8");
    const fills = [...icon.matchAll(/fill:\s*(#[0-9a-f]{6})/g)].map((match) => match[1]);
    expect(fills).toEqual([theme(0).get("accent"), theme(1).get("accent")]);
  });
});
