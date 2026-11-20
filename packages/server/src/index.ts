/** The server package: the one composition function, and the wiring of the server `ukt` runs. */
export { composeServer, listenStarting, localUrl } from "./compose.ts";
export type {
  ComposeOptions,
  Edition,
  Listening,
  StartingListener,
  StartingOptions,
  UketsugiServer,
} from "./compose.ts";
export { startingFailure, type Starting } from "./starting.ts";
export type { HarnessRefusals, TokenNeed } from "./errors.ts";
export { hostProof } from "./auth.ts";
export { DEFAULT_HOST, loopbackOfEvery } from "./guard.ts";
export { connectInfo, word } from "./connect.ts";
export { SERVER_NAME } from "@uketsugi/contracts";
export { openLocalPorts, openPorts, startLocalServer } from "./local.ts";
export type {
  LocalPorts,
  LocalPortsOptions,
  LocalServer,
  LocalServerOptions,
  OpenedPorts,
  PortsOptions,
} from "./local.ts";
export {
  DEFAULT_DAILY_TOKENS,
  MODEL_PROVIDERS,
  modelName,
  modelSpec,
  parseModel,
  PROVIDERS,
} from "./model-runner.ts";
export type { ModelConfig, ModelProvider } from "./model-runner.ts";

/** The port `ukt serve` listens on unless it is told another. */
export const DEFAULT_PORT = 7410;
