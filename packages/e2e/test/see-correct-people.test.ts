/**
 * What a person's own changes leave alone when somebody else is on the server: another person's
 * facts, tasks and words are not theirs to correct, close or delete.
 */
import { closeTask, correctFact, deleteProject, projectContents } from "@uketsugi/core";
import { expect, test } from "vitest";
import { CHECKABLE, sharedWorld } from "./sharing-world.ts";
import { describeUseCases } from "./use-case-world.ts";

describeUseCases("a person's own changes on a server of two people", (w) => {
  const s = sharedWorld(w);
  let projects = 0;

  /** Both share the project; each publishes a fact others can check and a task. */
  async function setUp() {
    projects += 1;
    const PROJECT = `github.com/acme/two-people-${projects}`;
    await s.choose(s.ann, PROJECT, "shared");
    await s.choose(s.bob, PROJECT, "shared");
    const [ann, bob] = [s.calls(s.ann, PROJECT), s.calls(s.bob, PROJECT)];
    const mine = await ann("publish_fact", {
      claim: "Ann says retries stop",
      citations: CHECKABLE,
    });
    const theirs = await bob("publish_fact", {
      claim: "Bob says backoff doubles",
      citations: CHECKABLE,
    });
    const myTask = await ann("publish_task", { title: "Ann's task" });
    const theirTask = await bob("publish_task", { title: "Bob's task" });
    return {
      PROJECT,
      ann,
      bob,
      mine,
      theirs,
      myTask: myTask.task.id,
      theirTask: theirTask.task.id,
    };
  }

  test("a person corrects their own fact and is refused another person's, which stays as it was", async () => {
    const { mine, theirs } = await setUp();
    await expect(
      correctFact(s.ports, s.ann, theirs.id, { claim: "Ann rewrote Bob's fact" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect((await s.seenBy(s.bob, theirs.id))?.claim).toBe("Bob says backoff doubles");
    const own = await correctFact(s.ports, s.ann, mine.id, {
      claim: "Ann says retries stop at six",
    });
    expect(own.changed).toBe(true);
  });

  test("deleting a project takes the person's facts and tasks and leaves the other person's, which they still see", async () => {
    const { PROJECT, mine, theirs, myTask, theirTask } = await setUp();
    const shown = await projectContents(s.ports, s.ann, { project: PROJECT });
    expect(shown).toMatchObject({ facts: 1, tasks: 1, others_facts: 1, others_tasks: 1 });
    const gone = await deleteProject(s.ports, s.ann, { project: PROJECT });
    expect(gone).toMatchObject({ facts: 1, tasks: 1 });
    expect(await s.seenBy(s.ann, mine.id)).toBeNull();
    expect(await s.seenBy(s.bob, theirs.id)).not.toBeNull();
    expect(await s.seenBy(s.ann, theirs.id)).not.toBeNull();
    const left = await s.ports.store.tasks.get(s.everyone(), theirTask);
    expect(left).toMatchObject({ publisher: s.bob.principalId });
    expect(await s.ports.store.tasks.get(s.everyone(), myTask)).toBeNull();
  });

  test("a person closes a task of theirs, or one their agent holds, and is refused another person's", async () => {
    const { ann, myTask, theirTask } = await setUp();
    await expect(closeTask(s.ports, s.ann, theirTask)).rejects.toMatchObject({ code: "forbidden" });
    expect(await s.ports.store.tasks.get(s.everyone(), theirTask)).toMatchObject({ state: "open" });
    expect(await closeTask(s.ports, s.ann, myTask)).toEqual({ id: myTask, changed: true });
    // Ann's agent holds Bob's task: it is hers to close then.
    await ann("claim_task", { id: theirTask });
    expect(await closeTask(s.ports, s.ann, theirTask)).toEqual({ id: theirTask, changed: true });
  });
});
