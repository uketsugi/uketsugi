// @vitest-environment jsdom
import { API_CSRF_HEADER } from "@uketsugi/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { CLAIM, idempotency, retries, rulings, session } from "./fixtures.ts";
import { activity, readByModel } from "./activity-fixtures.ts";
import { answer, api, mockApi, open, violations } from "./support.ts";

/** The cells of each body row of a table, as text. */
function rows(table: HTMLElement): (string | null)[][] {
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    );
}

const clients = () => screen.findByRole("table", { name: /^Sessions by client since / });
const recent = () => screen.findByRole("table", { name: "Recent rulings, newest first" });

/** The "N units ago" a cell says, which the test cannot know by the clock. */
const ago = (cell: string | null | undefined) =>
  /Failed or refused (.+ ago): /.exec(cell ?? "")?.[1] ?? "no time";

describe("Activity", () => {
  mockApi();

  it("counts, per client and version, the sessions that searched, published and were refused", async () => {
    open("/activity");
    const table = await clients();
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual([
      "Client",
      "Version",
      "Sessions",
      "Searched",
      "Published",
      "Refused for a missing project",
    ]);
    expect(rows(table)).toEqual([
      ["claude-code", "2.1.0", "12", "9", "7", "1"],
      ["antigravity", "not sent", "30", "28", "25", "0"],
    ]);
    await recent();
    expect(await violations()).toEqual([]);
  });

  it("sorts by a column from the keyboard and says which way", async () => {
    const user = open("/activity");
    const table = await clients();
    const header = within(table).getByRole("columnheader", { name: "Sessions" });
    within(header).getByRole("button").focus();
    await user.keyboard("{Enter}");
    expect(header.getAttribute("aria-sort")).toBe("descending");
    expect(rows(table).map((cells) => cells[0])).toEqual(["antigravity", "claude-code"]);
    await user.keyboard("{Enter}");
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    expect(rows(table).map((cells) => cells[0])).toEqual(["claude-code", "antigravity"]);
  });

  it("reads another period when one is chosen, and marks it", async () => {
    const asked: (string | null)[] = [];
    api.use(
      http.get("*/api/activity", ({ request }) => {
        asked.push(new URL(request.url).searchParams.get("days"));
        return HttpResponse.json(activity);
      }),
    );
    const user = open("/activity");
    const periods = within(await screen.findByRole("navigation", { name: "Period" }));
    expect(periods.getByRole("link", { current: "page" }).textContent).toBe("7 days");
    await user.click(periods.getByRole("link", { name: "30 days" }));
    await waitFor(() => expect(asked).toEqual(["7", "30"]));
    expect(periods.getByRole("link", { current: "page" }).textContent).toBe("30 days");
  });

  it("with no session and no ruling yet, says so and offers Connect", async () => {
    api.use(
      answer("/api/activity", { ...activity, clients: [], recent: [] }),
      answer("/api/rulings", { rulings: [] }),
    );
    const user = open("/activity");
    expect(await screen.findByText("No agent has connected yet")).toBeTruthy();
    expect(await screen.findByText("No ruling has been made yet")).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Connect an agent" }));
    expect(await screen.findByRole("heading", { name: "Connect an agent" })).toBeTruthy();
  });

  it("says nothing of a language model where none read a session", async () => {
    open("/activity");
    await clients();
    await recent();
    expect(screen.queryByRole("region", { name: "Sessions a language model read" })).toBeNull();
  });

  it("lists the sessions a language model read, with what each reading cost", async () => {
    api.use(answer("/api/activity", { ...activity, recent: [...activity.recent, readByModel] }));
    open("/activity");
    const table = await screen.findByRole("table", {
      name: "Your recent sessions a language model read",
    });
    const [cells = []] = rows(table);
    expect(rows(table)).toHaveLength(1);
    expect([...cells.slice(0, 3), ...cells.slice(4)]).toEqual([
      "s-41ab",
      "claude-code",
      readByModel.project,
      "4210",
      "380",
      "",
    ]);
    expect(cells[3]).toMatch(/ ago$/);
    expect(await violations()).toEqual([]);
  });

  it("says why a reading waits where the provider failed or refused the call", async () => {
    const reason = "the provider refused the call (status 401): the key was refused";
    const failed = {
      ...readByModel,
      digest: {
        at: null,
        input_tokens: 0,
        output_tokens: 0,
        failure: { at: "2026-11-13T10:41:00Z", reason },
      },
    };
    api.use(answer("/api/activity", { ...activity, recent: [...activity.recent, failed] }));
    open("/activity");
    const table = await screen.findByRole("table", {
      name: "Your recent sessions a language model read",
    });
    const [cells = []] = rows(table);
    expect(cells[3]).toBe("not yet");
    expect(cells[6]).toBe(`Failed or refused ${ago(cells[6])}: ${reason}`);
    expect(await violations()).toEqual([]);
  });

  it("shows each ruling with who decided and why, and a revert only where one is possible", async () => {
    open("/activity");
    expect(rows(await recent()).map((cells) => cells.slice(0, 4).concat(cells[5] ?? ""))).toEqual([
      ["merge duplicate", idempotency.id, "consolidate · rules", "same claim", "Revert"],
      ["redact", retries.id, "Dana", "person asked", ""],
    ]);
    expect(screen.getAllByRole("button", { name: /^Revert / })).toHaveLength(1);
  });

  it("names a ruling's fact by its id, which opens the fact from the keyboard", async () => {
    const user = open("/activity");
    within(await recent())
      .getByRole("link", { name: retries.id })
      .focus();
    await user.keyboard("{Enter}");
    const drawer = within(await screen.findByRole("dialog", { name: "Fact" }));
    expect(await drawer.findByText(CLAIM)).toBeTruthy();
  });

  it("reverts a ruling from the keyboard with the CSRF value, and shows it reverted", async () => {
    const sent: (string | null)[] = [];
    const [merge, redact] = rulings.rulings;
    api.use(
      http.post("*/api/rulings/r-merge/revert", ({ request }) => {
        sent.push(request.headers.get(API_CSRF_HEADER));
        const undone = { ...merge, reverted_by: "r-revert", revertible: false };
        api.use(answer("/api/rulings", { rulings: [undone, redact] }));
        return HttpResponse.json({ id: "r-merge", reverted: true });
      }),
    );
    const user = open("/activity");
    const name = `Revert merge duplicate of fact ${idempotency.id}`;
    (await screen.findByRole("button", { name })).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("The ruling was reverted.")).toBeTruthy();
    expect(sent).toEqual([session.csrf]);
    const reverted = await within(await recent()).findByText("reverted");
    expect(reverted.querySelector("svg[aria-hidden]")).not.toBeNull();
    expect(screen.queryByRole("button", { name })).toBeNull();
    expect(await violations()).toEqual([]);
  });
});
