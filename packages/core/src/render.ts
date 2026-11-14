import type { Envelope } from "@uketsugi/contracts";

/** What every result's text ends with: the project's treatment, the session and anything incomplete. */
export function footer(envelope: Envelope): string[] {
  return [
    `project: ${envelope.project} · ${envelope.treatment}`,
    `session: ${envelope.session}`,
    ...(envelope.degraded.length === 0 ? [] : [`degraded: ${envelope.degraded.join(", ")}`]),
  ];
}

/** The beginning of a text: at most `max` characters of it, with an ellipsis when it was cut. */
export function headOf(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("").trimEnd()}…`;
}
