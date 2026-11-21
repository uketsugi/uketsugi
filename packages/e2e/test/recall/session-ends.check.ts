/**
 * How a session ends, told apart: stand-in `claude` programs in the real sandbox end at a deadline,
 * on a refused call, and on their own failure; stand-in servers are killed from outside and exit
 * on an error.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { endWithServer, sessionEnd, serverEnd, type End } from "../../src/recall/ending.ts";
import { Environment } from "../../src/recall/environment.ts";
import { start, stop, watchExit } from "../../src/recall/process.ts";
import { runSession } from "../../src/recall/session.ts";
import { treeStatus } from "../../src/recall/firstwrite.ts";
import { Workspace } from "../../src/recall/workspace.ts";

let root = "";
let workspace: Workspace;
let n = 0;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "recall-check-ends-"));
  process.env["TMPDIR"] = root;
  process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "stand-in-token-for-checks";
  workspace = await Workspace.create();
});

afterAll(async () => {
  await workspace.close();
  rmSync(root, { recursive: true, force: true });
});

/** A session of a stand-in `claude` whose script is `body`, ended at `capMs` if it has not ended. */
async function sessionOf(body: string, capMs?: number): Promise<End> {
  const dir = join(root, `s${n++}`);
  mkdirSync(join(dir, "tree"), { recursive: true });
  mkdirSync(join(dir, "home"));
  const claude = join(dir, "claude");
  writeFileSync(claude, `#!/bin/sh\n${body}\n`);
  chmodSync(claude, 0o755);
  const environment = await Environment.create(
    workspace,
    { goroot: "", pythonBase: "", claude },
    `e${n}`,
  );
  try {
    const result = await runSession(environment, {
      home: join(dir, "home"),
      tree: join(dir, "tree"),
      prompt: "hello",
      model: "haiku",
      allowedTools: "",
      transcript: join(dir, "t.jsonl"),
      ...(capMs === undefined ? {} : { capMs }),
    });
    return result.end;
  } finally {
    await environment.close();
  }
}

/** A session of a stand-in `claude` that writes a file in its tree, says so as a Write call and result, then sleeps: quick mode ends it at that write. */
async function stoppedAtFirstWrite(): Promise<{ end: End; killed: boolean; written: boolean }> {
  const dir = join(root, `w${n++}`);
  mkdirSync(join(dir, "tree"), { recursive: true });
  mkdirSync(join(dir, "home"));
  execFileSync("git", ["init", "-q"], { cwd: join(dir, "tree") });
  const claude = join(dir, "claude");
  const call = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "w1", name: "Write", input: {} }] },
  });
  const result = JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "ok" }] },
  });
  writeFileSync(
    claude,
    `#!/bin/sh\necho 'x' > changed.txt\necho '${call}'\necho '${result}'\nsleep 600\n`,
  );
  chmodSync(claude, 0o755);
  const environment = await Environment.create(
    workspace,
    { goroot: "", pythonBase: "", claude },
    `w${n}`,
  );
  try {
    const tree = join(dir, "tree");
    const r = await runSession(environment, {
      home: join(dir, "home"),
      tree,
      prompt: "hello",
      model: "haiku",
      allowedTools: "",
      transcript: join(dir, "t.jsonl"),
      baseline: await treeStatus(tree),
      stopAtFirstWrite: true,
    });
    return { end: r.end, killed: r.killed, written: r.firstWrite !== null };
  } finally {
    await environment.close();
  }
}

const REJECTED = `echo '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","utilization":0.5}}'`;

describe("a session's end", () => {
  test("a session that sleeps is stopped at its deadline and says capped, with the time", async () => {
    const end = await sessionOf("sleep 600", 1500);
    expect(end.kind).toBe("capped");
    expect((end as { seconds: number }).seconds).toBeGreaterThanOrEqual(1);
    expect((end as { seconds: number }).seconds).toBeLessThan(30);
  }, 60_000);

  test("a session that ends on a refused call is a provider void", async () => {
    const end = await sessionOf(
      `${REJECTED}\necho '{"type":"result","is_error":true,"api_error_status":429}'\nexit 1`,
    );
    expect(end).toMatchObject({ kind: "void", cause: "provider" });
  }, 60_000);

  test("a session that exits 1 on its own is a harness failure, recorded as itself", async () => {
    const end = await sessionOf("echo broken >&2\nexit 1");
    expect(end).toMatchObject({ kind: "harness", code: 1 });
  }, 60_000);

  test("a session stopped on purpose at its first write is done, not a harness failure", async () => {
    const stopped = await stoppedAtFirstWrite();
    expect(stopped.killed).toBe(true);
    expect(stopped.written).toBe(true);
    expect(stopped.end).toEqual({ kind: "done" });
  }, 60_000);

  test("a session that finishes is done", async () => {
    const end = await sessionOf(`echo '{"type":"result","is_error":false,"result":"ok"}'`);
    expect(end).toEqual({ kind: "done" });
  }, 60_000);
});

