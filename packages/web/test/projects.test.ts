// @vitest-environment jsdom
import {
  API_CSRF_HEADER,
  type ApiError,
  type ApiProject,
  type ProjectChoice,
  type ProjectList,
} from "@uketsugi/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { PROJECT, projects, session } from "./fixtures.ts";
import { answer, api, mockApi, open, violations } from "./support.ts";

/** The repository's row as the server lists it after a choice. */
function chosen(treatment: "private" | "shared"): ProjectList {
  const [repository, named] = projects.projects;
  if (repository === undefined || named === undefined)
    throw new Error("the fixture has two projects");
  return { projects: [{ ...repository, treatment, chosen: true }, named], sharing: true };
}

const FERRY: ApiProject = {
  key: "me/ferry-notes",
  kind: "named",
  name: null,
  names: [],
  facts: 0,
  treatment: "private",
  chosen: true,
};

/** The line a person puts in a directory's instruction file, for a project. */
function lineFor(key: string): string {
  return `The uketsugi project for this directory is \`${key}\`.`;
}

/** What the server answers a slug it cannot take, word for word. */
const refusedSlug: ApiError = {
  error: {
    code: "invalid_input",
    what: '"Ferry Notes" cannot be a project\'s slug.',
    meaning: "Nothing was created.",
    next: "Use lower-case letters, digits and hyphens, starting with a letter or a digit, 63 characters at most.",
    retry: false,
  },
};

/** The section a person makes a named project in. */
async function naming() {
  return within(
    await screen.findByRole("region", { name: "A project for a directory with no origin remote" }),
  );
}

