/**
 * What the group cases stand on: the use-case world made an organization of three. Ann made it and
 * is its administrator; Bob and Cy were added after her; `design` is Ann and Bob.
 */
import {
  addToGroup,
  chooseTreatment,
  createApp,
  createTokenIdentity,
  invitePerson,
  issueToken,
  makeGroup,
  type Caller,
  type CorePorts,
} from "@uketsugi/core";
import { toolCaller, type ToolCaller } from "@uketsugi/testkit";
import { beforeAll } from "vitest";
import { CLIENT, type World } from "./use-case-world.ts";

export const P = (n: number) => `github.com/acme/groups-${n}`;
export const CLAIM = "The ledger table is read by name by billing";

export interface Groups {
  readonly ports: CorePorts;
  /** Each person as last read: `again` reads them as the store knows them now. */
  ann: Caller;
  bob: Caller;
  cy: Caller;
  readonly again: (who: Caller) => Promise<Caller>;
  readonly calls: (who: Caller, project: string) => ToolCaller;
  readonly choose: (
    who: Caller,
    project: string,
    group?: string,
  ) => ReturnType<typeof chooseTreatment>;
  readonly claimsOf: (who: Caller, project: string) => Promise<string[]>;
}

export function groupsWorld(w: World): Groups {
  let ports: CorePorts | undefined;
  const now = (): CorePorts => {
    if (ports === undefined) throw new Error("the people are read before they were added");
    return ports;
  };
  const again = async (who: Caller): Promise<Caller> => {
    const found = await now().store.directory.callerOf(who.orgId, who.principalId);
    if (found === null) throw new Error(`${who.displayName} is not a person here`);
    return found;
  };
  const calls = (who: Caller, project: string): ToolCaller =>
    toolCaller(createApp({ ...now(), identity: createTokenIdentity(now()) }), who, CLIENT, project);
  const world: Groups = {
    get ports() {
      return now();
    },
    ann: undefined as unknown as Caller,
    bob: undefined as unknown as Caller,
    cy: undefined as unknown as Caller,
    again,
    calls,
    choose: async (who, project, group) =>
      chooseTreatment(now(), await again(who), {
        project,
        treatment: "shared",
        ...(group === undefined ? {} : { group }),
      }),
    async claimsOf(who, project) {
      const found = await calls(who, project)("search_facts", { query: "ledger table" });
      return found.facts.map((fact) => fact.claim);
    },
  };
  beforeAll(async () => {
    ports = w.portsWith(null);
    const identity = createTokenIdentity(ports);
    const mine = await issueToken(ports, w.owner, "ann's laptop");
    const boby = await invitePerson(ports, w.owner, { name: "bob", operator_name: "ann" });
    const cyy = await invitePerson(ports, w.owner, { name: "cy", operator_name: "ann" });
    world.ann = await identity.authenticate(mine);
    world.bob = await identity.authenticate(boby.issued[0]?.secret);
    world.cy = await identity.authenticate(cyy.issued[0]?.secret);
    await makeGroup(ports, world.ann, { name: "design" });
    for (const person of [world.ann, world.bob])
      await addToGroup(ports, world.ann, "design", { person: person.principalId });
    world.ann = await again(world.ann);
    world.bob = await again(world.bob);
  });
  return world;
}
