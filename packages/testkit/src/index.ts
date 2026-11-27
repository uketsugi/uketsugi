/** Test support: fakes for the ports that read the world, an MCP client, a tool caller, a test database, and the conformance suites a port's adapter must pass. */
export { everyoneOf, FakeClock, FakeEmbedder, FakeIdGen, FakeRunner, fakeUuid } from "./fakes.ts";
export { eventually } from "./eventually.ts";
export { HANG_GUARD_MS } from "./guard.ts";
export { connectMcp } from "./mcp-client.ts";
export type { McpCallResult, McpTestClient } from "./mcp-client.ts";
export { toolCaller, type Called, type ToolCaller } from "./tool-caller.ts";
export {
  chatAsked,
  chatCompletion,
  startFakeProvider,
  type FakeProvider,
  type ProviderRequest,
} from "./provider.ts";
export {
  createTestDatabase,
  onTestServer,
  TEST_POSTGRES_URL,
  type TestDatabase,
} from "./postgres.ts";
export { describeModelStepConformance } from "./conformance/model-step.ts";
export { describeEmbedderConformance } from "./conformance/embedder.ts";
export { describeGroupConformance } from "./conformance/groups.ts";
export { describeMoveConformance } from "./conformance/moves.ts";
export { describeStoreConformance } from "./conformance/store.ts";
export { describeTaskStoreConformance } from "./conformance/tasks.ts";
export {
  content as sampleFactContent,
  event as sampleEvent,
  PROJECT as SAMPLE_PROJECT,
  targetOf,
  type StoreHarness,
} from "./conformance/support.ts";
