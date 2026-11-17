/**
 * `ukt serve` with a language model, against a stand-in provider on this machine that speaks
 * OpenAI's chat API: what the operator is told, what `ukt doctor` reports, and a session's end
 * becoming a fact over the server's own routes. No key is used and no request leaves the machine.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityReport, CapabilityDescriptor, FactPage } from "@uketsugi/contracts";
import { chatAsked, chatCompletion, startFakeProvider, type FakeProvider } from "@uketsugi/testkit";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { doctor, type Finding } from "../src/doctor.ts";
import { resolveHome } from "../src/home.ts";
import { main } from "../src/index.ts";
import { token } from "../src/host-verbs.ts";
import { setup } from "../src/setup.ts";
import { hostModel, sentLine } from "../src/llm.ts";
import { digestLine, serve, type Serving } from "../src/serve.ts";
import { fakeIo, tempDir, type FakeIo } from "./support.ts";

const PROJECT = "github.com/acme/billing-service";
const SAID =
  "I traced the retry path. The webhook queue retries a failed delivery five times with " +
  "exponential backoff, capped at 30 seconds: see src/queue/retry.ts:40-62. Deliveries are " +
  "deduplicated on the event id in src/queue/dedupe.ts.";
const FACT = {
  claim: "The webhook queue retries a failed delivery five times with exponential backoff",
  question: "How often does the webhook queue retry a failed delivery?",
  citations: ["src/queue/retry.ts:40-62"],
  detail: "",
};

/** The stand-in as a model that answers the server's questions the way a real one would. */
function answering(provider: FakeProvider): void {
  provider.answerWith((request) => {
    const { system } = chatAsked(request);
    const said = system.includes("connection check") ? { ok: true } : { facts: [FACT] };
    return { body: chatCompletion(JSON.stringify(said)) };
  });
}

