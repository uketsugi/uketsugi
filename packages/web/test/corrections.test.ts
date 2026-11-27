// @vitest-environment jsdom
import { API_CSRF_HEADER } from "@uketsugi/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  handedOff,
  handedOffDetail,
  projects,
  retries,
  retriesDetail,
  session,
} from "./fixtures.ts";
import { activity, readByModel } from "./activity-fixtures.ts";
import { answer, api, mockApi, open, violations } from "./support.ts";

/** A session that left a note, which its person reads on Activity and can remove. */
const noted = {
  ...readByModel,
  session: "s-90de",
  digest: null,
  note: {
    text: "Stopped half way through the audit column backfill",
    final: false,
    at: "2026-11-13T11:00:00Z",
  },
};

describe("what a person does to what is stored", () => {
  mockApi();

  it("removes a session's note after the person confirms, with the CSRF value, and the note leaves the page", async () => {
    const sent: (string | null)[] = [];
    api.use(
      answer("/api/activity", { ...activity, recent: [...activity.recent, noted] }),
      http.delete(`*/api/sessions/${noted.session}/note`, ({ request }) => {
        sent.push(request.headers.get(API_CSRF_HEADER));
        api.use(answer("/api/activity", activity));
        return HttpResponse.json({ session: noted.session });
      }),
    );
    const user = open("/activity");
    expect(await screen.findByText(noted.note?.text ?? "")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: `Remove the note of ${noted.session}…` }));
    const question = within(await screen.findByRole("alertdialog", { name: "Remove this note?" }));
    expect(await violations()).toEqual([]);
    await user.click(question.getByRole("button", { name: "Keep the note" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(sent).toEqual([]);

    await user.click(screen.getByRole("button", { name: `Remove the note of ${noted.session}…` }));
    await user.click(await screen.findByRole("button", { name: "Remove the note" }));
    await waitFor(() => expect(screen.queryByText(noted.note?.text ?? "")).toBeNull());
    expect(sent).toEqual([session.csrf]);
  });

  it("corrects a fact of the person's own with the words typed, and shows the corrected fact", async () => {
    const sent: unknown[] = [];
    const corrected = { ...retries, claim: "Invoice webhooks retry three times" };
    api.use(
      http.post(`*/api/facts/${retries.id}/correct`, async ({ request }) => {
        sent.push(request.headers.get(API_CSRF_HEADER), await request.json());
        api.use(answer(`/api/facts/${retries.id}`, { ...retriesDetail, fact: corrected }));
        return HttpResponse.json({ id: retries.id, changed: true });
      }),
    );
    const user = open(`/facts?fact=${retries.id}`);
    await user.click(await screen.findByRole("button", { name: "Correct…" }));
    const claim = screen.getByRole("textbox", { name: "Claim" });
    await user.clear(claim);
    await user.type(claim, corrected.claim);
    await user.click(screen.getByRole("button", { name: "Save the correction" }));
    const drawer = within(screen.getByRole("dialog", { name: "Fact" }));
    expect(await drawer.findByText(corrected.claim)).toBeTruthy();
    expect(sent).toEqual([session.csrf, { claim: corrected.claim, detail: retries.detail }]);
  });

  it("offers a check of a fact a model wrote, and sends it", async () => {
    const sent: (string | null)[] = [];
    const written = {
      ...retries,
      status: "unconfirmed" as const,
      trust: "unreviewed" as const,
      from_session: "s-41ab",
    };
    api.use(
      answer(`/api/facts/${retries.id}`, { ...retriesDetail, fact: written }),
      http.post(`*/api/facts/${retries.id}/confirm`, ({ request }) => {
        sent.push(request.headers.get(API_CSRF_HEADER));
        api.use(
          answer(`/api/facts/${retries.id}`, {
            ...retriesDetail,
            fact: { ...written, status: "confirmed" },
          }),
        );
        return HttpResponse.json({ id: retries.id, status: "confirmed" });
      }),
    );
    const user = open(`/facts?fact=${retries.id}`);
    await user.click(await screen.findByRole("button", { name: "I have checked this fact" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "I have checked this fact" })).toBeNull(),
    );
    expect(sent).toEqual([session.csrf]);
  });

  it("offers no check of a fact the person's own agent published", async () => {
    const own = { ...retries, status: "unconfirmed" as const };
    api.use(answer(`/api/facts/${retries.id}`, { ...retriesDetail, fact: own }));
    open(`/facts?fact=${retries.id}`);
    await screen.findByRole("button", { name: "Correct…" });
    expect(screen.queryByRole("button", { name: "I have checked this fact" })).toBeNull();
  });

  it("closes a task after the person confirms", async () => {
    const sent: (string | null)[] = [];
    api.use(
      http.post(`*/api/tasks/${handedOff.id}/close`, ({ request }) => {
        sent.push(request.headers.get(API_CSRF_HEADER));
        api.use(
          answer(`/api/tasks/${handedOff.id}`, {
            ...handedOffDetail,
            task: { ...handedOff, state: "done" },
          }),
        );
        return HttpResponse.json({ id: handedOff.id, changed: true });
      }),
    );
    const user = open(`/tasks?task=${handedOff.id}`);
    await user.click(await screen.findByRole("button", { name: "Close task…" }));
    expect(await violations()).toEqual([]);
    await user.click(await screen.findByRole("button", { name: "Close the task" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Close task…" })).toBeNull());
    expect(sent).toEqual([session.csrf]);
  });

  it("offers no closing of another person's task, which the server refuses", async () => {
    const theirs = { ...handedOff, publisher: "Lee" };
    api.use(answer(`/api/tasks/${handedOff.id}`, { ...handedOffDetail, task: theirs }));
    open(`/tasks?task=${handedOff.id}`);
    const drawer = within(await screen.findByRole("dialog", { name: "Task" }));
    await drawer.findByText("History");
    expect(drawer.queryByRole("button", { name: "Close task…" })).toBeNull();
  });

  it("offers the closing of another person's task that the person's own agent holds", async () => {
    const held = { ...handedOff, publisher: "Lee", holder: "you" };
    api.use(answer(`/api/tasks/${handedOff.id}`, { ...handedOffDetail, task: held }));
    open(`/tasks?task=${handedOff.id}`);
    expect(await screen.findByRole("button", { name: "Close task…" })).toBeTruthy();
  });

  it("shows what deleting a project takes before it deletes, and sends the project", async () => {
    const [first] = projects.projects;
    const sent: unknown[] = [];
    api.use(
      answer("/api/projects/contents", {
        project: first?.key,
        facts: 4,
        tasks: 2,
        sessions: 3,
        others_facts: 1,
        others_tasks: 0,
      }),
      http.delete("*/api/projects", async ({ request }) => {
        sent.push(request.headers.get(API_CSRF_HEADER), await request.json());
        return HttpResponse.json({ project: first?.key, facts: 4, tasks: 2, sessions: 3 });
      }),
    );
    const user = open("/projects");
    await user.click(await screen.findByRole("button", { name: `Delete ${first?.key}…` }));
    const question = within(
      await screen.findByRole("alertdialog", { name: "Delete this project?" }),
    );
    expect(
      await question.findByText(/This deletes 4 facts, 2 tasks and 3 sessions of yours here/),
    ).toBeTruthy();
    expect(question.getByText(/1 fact and 0 tasks of other people’s stay\./)).toBeTruthy();
    await user.click(question.getByRole("button", { name: "Keep the project" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(sent).toEqual([]);

    await user.click(screen.getByRole("button", { name: `Delete ${first?.key}…` }));
    await user.click(await screen.findByRole("button", { name: "Delete the project" }));
    await waitFor(() => expect(sent).toEqual([session.csrf, { project: first?.key }]));
  });
});
