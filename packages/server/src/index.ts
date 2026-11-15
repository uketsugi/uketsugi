/** The server package: the one composition function, and the wiring of the server `ukt` runs. */
export { composeServer, localUrl } from "./compose.ts";
export type { ComposeOptions, Listening, UketsugiServer } from "./compose.ts";
export { hostProof } from "./auth.ts";
export { DEFAULT_HOST, loopbackOfEvery } from "./guard.ts";
export { connectInfo, SERVER_NAME, word } from "./connect.ts";
export { openLocalPorts, startLocalServer } from "./local.ts";
export type { LocalPorts, LocalPortsOptions, LocalServer, LocalServerOptions } from "./local.ts";
export { DEFAULT_DAILY_TOKENS, MODEL_PROVIDERS, modelName } from "./model-runner.ts";
export type { ModelConfig, ModelProvider } from "./model-runner.ts";

/** The port `ukt serve` listens on unless it is told another. */
export const DEFAULT_PORT = 7410;
