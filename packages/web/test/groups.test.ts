// @vitest-environment jsdom
import { API_CSRF_HEADER, type GroupChanged, type GroupList } from "@uketsugi/contracts";
import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { groups, session } from "./fixtures.ts";
import { answer, api, mockApi, open, violations } from "./support.ts";

const ANN = { id: "0197a000-0000-7000-8000-000000000001", name: "Ann" };
const BO = { id: "0197a000-0000-7000-8000-000000000002", name: "Bo" };
const CY = { id: "0197a000-0000-7000-8000-000000000003", name: "Cy" };

/** What the administrator is shown: every group, and everyone to add. */
const administered: GroupList = {
  groups: [
    { name: "everyone", mine: true, members: [ANN, BO, CY] },
    { name: "design", mine: true, members: [ANN, BO] },
  ],
  people: [ANN, BO, CY],
  administrator: true,
  you: ANN.id,
};

describe("Groups", () => {
  mockApi();

  it("shows a member the groups they are in and who is in them, with nothing to change", async () => {
    open("/groups");
    const everyone = within(await screen.findByRole("region", { name: "everyone" }));
    expect(everyone.getByText("Ann")).toBeTruthy();
    expect(everyone.getByText("Bo")).toBeTruthy();
    expect(everyone.queryByRole("button")).toBeNull();
    expect(screen.queryByLabelText("Make a group")).toBeNull();
    expect(groups.administrator).toBe(false);
    expect(await violations()).toEqual([]);
  });

  it("lets the administrator make a group, add a person to it and take one out, each with the session's CSRF value", async () => {
    const sent: { path: string; body: unknown; csrf: string | null }[] = [];
    const changed = (name: string, members: GroupChanged["group"]["members"]): GroupChanged => ({
      group: { name, mine: true, members },
    });
    api.use(
      answer("/api/groups", administered),
      http.post("*/api/groups", async ({ request }) => {
        sent.push({
          path: "make",
          body: await request.json(),
          csrf: request.headers.get(API_CSRF_HEADER),
        });
        return HttpResponse.json(changed("ops", []), { status: 201 });
      }),
      http.post("*/api/groups/design/members", async ({ request }) => {
        sent.push({
          path: "add",
          body: await request.json(),
          csrf: request.headers.get(API_CSRF_HEADER),
        });
        return HttpResponse.json(changed("design", [ANN, BO, CY]));
      }),
      http.post("*/api/groups/design/members/:person/remove", async ({ params, request }) => {
        sent.push({
          path: "remove",
          body: params.person,
          csrf: request.headers.get(API_CSRF_HEADER),
        });
        return HttpResponse.json(changed("design", [ANN]));
      }),
    );
    const user = open("/groups");
    const design = within(await screen.findByRole("region", { name: "design" }));
    await user.selectOptions(design.getByLabelText("Add to design"), CY.id);
    await user.click(design.getByRole("button", { name: "Add" }));
    await user.click(design.getByRole("button", { name: "Take Bo out of design" }));
    await user.type(screen.getByLabelText("Make a group"), "ops");
    await user.click(screen.getByRole("button", { name: "Make the group" }));
    await screen.findByRole("region", { name: "design" });
    expect(sent).toEqual([
      { path: "add", body: { person: CY.id }, csrf: session.csrf },
      { path: "remove", body: BO.id, csrf: session.csrf },
      { path: "make", body: { name: "ops" }, csrf: session.csrf },
    ]);
    // A provider-signed edition's invitation link is offered only there.
    expect(screen.queryByRole("button", { name: "Make an invitation link" })).toBeNull();
  });

  it("lets the administrator hand the organization to another person, asking first, with the session's CSRF value", async () => {
    const sent: { body: unknown; csrf: string | null }[] = [];
    api.use(
      answer("/api/groups", administered),
      http.post("*/api/administrator", async ({ request }) => {
        sent.push({ body: await request.json(), csrf: request.headers.get(API_CSRF_HEADER) });
        return HttpResponse.json({ ...administered, administrator: false });
      }),
    );
    const user = open("/groups");
    const form = within(await screen.findByRole("region", { name: "Hand the organization over" }));
    const choices = form.getAllByRole("option").map((option) => option.textContent);
    expect(choices).toEqual(["Choose a person", "Bo", "Cy"]);
    await user.selectOptions(form.getByLabelText("Hand the organization to"), BO.id);
    await user.click(form.getByRole("button", { name: "Hand over" }));
    expect(sent).toEqual([]);
    await user.click(await screen.findByRole("button", { name: "Yes, hand it to Bo" }));
    await screen.findByRole("region", { name: "design" });
    expect(sent).toEqual([{ body: { person: BO.id }, csrf: session.csrf }]);
  });

  it("offers no hand-over to a person who is not the administrator", async () => {
    open("/groups");
    await screen.findByRole("region", { name: "everyone" });
    expect(screen.queryByRole("region", { name: "Hand the organization over" })).toBeNull();
  });

  it("offers the administrator no hand-over while they are the only person", async () => {
    api.use(answer("/api/groups", { ...administered, people: [ANN] }));
    open("/groups");
    await screen.findByRole("region", { name: "everyone" });
    expect(screen.queryByRole("region", { name: "Hand the organization over" })).toBeNull();
  });
});
