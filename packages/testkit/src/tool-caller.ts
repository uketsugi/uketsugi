import type { ToolName, ToolResults } from "@uketsugi/contracts";
import type { App, Caller, ClientInfo } from "@uketsugi/core";

/** A tool's result as a test reads it: the typed result, and the text the model is given. */
export type Called<N extends ToolName> = ToolResults[N] & { readonly text: string };

/** Calls one tool through the request pipeline; a call the pipeline refused throws its text. */
export type ToolCaller = <N extends ToolName>(
  tool: N,
  args: Record<string, unknown>,
) => Promise<Called<N>>;

/**
 * The calls of one person, client and project on an app, without a server between: how a test of
 * the use cases and the benchmark reach them. `args` may name another project.
 */
export function toolCaller(
  app: App,
  caller: Caller,
  client: ClientInfo,
  project: string,
): ToolCaller {
  return async <N extends ToolName>(tool: N, args: Record<string, unknown>) => {
    const result = await app.callTool(caller, tool, { project, ...args }, client);
    const text = result.content[0]?.text ?? "";
    if (result.isError) throw new Error(`${tool} was refused: ${text}`);
    return { ...(result.structuredContent as unknown as ToolResults[N]), text };
  };
}
