/**
 * The brief's own fixed lines: the starts of the headings and set sentences it writes whatever a
 * project holds. Each is written in `brief.ts` from here, so the list and the brief cannot differ,
 * and a tool that counts what a session recalled from memory reads them from here to leave them out.
 * This file imports nothing, so a tool can load it from any tree it measures.
 */
export const BRIEF_LINES = {
  /** The first line, over the project's name. */
  title: "Session brief for",
  heldTasks: "Tasks you hold",
  openTasks: "Open tasks",
  lapsedTasks: "Tasks whose lease lapsed",
  previous: "Your previous session here",
  otherOpen: "Another session of yours here",
  published: "Facts published while it ran:",
  digested: "Facts a model wrote from what it left, which nobody has checked:",
  noFacts: "This project holds no facts yet.",
  /** The end of the facts heading, after its counts. */
  factsEnd: "search_facts finds the rest):",
} as const;

/** Every fixed line's start, for a tool that must not mistake them for what a session recalled. */
export const BRIEF_FIXED_LINES: readonly string[] = Object.values(BRIEF_LINES);