describe("classifying what a run saw", () => {
  const seen = { capped: null, killed: false, started: true, code: 0, stderr: "" };

  test("429, 529, a rejected rate-limit event and an API error with no result are the provider's", () => {
    const refused = (transcript: string): End => sessionEnd({ ...seen, code: 1, transcript });
    for (const transcript of [
      '{"type":"result","is_error":true,"api_error_status":429}',
      '{"type":"result","is_error":true,"api_error_status":529}',
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}',
      '{"type":"assistant","error":"server_error","message":{"content":[]}}',
    ])
      expect(refused(transcript)).toMatchObject({ kind: "void", cause: "provider" });
    expect(
      sessionEnd({
        ...seen,
        code: 1,
        transcript:
          '{"type":"assistant","error":"server_error"}\n{"type":"result","is_error":false}',
      }).kind,
    ).toBe("harness");
  });

  test("a capped session whose server also died is still capped; a done one is not", () => {
    const died: End = { kind: "miss", detail: "the server exited with code 3" };
    expect(endWithServer({ kind: "capped", seconds: 5 }, died)).toEqual({
      kind: "capped",
      seconds: 5,
    });
    expect(endWithServer({ kind: "void", cause: "provider", detail: "x" }, died).kind).toBe("void");
    expect(endWithServer({ kind: "done" }, died)).toEqual(died);
    expect(endWithServer({ kind: "done" }, undefined)).toEqual({ kind: "done" });
    expect(sessionEnd({ ...seen, capped: 1320, code: null, transcript: "" })).toEqual({
      kind: "capped",
      seconds: 1320,
    });
  });

  test("a session ended on purpose is done, unless the provider refused it", () => {
    expect(sessionEnd({ ...seen, killed: true, code: null, transcript: "" })).toEqual({
      kind: "done",
    });
    expect(
      sessionEnd({
        ...seen,
        killed: true,
        code: null,
        transcript: '{"type":"result","is_error":true,"api_error_status":429}',
      }).kind,
    ).toBe("void");
  });

  test("a box that will not start is the machine's", () => {
    expect(sessionEnd({ ...seen, started: false, code: 1, transcript: "" })).toMatchObject({
      kind: "void",
      cause: "machine",
    });
  });

  test("a server killed from outside is a machine void; one that exits on an error is a miss; one we stopped is neither", async () => {
    const killed = start("sleep", ["300.1"], { stdio: "ignore" });
    const exitOfKilled = watchExit(killed);
    const failing = start("sh", ["-c", "exit 3"], { stdio: "ignore" });
    const exitOfFailing = watchExit(failing);
    const failingClosed = new Promise((resolve) => failing.once("close", resolve));
    const ours = start("sleep", ["300.2"], { stdio: "ignore" });
    const exitOfOurs = watchExit(ours);
    const dead = new Promise((resolve) => killed.once("close", resolve));
    process.kill(-(killed.pid as number), "SIGKILL");
    await dead;
    await failingClosed;
    await stop(ours);
    expect(serverEnd(exitOfKilled())).toMatchObject({ kind: "void", cause: "machine" });
    expect(serverEnd(exitOfFailing())).toMatchObject({ kind: "miss" });
    expect(serverEnd(exitOfOurs())).toBeUndefined();
  }, 60_000);
});

describe("the harness's own memory", () => {
  /** What a stand-in `claude` saw of CLAUDE_CODE_DISABLE_AUTO_MEMORY. */
  async function flagSeen(harnessMemory?: boolean): Promise<string> {
    const dir = join(root, `m${n++}`);
    mkdirSync(join(dir, "tree"), { recursive: true });
    mkdirSync(join(dir, "home"));
    const claude = join(dir, "claude");
    writeFileSync(claude, `#!/bin/sh\necho "flag=\${CLAUDE_CODE_DISABLE_AUTO_MEMORY-unset}"\n`);
    chmodSync(claude, 0o755);
    const environment = await Environment.create(
      workspace,
      { goroot: "", pythonBase: "", claude },
      `m${n}`,
    );
    try {
      await runSession(environment, {
        home: join(dir, "home"),
        tree: join(dir, "tree"),
        prompt: "hello",
        model: "haiku",
        allowedTools: "",
        transcript: join(dir, "t.jsonl"),
        ...(harnessMemory === undefined ? {} : { harnessMemory }),
      });
      return readFileSync(join(dir, "t.jsonl"), "utf8").trim();
    } finally {
      await environment.close();
    }
  }

  test("is switched off for the recall suite's sessions and left as a person has it when a run asks for it", async () => {
    expect(await flagSeen()).toBe("flag=1");
    expect(await flagSeen(true)).toBe("flag=unset");
  }, 60_000);
});