describe("ukt serve with the language model ukt setup remembered", () => {
  let root: string;
  let dataDir: string;
  let provider: FakeProvider;
  let serving: Serving;
  let io: FakeIo;
  let url: string;
  let held: string;

  const signed = () => ({ authorization: `Bearer ${held}`, "content-type": "application/json" });
  const read = async <T>(path: string): Promise<T> =>
    (await (await fetch(`${url}${path}`, { headers: signed() })).json()) as T;
  const languageModel = async (): Promise<Finding | undefined> => {
    const findings = (await doctor(fakeIo(), { dataDir }, {})).data["findings"] as Finding[];
    return findings.find((finding) => finding.check === "language model");
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ukt-llm-"));
    dataDir = join(root, "data");
    provider = await startFakeProvider();
    answering(provider);
    io = fakeIo();
    // The model is given once, at set-up, and a server started with nothing said finds it: a
    // service has no terminal to be told in.
    const listen = { dataDir, host: "127.0.0.1", port: "0" };
    const llm = { llm: "openai-compatible/local-test", llmUrl: provider.url };
    await setup(fakeIo(), { ...listen, ...llm, model: false }, {});
    serving = await serve(io, listen, {});
    url = serving.report.data["url"] as string;
    held = (await token(fakeIo(), { dataDir }, {})).lines[0] ?? "";
  });

  afterAll(async () => {
    await serving.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  });

  test("says which model it was given and what is sent there, and asks it nothing by starting", async () => {
    expect(serving.report.data).toMatchObject({ llm: "openai-compatible · local-test" });
    expect(serving.report.lines).toContain(
      `language model: ${sentLine("openai-compatible · local-test")}`,
    );
    expect(serving.report.lines).toContain(
      "language model: at most 1000000 tokens a day; readings wait once it is reached, and `ukt doctor` shows what has been used.",
    );
    expect(provider.received).toEqual([]);
    // It says of itself that it has one, and that reading sessions is a job it runs.
    const described = await read<CapabilityDescriptor>("/api/capabilities");
    expect(described.model_runners).toEqual(["endpoint"]);
    expect(described.features.jobs).toEqual(["embed", "consolidate", "digest"]);
  });

  test("ukt doctor says the model answers, and what asking cost", async () => {
    expect(await languageModel()).toEqual({
      check: "language model",
      state: "ok",
      detail:
        "openai-compatible · local-test answers (this check took 120 tokens in, 9 out). 0 of 1000000 tokens used in the last 24 hours.",
    });
  });

  test("ukt doctor --no-llm asks the model nothing, as a check on a timer must not", async () => {
    const before = provider.received.length;
    const findings = (await doctor(fakeIo(), { dataDir, llm: false }, {})).data[
      "findings"
    ] as Finding[];
    expect(findings.find((finding) => finding.check === "language model")).toEqual({
      check: "language model",
      state: "ok",
      detail: "configured; not asked (--no-llm)",
    });
    expect(provider.received).toHaveLength(before);
  });

  test("a session that ends without publishing leaves a fact that says a model wrote it, and what that cost", async () => {
    // What Claude Code's hooks send as a turn ends and as the conversation does.
    const hook = async (event: object): Promise<number> => {
      const sent = await fetch(`${url}/api/hooks/claude-code`, {
        method: "POST",
        headers: { ...signed(), "x-uketsugi-origin": `https://${PROJECT}.git` },
        body: JSON.stringify({ session_id: "conversation-1", ...event }),
      });
      return sent.status;
    };
    expect(await hook({ hook_event_name: "Stop", last_assistant_message: SAID })).toBe(200);
    expect(await hook({ hook_event_name: "SessionEnd" })).toBe(200);

    const facts = await vi.waitFor(async () => {
      const page = await read<FactPage>(`/api/facts?project=${encodeURIComponent(PROJECT)}`);
      expect(page.facts).toHaveLength(1);
      return page.facts;
    });
    const session = facts[0]?.from_session;
    expect(facts[0]).toMatchObject({ claim: FACT.claim, author: "you" });
    expect(session).toMatch(/^s-/);
    // The session's text reached the provider as the user's message, never as the system's.
    const asked = provider.received.map(chatAsked).find(({ user }) => user.includes("retry path"));
    expect(asked?.system).not.toContain("retry path");
    await vi.waitFor(() =>
      expect(io.outLines).toEqual([
        `language model: read session ${session} · wrote 1 fact · 120 tokens in, 9 out · 129 of 1000000 tokens used in the last day`,
      ]),
    );
    const { recent } = await read<ActivityReport>("/api/activity");
    expect(recent[0]?.digest).toMatchObject({ input_tokens: 120, output_tokens: 9 });
  });

  test("where the person turned on sending each turn, the model reads what was asked and each final answer, once", async () => {
    const project = "github.com/acme/turns";
    const hook = async (event: object, capture: boolean): Promise<void> => {
      const sent = await fetch(`${url}/api/hooks/claude-code`, {
        method: "POST",
        headers: {
          ...signed(),
          "x-uketsugi-origin": `https://${project}.git`,
          ...(capture ? { "x-uketsugi-capture": "true" } : {}),
        },
        body: JSON.stringify({ session_id: "conversation-2", ...event }),
      });
      expect(sent.status).toBe(200);
    };
    const asked = "Why do webhooks arrive twice?";
    // Without the switch a prompt that arrives is dropped: only the last message is kept, as a note.
    await hook(
      { hook_event_name: "UserPromptSubmit", prompt: "Something said in passing." },
      false,
    );
    await hook({ hook_event_name: "UserPromptSubmit", prompt: asked }, true);
    await hook({ hook_event_name: "Stop", last_assistant_message: SAID }, true);
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "And the cap?" }, true);
    await hook({ hook_event_name: "Stop", last_assistant_message: "The cap is 30 seconds." }, true);
    await hook({ hook_event_name: "SessionEnd" }, true);

    const records = () =>
      provider.received
        .map((request) => JSON.parse(chatAsked(request).user) as { said?: object[] })
        .filter((record) => JSON.stringify(record).includes(asked));
    await vi.waitFor(() => expect(records()).toHaveLength(1));
    expect(records()[0]?.said).toEqual([
      { request: asked, answer: SAID },
      { request: "And the cap?", answer: "The cap is 30 seconds." },
    ]);
    expect(JSON.stringify(provider.received.map(chatAsked))).not.toContain("said in passing");
  });

  test("ukt doctor fails a model that does not answer, with the provider's reason and what to check", async () => {
    provider.answerWith(() => ({
      status: 401,
      body: { error: { message: "Incorrect API key provided.", type: "invalid_request_error" } },
    }));
    const finding = await languageModel().finally(() => answering(provider));
    expect(finding).toEqual({
      check: "language model",
      state: "fail",
      detail:
        "openai-compatible · local-test does not answer: the provider refused the call (status 401): Incorrect API key provided.",
      fix: "give the model and its key again with `ukt setup --llm <provider/model>` (or check UKT_LLM, UKT_LLM_KEY and UKT_LLM_URL where the server starts), then start the server again",
    });
  });
});

