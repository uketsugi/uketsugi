// @vitest-environment jsdom
import { BLOCK_START } from "@uketsugi/contracts";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activity, connect, connectWithToken, hostedCapabilities } from "./fixtures.ts";
import { answer, api, mockApi, open, violations } from "./support.ts";

describe("Connect", () => {
  mockApi();
  afterEach(() => vi.useRealTimers());

  /** The code block that holds exactly this text. */
  const codeOf = (text: string) => (_: string, shown: Element | null) =>
    shown?.tagName === "CODE" && shown.textContent === text;

  it("connects a harness on a server that needs no token by its address alone, then the activate command", async () => {
    open("/connect");
    expect(await screen.findByRole("tab", { name: "Claude Code", selected: true })).toBeTruthy();
    const panel = within(screen.getByRole("tabpanel"));
    const [claude] = connect.harnesses;
    expect(panel.getByRole("heading", { name: "Add the server to Claude Code" })).toBeTruthy();
    expect(panel.getByText(connect.mcp_url)).toBeTruthy();
    // No token is asked for, so the line is given as it is: nothing sets a variable first.
    expect(panel.getByText(codeOf(claude?.add ?? "missing"))).toBeTruthy();
    expect(panel.getByText(/none: this server takes a harness on this machine/)).toBeTruthy();
    expect(panel.queryByText(connect.token_command, { exact: false })).toBeNull();
    expect(
      panel.getByRole("heading", { name: "Type the activate command in a session" }),
    ).toBeTruthy();
    expect(panel.getByText(codeOf("/uketsugi:activate"))).toBeTruthy();
    expect(panel.getByText(/How this is known: run here: Claude Code 2\.1\.325/)).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it("gives the lines that read a token from a variable where the server needs one", async () => {
    api.use(answer("/api/connect", connectWithToken));
    open("/connect");
    const panel = within(await screen.findByRole("tabpanel"));
    const [claude] = connectWithToken.harnesses;
    expect(panel.getByText(codeOf(`${connect.token_command}\n${claude?.add}`))).toBeTruthy();
    expect(panel.getAllByText(connect.token_env).length).toBeGreaterThan(0);
    expect(panel.getByText("ukt token")).toBeTruthy();
    expect(panel.getByText(claude?.remove ?? "missing")).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it("says another edition's words about the token, and none of the open edition's", async () => {
    api.use(
      answer("/api/connect", {
        ...connectWithToken,
        token_command: hostedCapabilities.dashboard.token_command,
      }),
      answer("/api/capabilities", hostedCapabilities),
    );
    open("/connect");
    const panel = within(await screen.findByRole("tabpanel"));
    const words = hostedCapabilities.dashboard;
    expect(panel.getByText(words.token_row, { exact: false })).toBeTruthy();
    expect(panel.getByText(words.shell_intro)).toBeTruthy();
    expect(panel.getByText(words.shell_elsewhere)).toBeTruthy();
    expect(panel.getByText(/signs in again when it is told to/)).toBeTruthy();
    expect(
      panel.getByText(codeOf(`${words.token_command}\n${connectWithToken.harnesses[0]?.add}`)),
    ).toBeTruthy();
    expect(panel.queryByText(/ukt token/)).toBeNull();
    expect(await violations()).toEqual([]);
  });

  it("offers the plugin as an extra, behind a disclosure, with the way to type set-up for every session", async () => {
    const user = open("/connect");
    const [claude] = connect.harnesses;
    const panel = within(await screen.findByRole("tabpanel"));
    // The file is not in one place on every machine: the page gives the usual place and the
    // command the agent finds it with, and promises no path the agent may not write to.
    expect(panel.getByRole("heading", { name: /type the set-up command/ })).toBeTruthy();
    expect(panel.getByText(codeOf("/uketsugi:setup"))).toBeTruthy();
    expect(panel.getByText("~/.claude/CLAUDE.md")).toBeTruthy();
    expect(panel.getByText(claude?.instruction_file_command ?? "missing")).toBeTruthy();
    expect(
      panel.getByText(/unless your harness keeps its configuration somewhere else/),
    ).toBeTruthy();
    const disclosure = panel.getByRole("button", { name: "With the plugin as well" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    await user.click(disclosure);
    expect(panel.getByText(codeOf(claude?.plugin?.install ?? "missing"))).toBeTruthy();
    expect(panel.getByText(claude?.plugin?.remove ?? "missing")).toBeTruthy();
    expect(panel.getByText(/starts with its project's brief/)).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it("has one tab for each harness the server describes, changed from the keyboard", async () => {
    const user = open("/connect");
    (await screen.findByRole("tab", { name: "Claude Code" })).focus();
    await user.keyboard("{ArrowRight}{Enter}");
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(connect.harnesses.map((harness) => harness.name));
    expect(screen.getByRole("tab", { name: "Antigravity", selected: true })).toBeTruthy();
    const antigravity = within(screen.getByRole("tabpanel"));
    const added = connect.harnesses[1];
    expect(antigravity.getByText(codeOf(added?.add ?? "missing"))).toBeTruthy();
    // It offers no command, so the block is put in its file by hand; the plugin is an extra.
    expect(antigravity.queryByRole("heading", { name: /activate command/ })).toBeNull();
    expect(
      antigravity.getByRole("heading", { name: "Put the block in the instruction file" }),
    ).toBeTruthy();
    expect(antigravity.getByText(/Antigravity does not offer a server's commands/)).toBeTruthy();
    expect(antigravity.getByText("~/.gemini/GEMINI.md")).toBeTruthy();
    expect(antigravity.getByText(codeOf(connect.block))).toBeTruthy();
    await user.click(antigravity.getByRole("button", { name: "Copy the block" }));
    expect(await navigator.clipboard.readText()).toBe(connect.block);
    // The block is not shown a second time for reference.
    expect(antigravity.queryByRole("button", { name: "The block set-up writes" })).toBeNull();
    await user.click(antigravity.getByRole("button", { name: "With the plugin as well" }));
    expect(antigravity.getByText(codeOf(added?.plugin?.install ?? "missing"))).toBeTruthy();
    expect(antigravity.getByText(/nobody places it in a file/)).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it("tells Cursor's person which file to edit and what to put in it", async () => {
    open("/connect?harness=cursor");
    const panel = within(await screen.findByRole("tabpanel"));
    expect(panel.getByText(/In ~\/\.cursor\/mcp\.json, under "mcpServers", add:/)).toBeTruthy();
    expect(panel.getByText(codeOf(`"uketsugi": {"url": "${connect.mcp_url}"}`))).toBeTruthy();
  });

  it("gives a client that is neither its URL, and the block to place", async () => {
    open("/connect?harness=other");
    const panel = within(await screen.findByRole("tabpanel"));
    expect(panel.getByText("Give the client this URL:")).toBeTruthy();
    // The URL is said once and given once to copy.
    expect(panel.getAllByText(codeOf(connect.mcp_url))).toHaveLength(2);
    expect(panel.queryByRole("button", { name: "With the plugin as well" })).toBeNull();
    expect(
      panel.getByRole("heading", { name: "Put the block in the instruction file" }),
    ).toBeTruthy();
  });

  it("says where a directory with no origin remote gets a project name", async () => {
    open("/connect");
    const panel = within(await screen.findByRole("tabpanel"));
    expect(panel.getByText(/a repository with no origin remote/)).toBeTruthy();
    expect(panel.getByRole("link", { name: "Projects" }).getAttribute("href")).toBe("/projects");
  });

  it("shows the block for reference only: behind a disclosure, with nothing that copies it", async () => {
    const user = open("/connect");
    const disclosure = await screen.findByRole("button", { name: "The block set-up writes" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    disclosure.focus();
    await user.keyboard("{Enter}");
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(BLOCK_START, { exact: false }).textContent).toBe(connect.block);
    expect(screen.queryByRole("button", { name: /copy.*block/i })).toBeNull();
    expect(await violations()).toEqual([]);
  });

  it("copies the activate command and says so", async () => {
    const user = open("/connect");
    await user.click(await screen.findByRole("button", { name: "Copy the activate command" }));
    expect(await navigator.clipboard.readText()).toBe("/uketsugi:activate");
    expect(await screen.findByText("Copied the activate command")).toBeTruthy();
  });

  it("waits for the first session and shows it when it arrives, with what it did", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.use(answer("/api/activity", { ...activity, recent: [] }));
    open("/connect");
    expect(await screen.findByText(/Waiting for the first session/)).toBeTruthy();

    api.use(answer("/api/activity", activity));
    await vi.advanceTimersByTimeAsync(5000);
    const sessions = within(await screen.findByRole("region", { name: "Recent sessions" }));
    expect(await sessions.findByText("s-7f2c")).toBeTruthy();
    expect(sessions.getByText("searched").querySelector("svg")).not.toBeNull();
    expect(sessions.getByText("2 refused for a missing project")).toBeTruthy();
    expect(sessions.queryByText("published")).toBeNull();
    expect(sessions.getByRole("status").textContent).toBe("1 recent sessions");
    expect(sessions.getByText(/Waiting for the next session/)).toBeTruthy();
  });
});
