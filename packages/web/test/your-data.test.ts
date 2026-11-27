// @vitest-environment jsdom
import {
  AFTER_DELETION,
  API_CSRF_HEADER,
  RETENTION,
  type AccountContents,
  type AccountDeleted,
} from "@uketsugi/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { hostedCapabilities, session } from "./fixtures.ts";
import { answer, api, mockApi, open, violations } from "./support.ts";

const HELD: AccountContents = {
  facts: 12,
  tasks: 2,
  sessions: 5,
  task_notes: 3,
  confirmations: 1,
  groups: [{ name: "everyone", other_members: 4, facts: 9, tasks: 1 }],
  others_facts: 30,
  others_tasks: 6,
  blocked: null,
};

describe("Your data", () => {
  mockApi();

  it("says how long each kind of record is kept, and offers the two downloads, on the open edition, which has no deletion", async () => {
    open("/your-data");
    expect(await screen.findByRole("heading", { name: "How long it is kept" })).toBeTruthy();
    for (const row of RETENTION) expect(screen.getByText(row.kept)).toBeTruthy();
    expect(screen.getByText(/A backup is a file you make with `ukt backup`/)).toBeTruthy();
    const json = screen.getByRole("link", { name: "Download as JSON" });
    expect(json.getAttribute("href")).toBe("/api/export/mine");
    expect(screen.getByRole("link", { name: "Download as Markdown" }).getAttribute("href")).toBe(
      "/api/export/mine?format=markdown",
    );
    expect(screen.queryByRole("heading", { name: "Delete your account" })).toBeNull();
    expect(await violations()).toEqual([]);
  });

  it("shows what deleting the account takes and leaves, and deletes it only once the name is typed", async () => {
    const sent: { body: unknown; csrf: string | null }[] = [];
    api.use(
      answer("/api/capabilities", hostedCapabilities),
      answer("/api/account/contents", HELD),
      http.delete("*/api/account", async ({ request }) => {
        sent.push({ body: await request.json(), csrf: request.headers.get(API_CSRF_HEADER) });
        const done: AccountDeleted = { facts: 12, tasks: 2, sessions: 5, credentials_ended: 1 };
        return HttpResponse.json(done);
      }),
    );
    const user = open("/your-data");
    const card = within(await screen.findByRole("region", { name: "Delete your account" }));
    expect(await card.findByText(/This deletes 12 facts, 2 tasks, 5 sessions/)).toBeTruthy();
    expect(
      card.getByText(
        /In the group everyone, 9 facts and 1 task of yours stop being readable by the 4 other members there/,
      ),
    ).toBeTruthy();
    expect(
      card.getByText(/30 facts and 6 tasks of other people’s in the same projects stay/),
    ).toBeTruthy();
    for (const line of AFTER_DELETION) expect(card.getByText(line)).toBeTruthy();
    const trigger = card.getByRole("button", { name: "Delete my account…" });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    await user.type(card.getByLabelText("Your name"), session.person);
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
    expect(await violations()).toEqual([]);
    await user.click(trigger);
    const dialog = within(await screen.findByRole("alertdialog", { name: "Delete your account?" }));
    expect(sent).toEqual([]);
    await user.click(
      dialog.getByRole("button", { name: "Delete my account and everything in it" }),
    );
    await waitFor(() =>
      expect(sent).toEqual([{ body: { name: session.person }, csrf: session.csrf }]),
    );
  });

  it("gives the administrator the reason instead of the button", async () => {
    api.use(
      answer("/api/capabilities", hostedCapabilities),
      answer("/api/account/contents", { ...HELD, blocked: "Remove them first." }),
    );
    open("/your-data");
    expect(await screen.findByText("Remove them first.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete my account…" })).toBeNull();
  });
});
