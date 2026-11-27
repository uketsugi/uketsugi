/**
 * Groups: the people of one organization a project can be shared with, and how people come into an
 * organization on a server that signs people in through a provider. An organization's
 * administrator is the person who made it; only they make a group, say who is
 * in it, and invite someone, because who may read another person's work is a decision about the
 * roster and not each person's own. Every person is in `everyone`, which cannot be left except
 * by being removed from the organization.
 */
import type {
  GroupChanged,
  GroupList,
  GroupMember,
  GroupNamed,
  JoinLink,
} from "@uketsugi/contracts";
import { EVERYONE, type Caller, type Group } from "./domain.ts";
import { forbidden, invalidInput, ToolFailure } from "./failure.ts";
import { sha256Hex, toHex } from "./hash.ts";
import { principalSeed, removePerson } from "./identity.ts";
import type { CorePorts } from "./ports.ts";
import type { GroupMembers } from "./store-port.ts";

type Ports = Pick<CorePorts, "store" | "clock" | "ids">;

/** How long an invitation can be used after it was made. */
export const INVITATION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The person who made the organization. */
async function administratorOf(ports: Ports, caller: Caller): Promise<string | undefined> {
  return (await ports.store.directory.people(caller.orgId)).find((person) => person.administrator)
    ?.id;
}

async function requireAdministrator(ports: Ports, caller: Caller): Promise<void> {
  if ((await administratorOf(ports, caller)) === caller.principalId) return;
  throw forbidden(
    "Only the person who made this organization makes groups and says who is in them.",
    "Ask them; what you can do is choose, for each project, which of your groups it is shared with.",
  );
}

async function viewOf(
  ports: Ports,
  caller: Caller,
  group: GroupMembers,
): Promise<GroupChanged["group"]> {
  const names = await ports.store.directory.names(caller.orgId, group.members);
  return {
    name: group.name,
    mine: group.members.includes(caller.principalId),
    members: group.members.map((id) => ({ id, name: names.get(id) ?? id })),
  };
}

/** The groups the person is in; the administrator sees every group, and everyone they could add. */
export async function listGroups(ports: Ports, caller: Caller): Promise<GroupList> {
  const administrator = (await administratorOf(ports, caller)) === caller.principalId;
  const mine = new Set(caller.groups.map((group) => group.id));
  const all = await ports.store.directory.groups(caller.orgId);
  const shown = all.filter((group) => administrator || mine.has(group.id));
  const people = administrator
    ? (await ports.store.directory.people(caller.orgId)).map((person) => ({
        id: person.id,
        name: person.displayName,
      }))
    : [];
  return {
    groups: await Promise.all(shown.map((group) => viewOf(ports, caller, group))),
    people,
    administrator,
  };
}

/** A group of the organization by its name, as the administrator names it. */
async function groupNamed(ports: Ports, caller: Caller, name: string): Promise<GroupMembers> {
  const wanted = name.trim().toLowerCase();
  const found = (await ports.store.directory.groups(caller.orgId)).find(
    (group) => group.name.toLowerCase() === wanted,
  );
  if (found === undefined) {
    throw new ToolFailure("not_found", {
      what: `This organization has no group called ${name}.`,
      meaning: "Nothing was changed.",
      next: "Make the group first, or name one of the groups listed.",
    });
  }
  return found;
}

export async function makeGroup(
  ports: Ports,
  caller: Caller,
  input: GroupNamed,
): Promise<GroupChanged> {
  await requireAdministrator(ports, caller);
  const name = input.name.trim();
  const group: Group = { id: ports.ids.uuid(), name };
  const taken = (await ports.store.directory.groups(caller.orgId)).some(
    (other) => other.name.toLowerCase() === name.toLowerCase(),
  );
  const reserved = name.toLowerCase() === EVERYONE;
  if (
    name === "" ||
    reserved ||
    taken ||
    !(await ports.store.directory.createGroup(caller.orgId, group))
  ) {
    throw invalidInput(
      reserved
        ? `${EVERYONE} is every organization's own group.`
        : `"${input.name}" cannot name a new group.`,
      "Give the group a name of its own that no other group of this organization has.",
    );
  }
  return { group: await viewOf(ports, caller, { ...group, members: [] }) };
}

/** A person of the organization, by id, as the administrator names them. */
async function personIn(ports: Ports, caller: Caller, id: string): Promise<string> {
  const person = (await ports.store.directory.people(caller.orgId)).find(
    (listed) => listed.id === id.trim().toLowerCase(),
  );
  if (person === undefined) {
    throw new ToolFailure("not_found", {
      what: `Nobody with the id ${id} is in this organization.`,
      meaning: "Nothing was changed.",
      next: "Choose a person from the list.",
    });
  }
  return person.id;
}

