/**
 * The tool table: every tool the contract names, with what a call of it does to its session's
 * record, the use case that answers it and the text its result is read as. A tool is served once
 * it has a row here.
 */
import type { ToolInputs, ToolName, ToolResults } from "@uketsugi/contracts";
import type { CallContext, Outcome } from "./context.ts";
import type { SessionMark } from "./domain.ts";
import { renderPublish, renderSearch, renderUpdate } from "./facts/views.ts";
import type { CorePorts } from "./ports.ts";
import {
  renderClaimTask,
  renderPublishTask,
  renderSearchTasks,
  renderUpdateTask,
} from "./tasks/views.ts";
import { publishFact } from "./usecases/facts/publish.ts";
import { searchFacts } from "./usecases/facts/search.ts";
import { updateFact } from "./usecases/facts/update.ts";
import { claimTask } from "./usecases/tasks/claim.ts";
import { publishTask } from "./usecases/tasks/publish.ts";
import { searchTasks } from "./usecases/tasks/search.ts";
import { updateTask } from "./usecases/tasks/update.ts";

export interface Tool<N extends ToolName> {
  readonly mark: SessionMark;
  /** Answers a call whose arguments are validated, without what every result carries. */
  run(ports: CorePorts, ctx: CallContext, input: ToolInputs[N]): Promise<Outcome<ToolResults[N]>>;
  /** The result as the agent reads it. */
  render(result: ToolResults[N]): string;
}

export const TOOL_TABLE: { readonly [N in ToolName]: Tool<N> } = {
  search_facts: { mark: "search", run: searchFacts, render: renderSearch },
  publish_fact: { mark: "publish", run: publishFact, render: renderPublish },
  update_fact: { mark: "other", run: updateFact, render: renderUpdate },
  search_tasks: { mark: "other", run: searchTasks, render: renderSearchTasks },
  publish_task: { mark: "other", run: publishTask, render: renderPublishTask },
  claim_task: { mark: "other", run: claimTask, render: renderClaimTask },
  update_task: { mark: "other", run: updateTask, render: renderUpdateTask },
};