describe("the line ukt serve prints for a session a model read", () => {
  const report = {
    session: "s-41ab",
    read: 6,
    written: 2,
    refused: { uncited: 1, repeat: 3, invalid: 0 },
    merged: 1,
    flagged: 2,
    chose: true,
    tokens: { input: 5210, output: 640 },
    unread: 0,
    waited: false,
    kept: 0,
    day: { used: 6000, limit: 1_000_000 },
  };

  test("says what was written, what was left out and why, and what the reading cost", () => {
    expect(digestLine(report)).toBe(
      "language model: read session s-41ab · wrote 2 facts · left out 4 (1 without a source, 3 already held, 0 not valid) · merged 1 · raised 2 flags · chose the next brief's facts · 5210 tokens in, 640 out · 6000 of 1000000 tokens used in the last day",
    );
  });

  test("says what a session that reached its ceiling dropped, and that a waiting session waits for the budget", () => {
    expect(digestLine({ ...report, unread: 3 })).toContain(
      "3 turns dropped unread, the session reached what a session may cost",
    );
    expect(digestLine({ ...report, waited: true })).toBe(
      "language model: session s-41ab waits, the day's budget has no room for it yet (6000 of 1000000 tokens used in the last day)",
    );
  });

  test("says only what happened", () => {
    const quiet = { ...report, written: 0, merged: 0, flagged: 0, chose: false };
    expect(digestLine({ ...quiet, refused: { uncited: 0, repeat: 0, invalid: 0 } })).toBe(
      "language model: read session s-41ab · wrote 0 facts · 5210 tokens in, 640 out · 6000 of 1000000 tokens used in the last day",
    );
  });
});

