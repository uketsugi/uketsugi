// @vitest-environment jsdom
import { API_CSRF_HEADER, type FactDetail } from "@uketsugi/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  CLAIM,
  idempotency,
  PROJECT,
  projects,
  retries,
  retriesDetail,
  session,
  unavailable,
} from "./fixtures.ts";
import { answer, api, mockApi, open, violations } from "./support.ts";

const redacted: FactDetail = {
  ...retriesDetail,
  fact: { ...retries, claim: null, detail: null, question: null, redacted: true },
};

/** Where a redacted fact's text can outlast the redaction, as the page says it before and after. */
const ON_DISK =
  "A copy can stay behind on disk: the database’s own files can still hold the text for a while, and so can a backup, even one made after the redaction. Uketsugi does not remove those copies.";

describe("Facts", () => {
  mockApi();

  it("lists facts with each status as a shape and a word, and the projects with their counts", async () => {
    open("/facts");
    const table = within(await screen.findByRole("table", { name: "Facts, newest first" }));
    const headers = table.getAllByRole("columnheader").map((header) => header.textContent);
    expect(headers).toEqual(["Fact", "Status", "Checked"]);
    for (const word of ["confirmed", "unconfirmed", "marked stale"]) {
      expect(table.getByText(word).querySelector("svg[aria-hidden]")).not.toBeNull();
    }
    expect(table.getByText(/1 citation · by Dana's Claude Code · github/)).toBeTruthy();
    // On a server with other people, every fact says whether they can see it.
    const [, shared, own] = table.getAllByRole("row");
    expect(
      within(shared as HTMLElement)
        .getByText("shared")
        .querySelector("svg"),
    ).not.toBeNull();
    expect(
      within(own as HTMLElement)
        .getByText("private")
        .querySelector("svg"),
    ).not.toBeNull();
    const listed = within(screen.getByRole("navigation", { name: "Projects" }));
    const all = listed.getByRole("link", { name: "All projects" });
    expect(all.getAttribute("aria-current")).not.toBeNull();
    const billing = listed.getByRole("link", { name: `${PROJECT} 41 facts` });
    expect(billing.getAttribute("aria-current")).toBeNull();
    const named = "Q4 expenses me/q4-expenses · 1 fact";
    expect(listed.getByRole("link", { name: named })).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it("says nothing of who sees a fact on a server with one person, where nobody else could", async () => {
    api.use(answer("/api/projects", { ...projects, sharing: false }));
    open(`/facts?fact=${retries.id}`);
    const drawer = within(await screen.findByRole("dialog", { name: "Fact" }));
    expect(await drawer.findByText("confirmed")).toBeTruthy();
    expect(drawer.queryByText("shared")).toBeNull();
    const table = within(screen.getByRole("table", { name: "Facts, newest first" }));
    expect(table.queryByText("shared")).toBeNull();
    expect(table.queryByText("private")).toBeNull();
  });

  it("searches inside one project and says how many matched", async () => {
    const asked: URLSearchParams[] = [];
    api.use(
      http.get("*/api/facts", ({ request }) => {
        const query = new URL(request.url).searchParams;
        asked.push(query);
        return HttpResponse.json(
          query.has("q") ? { facts: [retries], next: null, matched: 7 } : { facts: [], next: null },
        );
      }),
    );
    const user = open("/facts");
    expect(await screen.findByText("Choose a project to search its facts.")).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();

    await user.click(await screen.findByRole("link", { name: `${PROJECT} 41 facts` }));
    const box = await screen.findByRole("searchbox", { name: `Search facts in ${PROJECT}` });
    await user.type(box, "retry policy{Enter}");
    expect(await screen.findByText("7 matched · 1 fact shown")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Facts matching “retry policy”" })).toBeTruthy();
    expect(Object.fromEntries(asked.at(-1) ?? [])).toEqual({ project: PROJECT, q: "retry policy" });
  });

  it("shows more facts a page at a time", async () => {
    api.use(
      http.get("*/api/facts", ({ request }) =>
        new URL(request.url).searchParams.get("cursor") === "page-2"
          ? HttpResponse.json({ facts: [idempotency], next: null })
          : HttpResponse.json({ facts: [retries], next: "page-2" }),
      ),
    );
    const user = open("/facts");
    await user.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByText("2 facts shown")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("opens a fact from the keyboard, shows all of it, and Escape returns to its row", async () => {
    const user = open("/facts");
    const row = await screen.findByRole("link", { name: CLAIM });
    row.focus();
    await user.keyboard("{Enter}");
    const drawer = within(await screen.findByRole("dialog", { name: "Fact" }));
    expect(await drawer.findByText(CLAIM)).toBeTruthy();
    expect(drawer.getByText(/The first retry is after 2 s/)).toBeTruthy();
    expect(drawer.getByText("“what is the retry policy for invoice webhooks”")).toBeTruthy();
    for (const word of [
      "confirmed",
      "shared",
      "reviewed",
      "can be looked up",
      "testimony · needs sign-in",
    ]) {
      expect(drawer.getByText(word).querySelector("svg[aria-hidden]")).not.toBeNull();
    }
    // The contract's word for this citation's class, `checkable`, reads as "checked", and nothing
    // checks a citation: the page says only that the reference can be looked up.
    const cited = drawer.getByText("services/billing/webhooks/retry.rs:41-88@9f3c2e1");
    expect(cited.closest("li")?.textContent).toBe(`${cited.textContent}filecan be looked up`);
    expect(drawer.queryByText(/checkable/i)).toBeNull();
    expect(drawer.getByRole("link", { name: /wiki\.acme\.example/ })).toBeTruthy();
    expect(drawer.getByText("Author").nextElementSibling?.textContent).toBe("Dana's Claude Code");
    expect(drawer.queryByText("Written by")).toBeNull();
    const check = drawer.getByText(/^Confirmed by Dana/).textContent;
    expect(check).toMatch(/^Confirmed by Dana, .+ ago at 9f3c2e1: read retry\.rs$/);
    const published = drawer.getByText("Fact published").textContent;
    expect(published).toMatch(/^Fact published · Dana's Claude Code · .+ ago$/);
    expect(screen.getByRole("link", { name: CLAIM, current: "page" })).toBeTruthy();
    expect(await violations()).toEqual([]);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("link", { name: CLAIM }));
  });

  it("says of a fact a language model wrote that one did, and from which session", async () => {
    const written = { ...retries, author: "you", from_session: "s-41ab" };
    api.use(
      answer("/api/facts", { facts: [written, idempotency], next: null }),
      answer(`/api/facts/${retries.id}`, { ...retriesDetail, fact: written }),
    );
    const user = open("/facts");
    const row = (await screen.findByRole("link", { name: CLAIM })).closest("tr");
    expect(row?.textContent).toContain("by you, written by a model from session s-41ab");
    const other = screen.getByRole("link", { name: idempotency.claim ?? "" }).closest("tr");
    expect(other?.textContent).not.toContain("written by a model");

    await user.click(screen.getByRole("link", { name: CLAIM }));
    const drawer = within(await screen.findByRole("dialog", { name: "Fact" }));
    expect(
      await drawer.findByText(/^A language model wrote this fact from what the session/),
    ).toBeTruthy();
    expect(drawer.getByText("Written by").nextElementSibling?.textContent).toBe(
      "a language model, from session s-41ab",
    );
    expect(await violations()).toEqual([]);
  });

  it("calls the author's own check a check, and only another person's a confirmation", async () => {
    api.use(
      answer(`/api/facts/${retries.id}`, {
        ...retriesDetail,
        confirmations: [
          {
            person: "you",
            by_author: true,
            at: "2026-11-13T09:00:00Z",
            checked: "ran the job locally",
            source_version: null,
          },
          ...retriesDetail.confirmations,
        ],
      }),
    );
    open(`/facts?fact=${retries.id}`);
    const drawer = within(await screen.findByRole("dialog", { name: "Fact" }));
    expect((await drawer.findByText(/^Checked by/)).textContent).toMatch(
      /^Checked by you, .+ ago: ran the job locally$/,
    );
    expect(drawer.getByText(/^Confirmed by/).textContent).toMatch(/^Confirmed by Dana, /);
    expect(drawer.queryByText(/^Confirmed by you/)).toBeNull();
  });

  it("redacts a fact only after the person confirms, and sends the CSRF value", async () => {
    const sent: (string | null)[] = [];
    api.use(
      http.post(`*/api/facts/${retries.id}/redact`, ({ request }) => {
        sent.push(request.headers.get(API_CSRF_HEADER));
        api.use(
          answer(`/api/facts/${retries.id}`, redacted),
          answer("/api/facts", { facts: [idempotency], next: null }),
        );
        return HttpResponse.json({ id: retries.id, redacted: true });
      }),
    );
    const user = open(`/facts?fact=${retries.id}`);
    await user.click(await screen.findByRole("button", { name: "Redact…" }));
    const question = within(await screen.findByRole("alertdialog", { name: "Redact this fact?" }));
    // It promises what happens at once, and says where a copy can outlast it: a backup too.
    const said = question.getByText(/This cannot be undone/).textContent;
    expect(said).toContain(
      "Agents stop receiving its text, and it is gone at once from the dashboard, from search and from any export made from now on. This cannot be undone.",
    );
    expect(said).toContain(ON_DISK);
    expect(said).toContain(
      "If the text is a secret, such as a password or a key, change the secret as well.",
    );
    expect(said).not.toMatch(/every place/);
    expect(await violations()).toEqual([]);
    await user.click(question.getByRole("button", { name: "Keep the fact" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(sent).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Redact…" }));
    await user.click(await screen.findByRole("button", { name: "Redact the fact" }));
    expect((await screen.findByText(/^This fact was redacted\./)).textContent).toBe(
      `This fact was redacted. Agents no longer receive its text, and it is gone from the dashboard, from search and from exports made since. ${ON_DISK}`,
    );
    expect(sent).toEqual([session.csrf]);
    const drawer = within(screen.getByRole("dialog", { name: "Fact" }));
    expect(drawer.queryByText(CLAIM)).toBeNull();
    expect(drawer.getByText("redacted").querySelector("svg[aria-hidden]")).not.toBeNull();
    expect(drawer.queryByRole("button", { name: "Redact…" })).toBeNull();

    // The fact's row has left the list, so closing the drawer puts the focus on the page.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("main")));
    expect(screen.queryByRole("link", { name: CLAIM })).toBeNull();
  });

  it.each([
    ["project", /^Only you see this fact: its project is private\.$/],
    ["no_source", /though you share its project: none of its citations can be looked up\./],
    [
      "cites_private",
      // A redacted fact is never shared, so the sentence also says what frees this one then.
      /it cites a fact of yours that others cannot see\. It is shared once that one is\. If that one was redacted it never will be: have your agent correct this fact without that citation, and this fact is shared\.$/,
    ],
    [
      "merged_word",
      /a duplicate merged into it has no citation that can be looked up.*undo the merge on Activity/,
    ],
  ] as const)(
    "says why a fact of the person's own stays theirs alone: %s",
    async (because, sentence) => {
      const mine = { ...idempotency, flags: [] };
      api.use(
        answer(`/api/facts/${mine.id}`, { ...retriesDetail, fact: mine, private_because: because }),
      );
      open(`/facts?fact=${mine.id}`);
      const drawer = within(await screen.findByRole("dialog", { name: "Fact" }));
      expect((await drawer.findByText(sentence)).textContent).not.toMatch(/checkable/);
      expect(await violations()).toEqual([]);
    },
  );

  it("says nothing of why where others see the fact", async () => {
    open(`/facts?fact=${retries.id}`);
    const drawer = within(await screen.findByRole("dialog", { name: "Fact" }));
    expect(await drawer.findByText(CLAIM)).toBeTruthy();
    expect(drawer.queryByText(/Only you see this fact/)).toBeNull();
  });

  it("offers no redaction of a fact another person wrote", async () => {
    const theirs = { ...retries, author: "Lee", own: false };
    api.use(answer(`/api/facts/${retries.id}`, { ...retriesDetail, fact: theirs }));
    open(`/facts?fact=${retries.id}`);
    const drawer = within(await screen.findByRole("dialog", { name: "Fact" }));
    expect(await drawer.findByText("Lee")).toBeTruthy();
    expect(drawer.queryByRole("button", { name: "Redact…" })).toBeNull();
  });

  it("before redacting a fact that was merged, says its claim stays live in the fact it was merged into", async () => {
    const merged = { ...idempotency, status: "superseded" as const, superseded_by: retries.id };
    api.use(answer(`/api/facts/${merged.id}`, { ...retriesDetail, fact: merged }));
    const user = open(`/facts?fact=${merged.id}`);
    await user.click(await screen.findByRole("button", { name: "Redact…" }));
    const question = await screen.findByRole("alertdialog", { name: "Redact this fact?" });
    expect(question.getAttribute("aria-describedby")).toBe(
      within(question).getByText(/This cannot be undone/).id,
    );
    expect(within(question).getByText(/This cannot be undone/).textContent).toContain(
      `This fact was merged into ${retries.id}, which says the same and keeps its text: redact that fact as well if the claim itself should go.`,
    );
    expect(await violations()).toEqual([]);
  });

  it("says what happened, what it means and what to do when the list cannot be read", async () => {
    api.use(
      http.get("*/api/facts", () => HttpResponse.json(unavailable, { status: 503 }), {
        once: true,
      }),
    );
    const user = open("/facts");
    const alert = within(await screen.findByRole("alert"));
    const { what, meaning, next } = unavailable.error;
    for (const part of [what, meaning, next]) expect(alert.getByText(part)).toBeTruthy();
    await user.click(alert.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table")).toBeTruthy();
  });

  it("with no fact yet, has one sentence and one thing to do in an agent", async () => {
    api.use(answer("/api/facts", { facts: [], next: null }));
    const user = open("/facts");
    expect(
      await screen.findByText("Facts appear here when your agents publish what they establish"),
    ).toBeTruthy();
    const copy = screen.getByRole("button", { name: "Copy a first question to ask an agent" });
    await user.click(copy);
    expect(await navigator.clipboard.readText()).toMatch(/\?$/);
    expect(within(screen.getByRole("region", { name: "Facts" })).getAllByRole("button")).toEqual([
      copy,
    ]);
  });
});
