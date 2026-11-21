// @vitest-environment jsdom
import { API_CSRF_HEADER } from "@uketsugi/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { hostedCapabilities, session, unauthorized, unknownKey } from "./fixtures.ts";
import { answer, api, mockApi, open, violations } from "./support.ts";

/** How the sign-in page is headed for someone who has not signed in yet, and for someone who was. */
const SIGN_IN = "Sign in to Uketsugi";
const SIGNED_OUT = "You are signed out";

describe("the shell and sign-in", () => {
  mockApi();

  it("tells a visitor who has not signed in the two ways in, and shows no failure and no page", async () => {
    api.use(answer("/api/session", unauthorized, 401));
    open("/facts");
    expect(await screen.findByRole("heading", { name: SIGN_IN })).toBeTruthy();
    const page = within(screen.getByRole("main"));
    expect(page.getAllByRole("heading")).toHaveLength(1);
    expect(page.getByText("ukt ui").closest("p")?.textContent).toBe(
      "On the computer the server runs on, run ukt ui in a terminal: it opens the dashboard signed in, or prints a link that does.",
    );
    expect(
      page.getByText("From any other computer, paste the dashboard key you were given."),
    ).toBeTruthy();
    expect(page.getByLabelText("Your dashboard key")).toBeTruthy();
    // The server's refusal of a request nobody signed is not this page's to show, and nothing has ended.
    const { what, meaning, next } = unauthorized.error;
    for (const part of [what, meaning, next]) expect(page.queryByText(part)).toBeNull();
    expect(page.queryByText(/session has ended/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(document.title).toBe("Sign in · Uketsugi");
    expect(await violations()).toEqual([]);
  });

  it("tells a signed-out visitor of an edition with no key and no ukt that edition's way in, and shows no key field", async () => {
    api.use(
      answer("/api/session", unauthorized, 401),
      answer("/api/capabilities", hostedCapabilities),
    );
    open("/facts");
    expect(await screen.findByRole("heading", { name: SIGN_IN })).toBeTruthy();
    const page = within(screen.getByRole("main"));
    expect(page.getByText(hostedCapabilities.dashboard.sign_in[0] ?? "missing")).toBeTruthy();
    expect(page.queryByText(/ukt ui/)).toBeNull();
    expect(page.queryByText(/dashboard key/)).toBeNull();
    expect(page.queryByLabelText("Your dashboard key")).toBeNull();
    expect(page.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(await violations()).toEqual([]);
  });

  it("names only the pages this build has, the edition, the person and the install's state", async () => {
    open("/");
    const pages = within(await screen.findByRole("navigation", { name: "Pages" }));
    expect(pages.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Facts",
      "Tasks",
      "Activity",
      "Projects",
      "Connect",
    ]);
    expect(await pages.findByRole("link", { name: "Facts", current: "page" })).toBeTruthy();
    const banner = within(screen.getByRole("banner"));
    expect(await banner.findByText("community")).toBeTruthy();
    expect(banner.getByText(session.person)).toBeTruthy();
    const state = within(screen.getByRole("contentinfo"));
    expect(state.getByText("no model").querySelector("svg")).not.toBeNull();
    expect(state.getByText("contract 0.3.0")).toBeTruthy();
    expect(document.title).toBe("Facts · Uketsugi");
  });

  it("moves between pages from the keyboard, starting at a skip link", async () => {
    const user = open("/facts");
    await screen.findByRole("heading", { name: "Facts", level: 1 });
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Skip to the page");
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("main"));

    screen.getByRole("link", { name: "Activity" }).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "Activity", level: 1 })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("main")));
    expect(document.title).toBe("Activity · Uketsugi");
  });

  it("signs out with the CSRF value and shows the signed-out page", async () => {
    const sent: (string | null)[] = [];
    api.use(
      http.delete("*/api/session", ({ request }) => {
        sent.push(request.headers.get(API_CSRF_HEADER));
        api.use(answer("/api/session", unauthorized, 401));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = open("/facts");
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: SIGNED_OUT })).toBeTruthy();
    expect(screen.getByLabelText("Your dashboard key")).toBeTruthy();
    expect(sent).toEqual([session.csrf]);
  });

  it("signs a person in with their own dashboard key, and says so when the server does not know it", async () => {
    const sent: unknown[] = [];
    api.use(
      answer("/api/session", unauthorized, 401),
      http.post("*/sign-in", async ({ request }) => {
        const body = (await request.json()) as { key: string };
        sent.push(body);
        if (body.key !== "ukp_dana") return HttpResponse.json(unknownKey, { status: 401 });
        api.use(answer("/api/session", session));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = open("/facts");
    await user.type(await screen.findByLabelText("Your dashboard key"), "ukt_a_harness_token");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(unknownKey.error.what)).toBeTruthy();
    expect(screen.getByText(unknownKey.error.meaning)).toBeTruthy();
    expect(await violations()).toEqual([]);
    await user.clear(screen.getByLabelText("Your dashboard key"));
    await user.type(screen.getByLabelText("Your dashboard key"), "ukp_dana");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Facts", level: 1 })).toBeTruthy();
    expect(sent).toEqual([{ key: "ukt_a_harness_token" }, { key: "ukp_dana" }]);
  });

  it("says the session has ended when it ends while a page is open, and how to sign in again", async () => {
    api.use(
      http.get("*/api/facts", () => {
        api.use(answer("/api/session", unauthorized, 401));
        return HttpResponse.json(unauthorized, { status: 401 });
      }),
    );
    open("/facts");
    expect(await screen.findByRole("heading", { name: SIGNED_OUT })).toBeTruthy();
    expect(
      screen.getByText("This browser’s session has ended. Sign in again to carry on."),
    ).toBeTruthy();
    expect(screen.getByText("ukt ui")).toBeTruthy();
    expect(screen.getByLabelText("Your dashboard key")).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});
