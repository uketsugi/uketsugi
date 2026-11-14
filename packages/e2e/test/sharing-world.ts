/**
 * What the sharing cases stand on: the use-case world, made a server of two people. Ann runs it
 * and Bob was added, each with a token; both call tools through the pipeline, and each makes
 * their own choice for a project as the dashboard would for them.
 */
import {
  chooseTreatment,
  createApp,
  createTokenIdentity,
  invitePerson,
  issueToken,
  scopeOf,
  type Caller,
  type CorePorts,
  type Fact,
  type ReadScope,
  type StoredEvent,
  type Treatment,
} from "@uketsugi/core";
import { toolCaller, type ToolCaller } from "@uketsugi/testkit";
import { beforeAll } from "vitest";
import { CLIENT, type World } from "./use-case-world.ts";

/** A citation anyone with the repository can open, and one that is only somebody's word. */
export const CHECKABLE = "src/retry.ts:10-20";
export const TESTIMONY = { kind: "observation", text: "ran the retry tests on my machine" };

export interface Shared {
  readonly ann: Caller;
  readonly bob: Caller;
  /** The ports of a host with no model. */
  readonly ports: CorePorts;
  /** One person's tool calls in one project. */
  readonly calls: (who: Caller, project: string) => ToolCaller;
  readonly choose: (
    who: Caller,
    project: string,
    treatment: Treatment,
  ) => ReturnType<typeof chooseTreatment>;
  /** A fact as one person can read it; null when they cannot. */
  readonly seenBy: (who: Caller, id: string) => Promise<Fact | null>;
  /** What one audience's log holds about a record, oldest first. */
  readonly logged: (audienceId: string, subject: string) => Promise<StoredEvent[]>;
  readonly everyone: () => ReadScope;
}

/** Makes the world's host a server of two people before its cases run. */
export function sharedWorld(w: World): Shared {
  let made: { ann: Caller; bob: Caller; ports: CorePorts } | undefined;
  const now = () => {
    if (made === undefined) throw new Error("the people are read before they were added");
    return made;
  };

  beforeAll(async () => {
    const ports = w.portsWith(null);
    const identity = createTokenIdentity(ports);
    const mine = await issueToken(ports, w.owner, "ann's laptop");
    const invited = await invitePerson(ports, w.owner, { name: "bob", operator_name: "ann" });
    made = {
      ann: await identity.authenticate(mine),
      bob: await identity.authenticate(invited.issued[0]?.secret),
      ports,
    };
  });

  const app = (ports: CorePorts) => createApp({ ...ports, identity: createTokenIdentity(ports) });
  return {
    get ann() {
      return now().ann;
    },
    get bob() {
      return now().bob;
    },
    get ports() {
      return now().ports;
    },
    calls: (who, project) => toolCaller(app(now().ports), who, CLIENT, project),
    choose: (who, project, treatment) => chooseTreatment(now().ports, who, { project, treatment }),
    seenBy: (who, id) => now().ports.store.facts.get(scopeOf(who), id),
    async logged(audienceId, subject) {
      const scope = { orgId: now().ann.orgId, audienceIds: [audienceId] };
      const events = await now().ports.store.review.events(scope, audienceId, 0, 1000);
      return events.filter((event) => event.subject === subject);
    },
    everyone: () => ({ orgId: now().ann.orgId, audienceIds: [now().ann.sharedAudienceId ?? ""] }),
  };
}
