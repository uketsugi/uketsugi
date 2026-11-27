import {
  ERROR_RETRY,
  PROJECT_REFUSAL_PARTS,
  type ErrorCode,
  type ToolError,
} from "@uketsugi/contracts";

/** What a failure says beyond its code: what happened, what it means and what to do next. */
export interface FailureText {
  readonly what: string;
  readonly meaning: string;
  readonly next: string;
  readonly details?: Record<string, unknown>;
}

/**
 * A call that failed in a way the caller can act on, from a tool or from `/api`. Every failure has
 * the one error shape.
 */
export class ToolFailure extends Error {
  readonly code: ErrorCode;
  readonly text: FailureText;

  constructor(code: ErrorCode, text: FailureText) {
    super(text.what);
    this.name = "ToolFailure";
    this.code = code;
    this.text = text;
  }

  /** The failure as a body: the `structuredContent` of a failed tool call, the JSON of a failed request. */
  toToolError(): ToolError {
    const { what, meaning, next, details } = this.text;
    const retry = ERROR_RETRY[this.code];
    return {
      error: { code: this.code, what, meaning, next, retry, ...(details ? { details } : {}) },
    };
  }

  /** The text of the failed call. The missing-project refusal is its fixed text and nothing else. */
  toText(): string {
    const { what, meaning, next } = this.text;
    return this.code === "project_required" ? `${what} ${next}` : `${what} ${meaning} ${next}`;
  }
}

/** The refusal of a call whose project is missing or malformed. */
export function projectRequired(): ToolFailure {
  return new ToolFailure("project_required", {
    ...PROJECT_REFUSAL_PARTS,
    meaning:
      "The call named no project, or one that is not a repository remote or a named project, so nothing was done.",
  });
}

export function invalidInput(
  what: string,
  next: string,
  details?: Record<string, unknown>,
): ToolFailure {
  return new ToolFailure("invalid_input", {
    what,
    meaning: "The call was not understood and nothing was done.",
    next,
    ...(details ? { details } : {}),
  });
}

/** The refusal of a text longer than it may be. It names the field and the two lengths, never the text. */
export function overLong(field: string, length: number, limit: number): ToolFailure {
  return invalidInput(
    `${field} is ${length} characters long; the most it may hold is ${limit}.`,
    `Shorten ${field} to ${limit} characters or fewer and send the call again; cite the source for what you leave out.`,
  );
}

/**
 * What a call may name and not find, with what its reader does next: an agent searches again, a
 * person on the dashboard opens the record from its list.
 */
const NOT_FOUND = {
  fact: {
    what: (id: string) => `No fact ${id} is visible in this project.`,
    meaning: "The id is wrong, the fact is in another project, or it was removed.",
    next: "Call search_facts to find the fact and use the id it returns.",
  },
  task: {
    what: (id: string) => `No task ${id} is visible in this project.`,
    meaning: "The id is wrong, or the task belongs to another project.",
    next: "Call search_tasks to list this project's tasks and use the id it returns.",
  },
  "listed fact": {
    what: (id: string) => `No fact ${id} is visible to you.`,
    meaning: "The id is wrong, or the fact was removed.",
    next: "Open the fact from the list.",
  },
  "listed task": {
    what: (id: string) => `No task ${id} is visible to you.`,
    meaning: "The id is wrong, or the task is no longer shared with you.",
    next: "Open the task from the list.",
  },
  "listed project": {
    what: (id: string) => `"${id}" is not one of your projects.`,
    meaning: "The name is wrong, or the project was deleted already.",
    next: "Choose one of your projects from the list.",
  },
  "listed session": {
    what: (id: string) => `No session ${id} is among your recent sessions.`,
    meaning: "The id is wrong, or the session is older than the list shows.",
    next: "Open Activity and remove the note from the session's own entry.",
  },
  "listed ruling": {
    what: (id: string) => `No ruling ${id} is visible here.`,
    meaning: "The id is wrong, or the ruling is in an audience you cannot see.",
    next: "Open Activity and revert the ruling from its own entry.",
  },
} as const;

/** The failure of a call that names a record its caller cannot see. A record out of scope reads as absent. */
export function notFound(record: keyof typeof NOT_FOUND, id: string): ToolFailure {
  const { what, meaning, next } = NOT_FOUND[record];
  return new ToolFailure("not_found", { what: what(id), meaning, next });
}

/** The failure of a write whose fact another write changed between its read and its unit. */
export function changedMeanwhile(id: string): ToolFailure {
  return new ToolFailure("unavailable", {
    what: `Fact ${id} changed while this call was being prepared.`,
    meaning: "Another write reached the fact first, so nothing was changed by this one.",
    next: "Send the same call again.",
  });
}

export function forbidden(what: string, next: string): ToolFailure {
  return new ToolFailure("forbidden", { what, meaning: "Nothing was changed.", next });
}

export function unsupported(what: string, next: string): ToolFailure {
  return new ToolFailure("unsupported", { what, meaning: "This server does not do that.", next });
}

/** The failure a caller sees when something broke inside the server; the cause goes to the log. */
export function internal(): ToolFailure {
  return new ToolFailure("internal", {
    what: "The server failed while handling the call.",
    meaning:
      "The fault is the server's, not the call's; nothing can be assumed about what was done.",
    next: "Carry on without memory for now and tell the person the memory server reported an internal error.",
  });
}