describe("the language model a host is given", () => {
  const llmOf = async (
    dataDir: string,
    options: { llm?: string; llmUrl?: string; llmBudget?: string },
    env: NodeJS.ProcessEnv = {},
  ) => hostModel(resolveHome(dataDir, {}), options, env);
  const refusalOf = async (work: Promise<unknown>): Promise<string> => {
    const refused = await work.then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({ failure: { meaning: "Nothing was started or changed." } });
    const { what, next } = (refused as { failure: { what: string; next: string } }).failure;
    return `${what} ${next}`;
  };

  test("is none unless one is named: a key in the environment alone configures nothing", async () => {
    const dataDir = await tempDir();
    const keys = { UKT_LLM_KEY: "sk-held", OPENAI_API_KEY: "sk-other" };
    expect(await llmOf(dataDir, {}, keys)).toBeNull();
    expect(await llmOf(dataDir, { llm: "  " }, keys)).toBeNull();
  });

  test("is named as provider/model, and a model's own name may hold a slash", async () => {
    const dataDir = await tempDir();
    const env = { UKT_LLM_KEY: "sk-held" };
    expect(await llmOf(dataDir, { llm: "google/gemini-3.8-flash" }, env)).toEqual({
      provider: "google",
      model: "gemini-3.8-flash",
      apiKey: "sk-held",
    });
    const routed = { llm: "openai-compatible/meta/llama-4", llmUrl: "http://x/v1" };
    expect(await llmOf(dataDir, routed)).toEqual({
      provider: "openai-compatible",
      model: "meta/llama-4",
      apiKey: "",
      baseUrl: "http://x/v1",
    });
  });

  test.each([
    ["gemini-3.8-flash", {}, /is not a language model --llm takes/],
    ["mistral/large", {}, /provider one of google, openai, anthropic, openai-compatible/],
    ["google/", {}, /is not a language model --llm takes/],
    [
      "google/gemini-3.8-flash",
      {},
      /no key for it was given.+ukt setup --llm google\/gemini-3.8-flash/,
    ],
    ["openai-compatible/llama", { UKT_LLM_KEY: "k" }, /no address says where it is/],
  ])("refuses %s before anything starts, and says what to pass", async (llm, env, why) => {
    expect(await refusalOf(llmOf(await tempDir(), { llm }, env))).toMatch(why);
  });

  test("ukt setup remembers it with its key in a file that is the person's alone, and a bare ukt serve finds it", async () => {
    const dataDir = await tempDir();
    const base = { dataDir, host: "127.0.0.1", port: "7410", model: false };
    const told = await setup(
      fakeIo(),
      { ...base, llm: "google/gemini-3.8-flash" },
      { UKT_LLM_KEY: "sk-held" },
    );
    const file = join(dataDir, "llm.json");
    expect(told.lines).toContain(
      `language model  google · gemini-3.8-flash, remembered with its key in ${file}, 1000000 tokens a day at most`,
    );
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // The key is in that file and in nothing setup says.
    expect(JSON.stringify(told)).not.toContain("sk-held");
    const remembered = { provider: "google", model: "gemini-3.8-flash", apiKey: "sk-held" };
    expect(await llmOf(dataDir, {})).toEqual(remembered);
    // Set up again with nothing said, it is left as it is, and reported.
    const again = await setup(fakeIo(), base, {});
    expect(again.lines.join("\n")).toContain(
      `language model  google · gemini-3.8-flash, remembered in ${file}`,
    );
    expect(await llmOf(dataDir, {})).toEqual(remembered);

    // A budget told alone changes the one remembered, and asks for no key.
    await setup(fakeIo(), { ...base, llmBudget: "250000" }, {});
    expect(await llmOf(dataDir, {})).toEqual({ ...remembered, dailyTokens: 250_000 });
    expect(await llmOf(dataDir, { llmBudget: "40000" })).toMatchObject({ dailyTokens: 40_000 });
    expect(await refusalOf(llmOf(dataDir, { llmBudget: "lots" }))).toMatch(/not a budget/);
    // Below what one reading costs, nothing would ever be read: it is refused, not accepted and then waited on.
    expect(await refusalOf(llmOf(dataDir, { llmBudget: "4000" }))).toMatch(/not a budget/);
    await setup(fakeIo(), { ...base, llmBudget: "1000000" }, {});

    // What a run names itself comes first: the same model takes the remembered key, another needs its own.
    expect(await llmOf(dataDir, { llm: "google/gemini-3.8-flash" })).toEqual(remembered);
    expect(await refusalOf(llmOf(dataDir, { llm: "openai/gpt-5-mini" }))).toMatch(/no key for it/);
    expect(await llmOf(dataDir, { llm: "none" })).toBeNull();

    const forgotten = await setup(fakeIo(), { ...base, llm: "none" }, {});
    expect(forgotten.lines).toContain(
      "language model  none: google · gemini-3.8-flash is forgotten",
    );
    expect(await llmOf(dataDir, {})).toBeNull();
    expect((await setup(fakeIo(), base, {})).lines.join("\n")).not.toContain("language model");
  });

  test("a container's start, which runs ukt setup with the model in its environment, remembers nothing of it", async () => {
    const dataDir = await tempDir();
    const env = { UKT_LLM: "google/gemini-3.8-flash", UKT_LLM_KEY: "sk-held" };
    const io = fakeIo();
    expect(await main(["setup", "--data-dir", dataDir, "--no-model"], io, env)).toBe(0);
    expect(io.outLines.join("\n")).not.toContain("language model");
    // The run itself still has its model, from the same environment, and none once that is gone.
    expect(await llmOf(dataDir, { llm: env.UKT_LLM }, env)).toMatchObject({ apiKey: "sk-held" });
    expect(await llmOf(dataDir, {}, {})).toBeNull();
  });

  test("ukt setup asks for the key at the terminal, unseen, where the environment holds none", async () => {
    const dataDir = await tempDir();
    const base = { dataDir, host: "127.0.0.1", port: "7410", model: false };
    const io = fakeIo({ interactive: true, secret: "sk-typed" });
    await setup(io, { ...base, llm: "anthropic/claude-haiku-4-5" }, {});
    expect(io.questions).toEqual(["The key for anthropic · claude-haiku-4-5"]);
    expect(await llmOf(dataDir, {})).toMatchObject({ provider: "anthropic", apiKey: "sk-typed" });
    // With nobody to ask and no key, nothing is remembered.
    const other = await tempDir();
    const silent = setup(fakeIo(), { ...base, dataDir: other, llm: "openai/gpt-5-mini" }, {});
    expect(await refusalOf(silent)).toMatch(/no key for it was given/);
    expect(await llmOf(other, {})).toBeNull();
  });
});
