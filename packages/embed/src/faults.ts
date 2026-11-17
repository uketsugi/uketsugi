/** How the adapter reads a failure: as a sentence, and as a file that is not there. */

/** An error as the sentence it carries, or the thrown value itself as text. */
export const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Whether a file operation failed because the file is missing. */
export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