/** The group as its members now stand. */
async function membersOf(ports: Ports, caller: Caller, group: Group): Promise<GroupMembers> {
  const now = (await ports.store.directory.groups(caller.orgId)).find(
    (other) => other.id === group.id,
  );
  return now ?? { ...group, members: [] };
}

/**
 * A change the administrator makes to who is in a group: the group and the person of the
 * organization they name, the change itself, and the group as it then stands.
 */
async function changeGroup(
  ports: Ports,
  caller: Caller,
  names: { group: string; person: string },
  change: (group: GroupMembers, person: string) => Promise<void>,
): Promise<GroupChanged> {
  await requireAdministrator(ports, caller);
  const group = await groupNamed(ports, caller, names.group);
  await change(group, await personIn(ports, caller, names.person));
  return { group: await viewOf(ports, caller, await membersOf(ports, caller, group)) };
}

export function addToGroup(
  ports: Ports,
  caller: Caller,
  groupName: string,
  input: GroupMember,
): Promise<GroupChanged> {
  const names = { group: groupName, person: input.person };
  return changeGroup(ports, caller, names, (group, person) =>
    ports.store.directory.addMember(caller.orgId, group.id, person),
  );
}

/**
 * Takes a person out of a group: they see none of its projects from then on, and what they
 * published there stays, under their name. Out of `everyone` is out of the organization, as
 * `ukt remove` does it.
 */
export function removeFromGroup(
  ports: Ports,
  caller: Caller,
  groupName: string,
  personId: string,
): Promise<GroupChanged> {
  return changeGroup(
    ports,
    caller,
    { group: groupName, person: personId },
    async (group, person) => {
      if (person === caller.principalId) {
        throw invalidInput(
          "The person who made this organization cannot be taken out of its groups.",
          "Take someone else out.",
        );
      }
      if (group.name === EVERYONE) await removePerson(ports, caller, person);
      else await ports.store.directory.removeMember(caller.orgId, group.id, person);
    },
  );
}

/** The secret in an invitation's link begins so that a person can tell what it is. */
const INVITATION_PREFIX = "ukv_";

/**
 * Makes an invitation to the caller's organization, as its administrator asks. The secret is
 * returned once and only its hash is kept. Nothing is sent: the administrator hands the link to
 * the person however they like.
 */
export async function makeInvitation(
  ports: Ports,
  caller: Caller,
): Promise<{ secret: string } & Pick<JoinLink, "expires_at">> {
  await requireAdministrator(ports, caller);
  const secret = `${INVITATION_PREFIX}${toHex(ports.ids.bytes(24))}`;
  const createdAt = ports.clock.now();
  const expiresAt = new Date(createdAt.getTime() + INVITATION_DAYS * DAY_MS);
  await ports.store.directory.addInvitation({
    orgId: caller.orgId,
    id: ports.ids.uuid(),
    tokenHash: await sha256Hex(secret),
    createdBy: caller.principalId,
    createdAt,
    expiresAt,
  });
  return { secret, expires_at: expiresAt.toISOString() };
}

function unusable(what: string): ToolFailure {
  return new ToolFailure("forbidden", {
    what,
    meaning: "Nobody was added.",
    next: "Ask the person who invited you for a new link.",
  });
}

/**
 * Makes the person a member of the organization an invitation is to, in `everyone`, when their
 * invitation can still be used. A subject that has an account already is refused: it would have to
 * leave its own organization's memory behind, and nothing here moves it.
 */
export async function acceptInvitation(
  ports: Ports,
  secret: string,
  person: { displayName: string; subject: string },
): Promise<Caller> {
  const tokenHash = await sha256Hex(secret);
  const { directory } = ports.store;
  const invitation = await directory.invitation(tokenHash);
  const at = ports.clock.now();
  if (invitation === null) throw unusable("That link is not an invitation this server made.");
  if (invitation.usedAt !== null) throw unusable("That invitation was used already.");
  if (invitation.expiresAt.getTime() <= at.getTime())
    throw unusable("That invitation has expired.");
  if ((await directory.knownSubject(person.subject)) !== null) {
    throw unusable("You already have an account on this service, in an organization of your own.");
  }
  const seed = principalSeed(ports.ids, {
    displayName: person.displayName,
    orgId: invitation.orgId,
    subject: () => person.subject,
  });
  if (!(await directory.joinWithInvitation(seed, ports.ids.uuid(), tokenHash, at))) {
    throw unusable("That invitation was used or has expired.");
  }
  const caller = await directory.callerOf(seed.orgId, seed.principalId);
  if (caller === null) throw new Error(`the person ${person.subject} could not be added`);
  return caller;
}
