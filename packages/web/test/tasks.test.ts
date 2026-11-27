// @vitest-environment jsdom
import { API_REQUEST_SCHEMAS, type TaskDetail } from "@uketsugi/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  HANDOFF,
  handedOff,
  held,
  lapsed,
  PROJECT,
  projects,
  TASK,
  tasks,
  unavailable,
} from "./fixtures.ts";
import { answer, api, mockApi, open, violations } from "./support.ts";

const LISTED = "Tasks that are not done, in the order an agent could pick them up";

/** The bounds the contract puts on how many tasks one request lists. */
const { limit: LIMIT } = API_REQUEST_SCHEMAS.TaskListParams.properties as {
  limit: { default: number; maximum: number };
};

/** Answers the list with what `page` makes of each query, and keeps the queries. */
function listing(page: (query: Record<string, string>) => object): Record<string, string>[] {
  const asked: Record<string, string>[] = [];
  api.use(
    http.get("*/api/tasks", ({ request }) => {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      asked.push(query);
      return HttpResponse.json(page(query));
    }),
  );
  return asked;
}

/** One section of the open drawer, by its heading. */
function section(name: string) {
  const drawer = within(screen.getByRole("dialog", { name: "Task" }));
  const found = drawer.getByRole("heading", { name }).parentElement;
  if (found === null) throw new Error(`the drawer has no section ${name}`);
  return within(found);
}

