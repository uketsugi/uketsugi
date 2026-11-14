// @vitest-environment jsdom
import { BLOCK_START } from "@uketsugi/contracts";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activity, connect } from "./fixtures.ts";
import { answer, api, mockApi, open, violations } from "./support.ts";

describe("Connect", () => {
  mockApi();
  afterEach(() => vi.useRealTimers());

  /** The code block that holds exactly this text. */
  const codeOf = (text: string) => (_: string, shown: Element | null) =>
    shown?.tagName === "CODE" && shown.textContent === text;

  it("connects the first harness by installing its plugin: the lines to run, the token read from a variable", async () => {
    open("/connect");
    expect(await screen.findByRole("tab", { name: "Claude Code", selected: true })).toBeTruthy();
    const panel = within(screen.getByRole("tabpanel"));
    const [claude] = connect.harnesses;
    expect(panel.getByRole("heading", { name: "Install the plugin for Claude Code" })).toBeTruthy();
    expect(panel.getByText(connect.mcp_url)).toBeTruthy();
    // The lines read the token from a variable, so the line that sets it is given with them.
    expect(
      panel.getByText(codeOf(`${connect.token_command}\n${claude?.plugin?.install}`)),
    ).toBeTruthy();
    expect(panel.getAllByText(connect.token_env).length).toBeGreaterThan(0);
    expect(panel.getByText("ukt token")).toBeTruthy();
    expect(panel.getByText(/starts with its project's brief/)).toBeTruthy();
    expect(panel.getByText(claude?.plugin?.remove ?? "missing")).toBeTruthy();
    // With the plugin nobody adds the server by hand or types set-up: both are behind a disclosure.
    expect(panel.queryByRole("heading", { name: "Type the set-up command" })).toBeNull();
    expect(panel.queryByText(codeOf(`${connect.token_command}\n${claude?.add}`))).toBeNull();
    expect(await violations()).toEqual([]);
  });

  it("keeps the way without the plugin: the server added by its URL, then the set-up command", async () => {
    const user = open("/connect");
    const disclosure = await screen.findByRole("button", { name: "Without the plugin" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    await user.click(disclosure);
    const panel = within(screen.getByRole("tabpanel"));
    const [claude] = connect.harnesses;
    expect(panel.getByText(codeOf(`${connect.token_command}\n${claude?.add}`))).toBeTruthy();
    expect(panel.getByText(claude?.remove ?? "missing")).toBeTruthy();
    // The file is not in one place on every machine: the page gives the usual place and the
    // command the agent finds it with, and promises no path the agent may not write to.
    expect(panel.getByText("~/.claude/CLAUDE.md")).toBeTruthy();
    expect(panel.getByText(claude?.instruction_file_command ?? "missing")).toBeTruthy();
    expect(
      panel.getByText(/unless your harness keeps its configuration somewhere else/),
    ).toBeTruthy();
    expect(
      panel.getByText(/Your harness may ask you to approve that command and the edit\./),
    ).toBeTruthy();
    expect(panel.getByRole("heading", { name: "Type the set-up command" })).toBeTruthy();
    expect(panel.getByText("/uketsugi:setup")).toBeTruthy();
    expect(panel.getByRole("heading", { name: "Or, for one session only" })).toBeTruthy();
    expect(panel.getByText("/uketsugi:activate")).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it("has one tab for each harness the server describes, changed from the keyboard", async () => {
    const user = open("/connect");
    (await screen.findByRole("tab", { name: "Claude Code" })).focus();
    await user.keyboard("{ArrowRight}{Enter}");
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(connect.harnesses.map((harness) => harness.name));
    expect(screen.getByRole("tab", { name: "Antigravity", selected: true })).toBeTruthy();
    // A harness whose plugin does not bring the server: the server is added first, then the plugin.
    const antigravity = within(screen.getByRole("tabpanel"));
    const added = connect.harnesses[1];
    expect(
      antigravity
        .getAllByRole("heading", { level: 2 })
        .slice(0, 2)
        .map((heading) => heading.textContent),
    ).toEqual(["Add the server to Antigravity", "Install the plugin"]);
    expect(antigravity.getByText(codeOf(`${connect.token_command}\n${added?.add}`))).toBeTruthy();
    expect(antigravity.getByText(codeOf(added?.plugin?.install ?? "missing"))).toBeTruthy();
    expect(antigravity.getByText(/nobody places it in a file/)).toBeTruthy();
    expect(antigravity.queryByRole("heading", { name: "Type the set-up command" })).toBeNull();
    expect(await violations()).toEqual([]);
  });

  it("gives a harness with no set-up command the block to copy and the file it goes in, for someone without its plugin", async () => {
    const user = open("/connect?harness=antigravity");
    const panel = within(await screen.findByRole("tabpanel"));
    await user.click(panel.getByRole("button", { name: "Without the plugin" }));
    expect(
      panel.getByRole("heading", { name: "Put the block in the instruction file" }),
    ).toBeTruthy();
    // Nothing writes the block for this harness, so the step names the file and holds the block.
    expect(panel.getByText(/Antigravity does not offer a server's commands/)).toBeTruthy();
    expect(panel.getByText("~/.gemini/GEMINI.md")).toBeTruthy();
    expect(panel.getByText(codeOf(connect.block))).toBeTruthy();
    await user.click(panel.getByRole("button", { name: "Copy the block" }));
    expect(await navigator.clipboard.readText()).toBe(connect.block);
    // The block is not shown a second time for reference.
    expect(panel.queryByRole("button", { name: "The block set-up writes" })).toBeNull();
    expect(await violations()).toEqual([]);
  });

  it("gives a client that is neither its URL, and the block to place", async () => {
    open("/connect?harness=other");
    const panel = within(await screen.findByRole("tabpanel"));
    expect(panel.getByText("Give the client this URL:")).toBeTruthy();
    // The URL is said once and given once to copy.
    expect(panel.getAllByText(codeOf(connect.mcp_url))).toHaveLength(2);
    expect(panel.queryByRole("button", { name: "Without the plugin" })).toBeNull();
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

  it("copies the set-up command and says so", async () => {
    const user = open("/connect");
    await user.click(await screen.findByRole("button", { name: "Without the plugin" }));
    await user.click(await screen.findByRole("button", { name: "Copy the set-up command" }));
    expect(await navigator.clipboard.readText()).toBe("/uketsugi:setup");
    expect(await screen.findByText("Copied the set-up command")).toBeTruthy();
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