describe("Projects", () => {
  mockApi();

  it("lists the person's projects, says which they have not chosen for, and offers no choice for a named one, only its join and its deletion", async () => {
    open("/projects");
    const table = within(await screen.findByRole("table", { name: /Your projects/ }));
    const [, repository, named] = table.getAllByRole("row");
    expect(within(repository as HTMLElement).getByText("private · not chosen yet")).toBeTruthy();
    expect(
      within(repository as HTMLElement).getByRole("button", { name: `Share ${PROJECT}…` }),
    ).toBeTruthy();
    expect(within(named as HTMLElement).getByText("Q4 expenses (me/q4-expenses)")).toBeTruthy();
    expect(within(named as HTMLElement).getByText("yours alone")).toBeTruthy();
    expect(
      within(named as HTMLElement)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Join me/q4-expenses into another project…", "Delete me/q4-expenses…"]);
    expect(await violations()).toEqual([]);
  });

  it("lists a folder with no origin under its machine and its path, yours alone", async () => {
    const folder: ApiProject = {
      key: "file://box/home/ann/Work Dir",
      kind: "path",
      name: null,
      names: [],
      facts: 3,
      treatment: "private",
      chosen: true,
    };
    api.use(answer("/api/projects", { ...projects, projects: [folder] }));
    open("/projects");
    const table = within(await screen.findByRole("table", { name: /Your projects/ }));
    const row = within(table.getAllByRole("row")[1] as HTMLElement);
    expect(row.getByText("box")).toBeTruthy();
    expect(row.getByText("/home/ann/Work Dir")).toBeTruthy();
    expect(row.getByText("yours alone")).toBeTruthy();
    expect(row.queryByText(/file:\/\//)).toBeNull();
    expect(row.getByRole("button", { name: `Delete ${folder.key}…` })).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it("shares a project only after saying what that shows to everyone, and reports what moved", async () => {
    const sent: { body: unknown; csrf: string | null }[] = [];
    api.use(
      http.post("*/api/projects/choice", async ({ request }) => {
        sent.push({ body: await request.json(), csrf: request.headers.get(API_CSRF_HEADER) });
        api.use(answer("/api/projects", chosen("shared")));
        const made: ProjectChoice = {
          project: PROJECT,
          treatment: "shared",
          moved: { facts: 12, tasks: 1 },
        };
        return HttpResponse.json(made);
      }),
    );
    const user = open("/projects");
    await user.click(await screen.findByRole("button", { name: `Share ${PROJECT}…` }));
    const dialog = within(await screen.findByRole("alertdialog", { name: "Share this project?" }));
    const said = dialog.getByText(/become visible to everyone on this server, under your name/);
    // It says what the rule does, in the words the fact page uses, and where to read which case holds.
    expect(said.textContent).toContain("Your facts here with a citation that can be looked up");
    expect(said.textContent).toContain(
      "A fact stays yours alone while it has no such citation, while a duplicate merged into it has none, or while it cites a fact of yours that others cannot see; open the fact and it says which.",
    );
    expect(document.body.textContent).not.toMatch(/checkable/);
    expect(screen.getByText(/a fact that stays private says why when you open it/)).toBeTruthy();
    expect(sent).toEqual([]);
    expect(await violations()).toEqual([]);
    await user.click(dialog.getByRole("button", { name: "Share the project" }));
    expect(
      await screen.findByText(
        `${PROJECT} is shared: 12 facts and 1 task of yours became visible to everyone on this server.`,
      ),
    ).toBeTruthy();
    expect(sent).toEqual([{ body: { project: PROJECT, treatment: "shared" }, csrf: session.csrf }]);
    expect(await screen.findByRole("button", { name: `Keep private ${PROJECT}…` })).toBeTruthy();
    expect(screen.queryByText("private · not chosen yet")).toBeNull();
  });

  it("says which group a project is shared with, by its name, and offers each group the person is in", async () => {
    const sent: unknown[] = [];
    api.use(
      answer("/api/groups", {
        groups: [
          { name: "everyone", mine: true, members: [] },
          { name: "design", mine: true, members: [] },
          { name: "ops", mine: false, members: [] },
        ],
        people: [],
        administrator: false,
        you: "0197a000-0000-7000-8000-000000000001",
      }),
      http.post("*/api/projects/choice", async ({ request }) => {
        sent.push(await request.json());
        const [repository, named] = projects.projects;
        if (repository === undefined || named === undefined) throw new Error("two projects");
        const shared = {
          ...repository,
          treatment: "shared",
          chosen: true,
          group: "design",
        } as const;
        api.use(answer("/api/projects", { projects: [shared, named], sharing: true }));
        const made: ProjectChoice = {
          project: PROJECT,
          treatment: "shared",
          group: "design",
          moved: { facts: 2, tasks: 0 },
        };
        return HttpResponse.json(made);
      }),
    );
    const user = open("/projects");
    expect(
      await screen.findByRole("button", { name: `Share with everyone ${PROJECT}…` }),
    ).toBeTruthy();
    // Only the groups the person is in: `ops` is the administrator's to see, and not a choice here.
    expect(screen.queryByRole("button", { name: `Share with ops ${PROJECT}…` })).toBeNull();
    expect(screen.queryByRole("button", { name: `Share ${PROJECT}…` })).toBeNull();
    await user.click(screen.getByRole("button", { name: `Share with design ${PROJECT}…` }));
    const dialog = within(await screen.findByRole("alertdialog", { name: "Share this project?" }));
    expect(dialog.getByText(/become visible to the group design, under your name/)).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: "Share the project" }));
    expect(
      await screen.findByText(
        `${PROJECT} is shared: 2 facts and 0 tasks of yours became visible to the group design.`,
      ),
    ).toBeTruthy();
    expect(sent).toEqual([{ project: PROJECT, treatment: "shared", group: "design" }]);
    expect(await screen.findByText("shared with design")).toBeTruthy();
  });

  it("settles a project as private in one step when nothing was shared, and leaves a dialog without choosing", async () => {
    const sent: unknown[] = [];
    api.use(
      http.post("*/api/projects/choice", async ({ request }) => {
        sent.push(await request.json());
        api.use(answer("/api/projects", chosen("private")));
        return HttpResponse.json({
          project: PROJECT,
          treatment: "private",
          moved: { facts: 0, tasks: 0 },
        });
      }),
    );
    const user = open("/projects");
    await user.click(await screen.findByRole("button", { name: `Share ${PROJECT}…` }));
    await user.click(await screen.findByRole("button", { name: "Leave it as it is" }));
    expect(sent).toEqual([]);
    await user.click(screen.getByRole("button", { name: `Keep ${PROJECT} private` }));
    expect(await screen.findByText(/is private: 0 facts and 0 tasks of yours/)).toBeTruthy();
    expect(sent).toEqual([{ project: PROJECT, treatment: "private" }]);
    expect(screen.queryByRole("button", { name: `Keep ${PROJECT} private` })).toBeNull();
  });

  it("offers no choice on a server with one person, and says why", async () => {
    api.use(answer("/api/projects", { ...projects, sharing: false }));
    open("/projects");
    expect(
      await screen.findByText(
        "Nobody else is on this server, so everything here is private to you.",
      ),
    ).toBeTruthy();
    const table = within(await screen.findByRole("table", { name: /Your projects/ }));
    expect(table.queryByRole("button", { name: /Share|Keep/ })).toBeNull();
  });

  it("says who a named project is for, and gives no line while the person has none", async () => {
    const [repository] = projects.projects;
    api.use(answer("/api/projects", { projects: [repository], sharing: false }));
    open("/projects");
    const section = await naming();
    await screen.findByRole("table", { name: /Your projects/ });
    expect(
      section.getByText(
        /Most people never need this\. .* A directory that is not a repository, or a repository with no origin remote, gives it no name, and the agent gets no memory and no tasks there\./,
      ),
    ).toBeTruthy();
    expect(
      section.getByText(/once the project is made, this page shows the line/).textContent,
    ).toContain("A named project is yours alone and stays private.");
    expect(section.getByRole<HTMLInputElement>("textbox", { name: "Slug" }).maxLength).toBe(63);
    expect(section.queryByRole("heading", { name: "Tell your agent" })).toBeNull();
    expect(document.body.textContent).not.toContain("The uketsugi project for this directory");
    expect(await violations()).toEqual([]);
  });

  it("makes a named project from the keyboard, then gives the line for the agent with its key and says where it goes", async () => {
    const sent: { body: unknown; csrf: string | null }[] = [];
    api.use(
      http.post("*/api/projects", async ({ request }) => {
        sent.push({ body: await request.json(), csrf: request.headers.get(API_CSRF_HEADER) });
        api.use(answer("/api/projects", { ...projects, projects: [...projects.projects, FERRY] }));
        return HttpResponse.json(FERRY, { status: 201 });
      }),
    );
    const user = open("/projects");
    const section = await naming();
    const slug = section.getByRole<HTMLInputElement>("textbox", { name: "Slug" });
    expect(slug.getAttribute("aria-describedby")).toBe(
      section.getByText(/^Lower-case letters, digits and hyphens/).id,
    );
    slug.focus();
    await user.keyboard("ferry-notes{Enter}");
    expect(
      await section.findByText(
        "me/ferry-notes is made. Your agent does not know it yet: put its line, shown below, in the instruction file of the directory you work in.",
      ),
    ).toBeTruthy();
    expect(sent).toEqual([{ body: { slug: "ferry-notes" }, csrf: session.csrf }]);
    expect(slug.value).toBe("");
    expect(section.getByText(lineFor("me/ferry-notes"))).toBeTruthy();
    // Where the line goes: one file is named, the one this was tried with, and no other harness's.
    const where = section.getByText(/An agent learns a named project from/).textContent;
    expect(where).toContain(
      "Put the project’s line in that file, then start a new conversation in that directory. For Claude Code the file is CLAUDE.md in that directory. For another harness it is the instruction file your harness reads in that directory.",
    );
    section.getByRole("button", { name: "Copy the line for me/ferry-notes" }).focus();
    await user.keyboard("{Enter}");
    expect(await navigator.clipboard.readText()).toBe(lineFor("me/ferry-notes"));
    const table = within(screen.getByRole("table", { name: /Your projects/ }));
    expect(table.getByText("me/ferry-notes")).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it("sends the display name typed beside the slug, and shows it in the table where the readers show it", async () => {
    const sent: unknown[] = [];
    const named = { ...FERRY, name: "Ferry notes" };
    api.use(
      http.post("*/api/projects", async ({ request }) => {
        sent.push(await request.json());
        api.use(answer("/api/projects", { ...projects, projects: [...projects.projects, named] }));
        return HttpResponse.json(named, { status: 201 });
      }),
    );
    const user = open("/projects");
    const section = await naming();
    const name = section.getByRole<HTMLInputElement>("textbox", {
      name: "Display name (optional)",
    });
    expect(name.maxLength).toBe(120);
    expect(name.required).toBe(false);
    await user.type(section.getByRole("textbox", { name: "Slug" }), "ferry-notes");
    await user.type(name, "Ferry notes{Enter}");
    expect(await section.findByText(/^me\/ferry-notes is made\./)).toBeTruthy();
    expect(sent).toEqual([{ slug: "ferry-notes", name: "Ferry notes" }]);
    expect(name.value).toBe("");
    const table = within(screen.getByRole("table", { name: /Your projects/ }));
    expect(table.getByText("Ferry notes (me/ferry-notes)")).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it("keeps the line of a named project made earlier, with a button that copies it", async () => {
    const user = open("/projects");
    const section = await naming();
    expect(await section.findByText(lineFor("me/q4-expenses"))).toBeTruthy();
    await user.click(section.getByRole("button", { name: "Copy the line for me/q4-expenses" }));
    expect(await navigator.clipboard.readText()).toBe(lineFor("me/q4-expenses"));
    expect(section.getByRole("heading", { name: "Tell your agent" })).toBeTruthy();
  });

  it("answers a slug the server refuses in the server's words, keeps what was typed and makes nothing", async () => {
    const [repository] = projects.projects;
    api.use(
      answer("/api/projects", { projects: [repository], sharing: false }),
      http.post("*/api/projects", () => HttpResponse.json(refusedSlug, { status: 422 })),
    );
    const user = open("/projects");
    const section = await naming();
    const slug = section.getByRole<HTMLInputElement>("textbox", { name: "Slug" });
    await user.type(slug, "Ferry Notes");
    await user.click(section.getByRole("button", { name: "Make the project" }));
    const refusal = within(await section.findByRole("alert"));
    expect(refusal.getByText('"Ferry Notes" cannot be a project\'s slug.')).toBeTruthy();
    expect(refusal.getByText("Nothing was created.")).toBeTruthy();
    expect(
      refusal.getByText(
        "Use lower-case letters, digits and hyphens, starting with a letter or a digit, 63 characters at most.",
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("invalid_input");
    expect(slug.value).toBe("Ferry Notes");
    expect(section.queryByText(/is made\./)).toBeNull();
    expect(section.queryByRole("heading", { name: "Tell your agent" })).toBeNull();
    expect(await violations()).toEqual([]);

    // A slug that is then taken clears the refusal.
    api.use(
      http.post("*/api/projects", () => {
        api.use(answer("/api/projects", { projects: [repository, FERRY], sharing: false }));
        return HttpResponse.json(FERRY, { status: 201 });
      }),
    );
    await user.clear(slug);
    await user.type(slug, "ferry-notes{Enter}");
    expect(await section.findByText(/^me\/ferry-notes is made\./)).toBeTruthy();
    await waitFor(() => expect(section.queryByRole("alert")).toBeNull());
  });

  it("sends nothing while the slug is empty", async () => {
    const sent: unknown[] = [];
    api.use(
      http.post("*/api/projects", async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json(FERRY, { status: 201 });
      }),
    );
    const user = open("/projects");
    const section = await naming();
    await user.click(section.getByRole("button", { name: "Make the project" }));
    expect(section.getByRole<HTMLInputElement>("textbox", { name: "Slug" }).required).toBe(true);
    expect(sent).toEqual([]);
  });

  it("shows a project's other names, and joins one project into another only after saying what moves and that it cannot be undone", async () => {
    const [repository, named] = projects.projects;
    if (repository === undefined || named === undefined) throw new Error("the fixture has two");
    const renamed = "github.com/acme/new-name";
    api.use(
      answer("/api/projects", {
        ...projects,
        projects: [{ ...repository, names: ["github.com/acme/older"] }, named],
      }),
    );
    const sent: { body: unknown; csrf: string | null }[] = [];
    api.use(
      http.post("*/api/projects/join", async ({ request }) => {
        sent.push({ body: await request.json(), csrf: request.headers.get(API_CSRF_HEADER) });
        api.use(
          answer("/api/projects", {
            ...projects,
            projects: [{ ...repository, key: renamed, names: [PROJECT, "github.com/acme/older"] }],
          }),
        );
        return HttpResponse.json({
          from: PROJECT,
          into: renamed,
          facts: 41,
          tasks: 0,
          sessions: 2,
        });
      }),
    );
    const user = open("/projects");
    const table = within(await screen.findByRole("table", { name: /Your projects/ }));
    expect(table.getByText("github.com/acme/older")).toBeTruthy();
    expect(table.getByText(/Also called/)).toBeTruthy();

    await user.click(table.getByRole("button", { name: `Join ${PROJECT} into another project…` }));
    const dialog = within(
      await screen.findByRole("alertdialog", { name: "Join this project into another?" }),
    );
    expect(
      dialog.getByText(/Everything of yours here \(facts, tasks and sessions\) moves/),
    ).toBeTruthy();
    expect(dialog.getByText(/does not merge them\. A join cannot be undone\./)).toBeTruthy();
    expect(await violations()).toEqual([]);
    await user.click(dialog.getByRole("button", { name: "Leave it as it is" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(sent).toEqual([]);

    await user.click(table.getByRole("button", { name: `Join ${PROJECT} into another project…` }));
    const again = within(await screen.findByRole("alertdialog"));
    await user.type(again.getByRole("textbox", { name: "Join it into" }), ` ${renamed} `);
    await user.click(again.getByRole("button", { name: "Join the project" }));
    await waitFor(() =>
      expect(sent).toEqual([{ body: { from: PROJECT, into: renamed }, csrf: session.csrf }]),
    );
    expect(
      await within(await screen.findByRole("table", { name: /Your projects/ })).findByText(renamed),
    ).toBeTruthy();
    expect(screen.getByText(`${PROJECT}, github.com/acme/older`)).toBeTruthy();
  });
});
