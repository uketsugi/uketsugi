/**
 * A person joins one of their projects into another: a renamed repository keeps its memory, a
 * call that still names the old key lands in the new project, and on a server with others a join
 * is refused while the old project holds anything shared, with nothing left unreachable.
 */
import {
  createNamedProject,
  joinProjects,
  listFacts,
  listProjects,
  listTasks,
  scopeOf,
} from "@uketsugi/core";
import { toolCaller } from "@uketsugi/testkit";
import { describe, expect, test } from "vitest";
import { CHECKABLE, sharedWorld, TESTIMONY } from "./sharing-world.ts";
import { CLIENT, describeUseCases, type World } from "./use-case-world.ts";

const found = (claims: { claim: string | null }[]) => claims.map((fact) => fact.claim);

describeUseCases("joining a project into another", (w) => {
  const calls = (project: string) => toolCaller(w.app, w.owner, CLIENT, project);
  let made = 0;
  /** A repository of the person's with a fact, a task and a session in it. */
  async function used() {
    made += 1;
    const old = `github.com/acme/old-${made}`;
    const claim = `The retry queue of old ${made} gives up after six tries`;
    await calls(old)("publish_fact", { claim, citations: TESTIMONY });
    await calls(old)("publish_task", { title: `Move old ${made} to the new queue` });
    return { old, claim, fresh: `github.com/acme/new-${made}` };
  }
  const join = (from: string, into: string) =>
    joinProjects(w.portsWith(null), w.owner, { from, into });
  const listed = async () => (await listProjects(w.portsWith(null), w.owner)).projects;

  test("everything of the old project is the new one's, whichever key a search names, and the old key is the new one's other name", async () => {
    const { old, claim, fresh } = await used();
    const ref = w.portsWith(null);
    const before = await ref.store.sessions.latest(w.owner.orgId, w.owner.principalId, old);
    expect(before).not.toBeNull();

    // The new key is spelled as a remote prints it, and nothing has used it: a rename.
    const joined = await join(old, `https://github.com/Acme/${fresh.split("/")[2]}.git`);
    expect(joined).toEqual({ from: old, into: fresh, facts: 1, tasks: 1, sessions: 1 });

    for (const named of [fresh, old]) {
      const result = await calls(named)("search_facts", { query: "retry queue gives up" });
      expect(found(result.facts)).toEqual([claim]);
    }
    expect((await ref.store.sessions.latest(w.owner.orgId, w.owner.principalId, fresh))?.id).toBe(
      before?.id,
    );
    expect(await ref.store.sessions.latest(w.owner.orgId, w.owner.principalId, old)).toBeNull();
    expect(await ref.store.facts.list(w.scope, { project: old, limit: 5 })).toEqual([]);
    expect(await ref.store.tasks.list(w.scope, { project: old, limit: 5 })).toEqual([]);

    const keys = (await listed()).map((project) => project.key);
    expect(keys).not.toContain(old);
    expect((await listed()).find((project) => project.key === fresh)).toMatchObject({
      names: [old],
      facts: 1,
    });

    // A call that names the old key, from an old clone, publishes into the new project.
    await calls(old)("publish_fact", { claim: "Written from the old clone", citations: TESTIMONY });
    expect(found(await ref.store.facts.list(w.scope, { project: fresh, limit: 5 }))).toContain(
      "Written from the old clone",
    );
  });

  test("the dashboard's lists filtered or searched by the old key show the new project's, as a link made before the join still does", async () => {
    const { old, claim, fresh } = await used();
    await join(old, fresh);
    const ports = w.portsWith(null);

    for (const named of [old, fresh]) {
      const facts = await listFacts(ports, w.owner, { project: named, limit: 10 });
      const searched = await listFacts(ports, w.owner, {
        project: named,
        q: "retry queue",
        limit: 10,
      });
      const tasks = await listTasks(ports, w.owner, { project: named, limit: 10 });
      expect([found(facts.facts), found(searched.facts), tasks.tasks.length]).toEqual([
        [claim],
        [claim],
        1,
      ]);
    }
  });

  test("names never chain: joining the new project into another points the old key at that one too", async () => {
    const { old, claim, fresh } = await used();
    const last = `github.com/acme/last-${made}`;
    await join(old, fresh);
    await join(fresh, last);
    const project = (await listed()).find((entry) => entry.key === last);
    expect(project?.names).toEqual([old, fresh].sort());
    expect(await w.store.projects.nameFor(w.owner.orgId, w.owner.principalId, old)).toBe(last);
    for (const named of [old, fresh, last]) {
      const result = await calls(named)("search_facts", { query: "retry queue gives up" });
      expect(found(result.facts)).toEqual([claim]);
    }
    // Joining into a name means its project, so a name is never joined into itself.
    await expect(join(last, old)).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("refuses a project that is the same, one that is unknown to the person and a key that is no project, and changes nothing", async () => {
    const { old, claim, fresh } = await used();
    await expect(join(old, `https://${old}.git`)).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("into itself") as string,
    });
    await expect(join(`github.com/acme/never-used-${made}`, fresh)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(join(old, "billing")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(join(old, `me/never-made-${made}`)).rejects.toMatchObject({
      code: "invalid_input",
    });
    const result = await calls(old)("search_facts", { query: "retry queue gives up" });
    expect(found(result.facts)).toEqual([claim]);
    expect((await listed()).map((project) => project.key)).not.toContain(fresh);
  });
});

/** What the shared audience holds in a project, as the person sees it, and what stays in their own. */
async function stranded(w: World, who: Parameters<typeof scopeOf>[0], project: string) {
  const scope = scopeOf(who);
  return {
    facts: await w.store.facts.list(scope, { project, limit: 50 }),
    tasks: await w.store.tasks.list(scope, { project, limit: 50 }),
  };
}

describeUseCases("joining a project on a server of two people", (w) => {
  const s = sharedWorld(w);
  let made = 0;
  const names = () => {
    made += 1;
    return { old: `github.com/acme/team-old-${made}`, fresh: `github.com/acme/team-new-${made}` };
  };

  test("is refused while the old project holds a shared record, says how many and leaves it as it was", async () => {
    const { old, fresh } = names();
    await s.choose(s.ann, old, "shared");
    const ann = s.calls(s.ann, old);
    const shared = await ann("publish_fact", {
      claim: "Ann's shared retry fact",
      citations: CHECKABLE,
    });
    await ann("publish_task", { title: "Ann's shared task" });
    await expect(joinProjects(s.ports, s.ann, { from: old, into: fresh })).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("2 shared records") as string,
    });
    expect((await s.seenBy(s.ann, shared.id))?.project).toBe(old);
    expect(await s.ports.store.projects.nameFor(s.ann.orgId, s.ann.principalId, old)).toBeNull();
    expect((await stranded(w, s.ann, fresh)).facts).toEqual([]);

    // Keeping the project private brings what Ann shared home, and then it joins.
    await s.choose(s.ann, old, "private");
    const joined = await joinProjects(s.ports, s.ann, { from: old, into: fresh });
    expect(joined).toMatchObject({ facts: 1, tasks: 1 });
  });

  test("is refused for a shared record another person wrote, which a name of Ann's could not bring along", async () => {
    const { old, fresh } = names();
    await s.calls(s.ann, old)("publish_fact", {
      claim: "Ann keeps this to herself",
      citations: TESTIMONY,
    });
    await s.choose(s.bob, old, "shared");
    await s.calls(s.bob, old)("publish_fact", {
      claim: "Bob shares his retry fact",
      citations: CHECKABLE,
    });
    await expect(joinProjects(s.ports, s.ann, { from: old, into: fresh })).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("1 shared record") as string,
    });
    expect((await stranded(w, s.ann, old)).facts.map((fact) => fact.claim).sort()).toEqual([
      "Ann keeps this to herself",
      "Bob shares his retry fact",
    ]);
  });

  test("an old project with only private records is joined, and a search naming it returns every one of them, with nothing left under it", async () => {
    const { old, fresh } = names();
    const ann = s.calls(s.ann, old);
    const claims = ["Private fact about the queue one", "Private fact about the queue two"];
    for (const claim of claims) await ann("publish_fact", { claim, citations: TESTIMONY });
    await ann("publish_task", { title: "A private task for the queue" });
    // Bob's own private record in the same key is Bob's, and a join of Ann's leaves it where it is.
    await s.calls(s.bob, old)("publish_fact", {
      claim: "Bob's private fact about the queue",
      citations: TESTIMONY,
    });

    const joined = await joinProjects(s.ports, s.ann, { from: old, into: fresh });
    expect(joined).toMatchObject({ facts: 2, tasks: 1 });

    const viaOld = await ann("search_facts", { query: "private fact about the queue" });
    expect(found(viaOld.facts).sort()).toEqual(claims);
    const left = await stranded(w, s.ann, old);
    expect(left.facts.map((fact) => fact.claim)).toEqual([]);
    expect(left.tasks).toEqual([]);
    const now = await stranded(w, s.ann, fresh);
    expect(now.facts.map((fact) => fact.claim).sort()).toEqual(claims);
    expect(now.tasks).toHaveLength(1);
    const bobs = await s.calls(s.bob, old)("search_facts", {
      query: "private fact about the queue",
    });
    expect(found(bobs.facts)).toEqual(["Bob's private fact about the queue"]);
  });

  describe("the person's choice for the old project", () => {
    const choiceOf = (project: string) =>
      s.ports.store.projects.choice(s.ann.orgId, s.ann.principalId, project);
    /** A project of Ann's with a session, an empty choice for it of `treatment` where given. */
    async function used(old: string, treatment?: "private" | "shared") {
      await s.calls(s.ann, old)("search_facts", { query: "anything" });
      if (treatment !== undefined) await s.choose(s.ann, old, treatment);
    }

    test("stands for a new repository, and the old project has none left", async () => {
      const { old, fresh } = names();
      await used(old, "shared");
      await joinProjects(s.ports, s.ann, { from: old, into: fresh });
      expect(await choiceOf(fresh)).toBe("shared");
      expect(await choiceOf(old)).toBeNull();
    });

    test("gives way to the private choice a project of Ann's own was made with", async () => {
      const { old } = names();
      await used(old, "shared");
      const own = await createNamedProject(s.ports, s.ann, { slug: `own-${made}` });
      await joinProjects(s.ports, s.ann, { from: old, into: own.key });
      expect(await choiceOf(own.key)).toBe("private");
      expect(await choiceOf(old)).toBeNull();
    });

    test("gives way to the privacy of a folder with no origin, which is never shared, however old was", async () => {
      const { old } = names();
      await used(old, "shared");
      const folder = `file://box/work/fresh-${made}`;
      await joinProjects(s.ports, s.ann, { from: old, into: folder });
      expect(await choiceOf(folder)).toBe("private");
      expect(await choiceOf(old)).toBeNull();
    });

    test("gives way to a choice already made for the new project", async () => {
      const { old, fresh } = names();
      await used(old, "shared");
      await s.choose(s.ann, fresh, "private");
      await joinProjects(s.ports, s.ann, { from: old, into: fresh });
      expect(await choiceOf(fresh)).toBe("private");
      expect(await choiceOf(old)).toBeNull();
    });

    test("is none when the old project had none", async () => {
      const { old, fresh } = names();
      await used(old);
      await joinProjects(s.ports, s.ann, { from: old, into: fresh });
      expect(await choiceOf(fresh)).toBeNull();
    });
  });
});