describe("Tasks", () => {
  mockApi();

  it("lists the tasks in an agent's own order, each with its state as a shape and a word, its lease and its newest note", async () => {
    open("/tasks");
    const table = within(await screen.findByRole("table", { name: LISTED }));
    const headers = table.getAllByRole("columnheader").map((header) => header.textContent);
    expect(headers).toEqual(["Task", "State"]);
    for (const word of ["handed off", "open · lease lapsed", "claimed"]) {
      expect(table.getByText(word).querySelector("svg[aria-hidden]")).not.toBeNull();
    }
    const [first, second, third] = table
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row));
    expect(first?.getByRole("link", { name: TASK })).toBeTruthy();
    const about = first?.getByText(`by you · ${PROJECT} · shared · changed`);
    expect(about?.textContent).toMatch(/ · changed .+ ago$/);
    expect(first?.getByText(HANDOFF).textContent).toBe(`Handoff note by you: ${HANDOFF}`);
    expect(first?.queryByText(/lease end/)).toBeNull();
    expect(second?.getByText(`by Lee · ${PROJECT} · shared · changed`)).toBeTruthy();
    expect(second?.getByText("Lee via antigravity")).toBeTruthy();
    expect(second?.getByText("lease ended").textContent).toMatch(/^lease ended .+ ago$/);
    expect(
      third?.getByText(`by you · ${held.project} · step of a plan · private · changed`),
    ).toBeTruthy();
    expect(third?.getByText("you via claude-code")).toBeTruthy();
    expect(third?.getByText("lease ends").textContent).toMatch(/^lease ends in .+$/);
    expect(screen.getByRole("status").textContent).toBe("3 tasks shown");

    const states = within(screen.getByRole("navigation", { name: "State" }));
    expect(states.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Not done",
      "Open",
      "Claimed",
      "Handed off",
      "Done",
    ]);
    const current = (name: string) =>
      states.getByRole("link", { name }).getAttribute("aria-current");
    expect([current("Not done"), current("Open")]).toEqual(["page", null]);
    const pages = within(screen.getByRole("navigation", { name: "Pages" }));
    expect(pages.getByRole("link", { name: "Tasks", current: "page" })).toBeTruthy();
    expect(document.title).toBe("Tasks · Uketsugi");
    expect(await violations()).toEqual([]);
  });

  it("narrows the list to one project and one state, and asks the server for exactly that", async () => {
    const asked = listing((query) =>
      query.status === "done" ? { tasks: [], matched: 0 } : { tasks: [handedOff], matched: 1 },
    );
    const user = open("/tasks");
    const all = within(await screen.findByRole("navigation", { name: "Projects" }));
    expect(await all.findByRole("link", { name: "Q4 expenses me/q4-expenses" })).toBeTruthy();
    await user.click(all.getByRole("link", { name: PROJECT }));
    expect(await screen.findByRole("heading", { name: PROJECT, level: 2 })).toBeTruthy();
    expect(await screen.findByText("by you · shared · changed")).toBeTruthy();
    expect(asked.at(-1)).toEqual({ project: PROJECT, limit: "100" });

    await user.click(screen.getByRole("link", { name: "Done" }));
    expect(await screen.findByText("No task is done here.")).toBeTruthy();
    expect(asked.at(-1)).toEqual({ project: PROJECT, status: "done", limit: "100" });
    const current = (name: string) =>
      screen.getByRole("link", { name }).getAttribute("aria-current");
    expect([current("Done"), current("Not done")]).toEqual(["page", null]);

    // With a drawer open the address holds more than the filter, and the filter in force is still marked.
    api.use(answer(`/api/tasks/${handedOff.id}`, { task: handedOff, notes: [], history: [] }));
    await user.click(screen.getByRole("link", { name: "Not done" }));
    await user.click(await screen.findByRole("link", { name: TASK }));
    expect(await screen.findByRole("dialog", { name: "Task" })).toBeTruthy();
    expect([current("Not done"), current("Done")]).toEqual(["true", null]);
    const billing = within(screen.getByRole("navigation", { name: "Projects" }));
    expect(billing.getByRole("link", { name: PROJECT }).getAttribute("aria-current")).toBe("true");
  });

  it("says how many tasks matched when not all are shown, and shows more on request, up to the most the server lists", async () => {
    const asked = listing((query) => ({
      tasks: query.limit === String(LIMIT.default) ? [handedOff] : [handedOff, lapsed],
      matched: 5000,
    }));
    const user = open("/tasks");
    expect(await screen.findByText("5000 matched · 1 task shown")).toBeTruthy();
    const more = () => screen.queryByRole<HTMLButtonElement>("button", { name: "Show more" });
    for (let requests = asked.length; more() !== null; requests = asked.length) {
      await user.click(screen.getByRole("button", { name: "Show more" }));
      await waitFor(() => expect(asked.length).toBeGreaterThan(requests));
      await waitFor(() => expect(more()?.disabled ?? false).toBe(false));
    }
    expect(screen.getByRole("status").textContent).toBe("5000 matched · 2 tasks shown");
    // The first request asks for the contract's default, each later one for more, the last for its maximum.
    const limits = asked.map((query) => Number(query.limit));
    expect(limits[0]).toBe(LIMIT.default);
    expect(limits.at(-1)).toBe(LIMIT.maximum);
    expect(limits).toEqual([...limits].sort((a, b) => a - b));
    expect(limits.length).toBeGreaterThan(2);
  });

  it("opens a task from the keyboard, shows what is to be done, every note and its history, and offers to close it", async () => {
    const user = open("/tasks");
    const row = await screen.findByRole("link", { name: TASK });
    row.focus();
    await user.keyboard("{Enter}");
    const drawer = within(await screen.findByRole("dialog", { name: "Task" }));
    expect(await drawer.findByText(TASK)).toBeTruthy();
    expect(drawer.getByText("Retries run inline today and block the worker.")).toBeTruthy();
    for (const word of ["handed off", "shared"]) {
      expect(drawer.getByText(word).querySelector("svg[aria-hidden]")).not.toBeNull();
    }
    expect(drawer.getByText("Project").nextElementSibling?.textContent).toBe(PROJECT);
    const published = drawer.getByText("Published", { selector: "dt" }).nextElementSibling;
    expect(published?.textContent).toMatch(/^by you, .+ ago$/);
    expect(drawer.queryByText("Lease")).toBeNull();

    const notes = section("Notes")
      .getAllByRole("listitem")
      .map((note) => note.textContent);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^Note · Lee via antigravity · .+ agoRetry path moved\.$/);
    expect(notes[1]).toMatch(/^Handoff note · you via claude-code · .+ agoLeft: switch/);
    const history = section("History")
      .getAllByRole("listitem")
      .map((step) => step.textContent);
    expect(history).toHaveLength(4);
    expect(history[0]).toMatch(/^Published · you via claude-code \(s-7f2c\) · .+ ago$/);
    expect(history[1]).toMatch(/^Claimed · Lee via antigravity · .+ ago$/);
    expect(history[2]).toMatch(
      /^Claimed, after the lease lapsed · you via claude-code \(s-51d2\) · .+ ago$/,
    );
    expect(history[3]).toMatch(/^Handed off · you via claude-code \(s-51d2\) · .+ ago$/);

    // A person reads here and may close the task: the drawer's own control and that one.
    expect(drawer.getAllByRole("button")).toEqual([
      drawer.getByRole("button", { name: "Close the task" }),
      drawer.getByRole("button", { name: "Close task…" }),
    ]);
    expect(screen.getByRole("link", { name: TASK, current: "page" })).toBeTruthy();
    expect(await violations()).toEqual([]);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("link", { name: TASK }));
  });

  it("shows a lapsed lease with who held it, and says so when nothing of a task's past can be read", async () => {
    const bare: TaskDetail = { task: lapsed, notes: [], history: [] };
    api.use(answer(`/api/tasks/${lapsed.id}`, bare));
    open(`/tasks?task=${lapsed.id}`);
    const drawer = within(await screen.findByRole("dialog", { name: "Task" }));
    const mark = await drawer.findByText("open · lease lapsed");
    expect(mark.querySelector("svg[aria-hidden]")).not.toBeNull();
    const lease = drawer.getByText("Lease").nextElementSibling;
    expect(lease?.textContent).toMatch(/^Lee via antigravitylease ended .+ ago$/);
    expect(drawer.getByText("No note has been left on this task.")).toBeTruthy();
    expect(drawer.getByText(/before it was shared is its publisher’s alone to read/)).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it("says who sees a task only on a server with someone to share with", async () => {
    api.use(answer("/api/projects", { ...projects, sharing: false }));
    open(`/tasks?task=${handedOff.id}`);
    const drawer = within(await screen.findByRole("dialog", { name: "Task" }));
    expect(await drawer.findByText("handed off")).toBeTruthy();
    expect(drawer.queryByText("shared")).toBeNull();
    const table = within(screen.getByRole("table", { name: LISTED }));
    expect(table.getByText(`by you · ${PROJECT} · changed`)).toBeTruthy();
    expect(table.getByText(`by you · ${held.project} · step of a plan · changed`)).toBeTruthy();
  });

  it("says what happened, what it means and what to do when the list cannot be read", async () => {
    api.use(
      http.get("*/api/tasks", () => HttpResponse.json(unavailable, { status: 503 }), {
        once: true,
      }),
    );
    const user = open("/tasks");
    const alert = within(await screen.findByRole("alert"));
    const { what, meaning, next } = unavailable.error;
    for (const part of [what, meaning, next]) expect(alert.getByText(part)).toBeTruthy();
    await user.click(alert.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(`${tasks.matched} tasks shown`);
  });

  it("with no task under way, has one sentence and one thing to do in an agent", async () => {
    api.use(answer("/api/tasks", { tasks: [], matched: 0 }));
    const user = open("/tasks");
    expect(await screen.findByText(/^No task is waiting or under way\./)).toBeTruthy();
    const copy = screen.getByRole("button", { name: "Copy a first task to ask an agent for" });
    await user.click(copy);
    expect(await navigator.clipboard.readText()).toMatch(/^Publish a task/);
    expect(within(screen.getByRole("region", { name: "Tasks" })).getAllByRole("button")).toEqual([
      copy,
    ]);
  });
});
