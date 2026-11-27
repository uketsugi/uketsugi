/**
 * What other packages use of core. The domain's records and the two port files are a store
 * adapter's whole contract, so they are exported whole; everything else is named.
 */
export * from "./domain.ts";
export type * from "./store-port.ts";
export type * from "./search-port.ts";
export { AnswerError, AuthError, EmbedError, ModelError } from "./ports.ts";
export type {
  AuthFailure,
  Chore,
  Clock,
  CorePorts,
  Embedder,
  IdGen,
  Identity,
  ModelAnswer,
  ModelVector,
  ModelRunner,
} from "./ports.ts";
export { createApp, UnknownToolError } from "./app.ts";
export type { App, AppPorts } from "./app.ts";
export { scopeOf, servedByModel } from "./context.ts";
export { ToolFailure } from "./failure.ts";
export { validateRequest } from "./validate.ts";
export { createWorker } from "./jobs/worker.ts";
export { armDigest } from "./digest/arm.ts";
export { MIN_DAILY_TOKENS, RESERVE_TOKENS, SESSION_TOKENS, WAIT_MS } from "./digest/budget.ts";
export { MOST_TURNS_KEPT } from "./digest/record.ts";
export type { DigestReport } from "./jobs/digest.ts";
export {
  acceptToken,
  createTokenIdentity,
  ensureOwner,
  invitePerson,
  issueToken,
  listPeople,
  principalSeed,
  removePerson,
  replaceTokens,
  revokeToken,
  RevokedTokenError,
} from "./identity.ts";
export { newSession, SESSION_IDLE_MS, type ClientInfo } from "./sessions.ts";
export { createNamedProject, listProjects } from "./project.ts";
export { listRulings, revertRuling } from "./facts/rulings.ts";
export { isUuid } from "./facts/citations.ts";
export { activityReport, removeNote } from "./usecases/activity.ts";
export { checkModel } from "./usecases/model-check.ts";
export { exportMarkdown } from "./usecases/facts/export.ts";
export { factDetail, listFacts } from "./usecases/facts/list.ts";
export { confirmFact, correctFact } from "./usecases/facts/correct.ts";
export { redactFact } from "./usecases/facts/redact.ts";
export { deleteProject, projectContents } from "./usecases/forget-project.ts";
export { listTasks, taskDetail } from "./usecases/tasks/list.ts";
export { closeTask } from "./usecases/tasks/update.ts";
export type { Conversation, TurnSide } from "./usecases/session-note.ts";
export { chooseTreatment } from "./usecases/sharing.ts";
export { toHex } from "./hash.ts";
export { normalizeText } from "./text/analyze.ts";
export { passValuesOf, SEARCH_PROFILE, type SearchProfile } from "./search/fusion.ts";
