/**
 * Who may call: the host's own person, the people whoever runs the server adds, and what each of
 * them signs in with. A person has two kinds of credential. An agent token is what a harness
 * sends: it calls the tools and reads. A person key is what the person keeps to themselves: it
 * signs a browser in to the dashboard, where the things only a person may do are done. Neither
 * does the other's work, so a harness that holds a token cannot act as its person. A secret is
 * shown once, when it is issued; only its SHA-256 is kept.
 */
import type {
  Invitation,
  InviteRequest,
  PeopleList,
  PersonRemoved,
  TokenRevoked,
} from "@uketsugi/contracts";
import type { Caller, Credential, CredentialKind, Person } from "./domain.ts";
import type { NewCredential, PrincipalSeed } from "./store-port.ts";
import { invalidInput, ToolFailure } from "./failure.ts";
import { sha256Hex, toHex } from "./hash.ts";
import { AuthError, type CorePorts, type Identity, type IdGen } from "./ports.ts";

type DirectoryPorts = Pick<CorePorts, "store" | "clock" | "ids">;

/** The subject of a host's own person: whoever runs it. */
const OWNER_SUBJECT = "local:owner";
/** What the host's own person is called until they are named: on a host of one, nobody else reads it. */
const UNNAMED = "you";

/**
 * The ids and names a new principal takes: a new organization's unless one is given, and the
 * subject its identity provider knows it by, which may be made from the principal's own new id.
 */
export function principalSeed(
  ids: IdGen,
  person: { displayName: string; orgId?: string; subject: (principalId: string) => string },
): PrincipalSeed {
  const orgId = person.orgId ?? ids.uuid();
  const principalId = ids.uuid();
  const audienceId = ids.uuid();
  const { displayName } = person;
  return { subject: person.subject(principalId), displayName, orgId, principalId, audienceId };
}

/** The host's own person, created on first use with an organization of one and a private audience. */
export function ensureOwner(ports: DirectoryPorts): Promise<Caller> {
  const seed = principalSeed(ports.ids, { displayName: UNNAMED, subject: () => OWNER_SUBJECT });
  return ports.store.directory.ensurePrincipal(seed);
}

/**
 * Thrown when a token that was revoked is offered again. A revoked token stays revoked: the
 * message names it and the command that issues a new one, and never holds the whole token.
 */
export class RevokedTokenError extends Error {
  constructor(token: string, credential: Credential) {
    const shown = `${token.slice(0, 8)}… ("${credential.label}")`;
    const when = credential.revokedAt?.toISOString() ?? "earlier";
    super(
      `The token ${shown} was revoked at ${when} and cannot be used again. ` +
        "Issue a new one with `ukt token --rotate`, give it to your harnesses, and start the server with it.",
    );
    this.name = "RevokedTokenError";
  }
}

/**
 * Makes `token` a credential of the caller, unless it already is one. Only its SHA-256 is stored.
 * A token that was revoked is refused with `RevokedTokenError`, never stored a second time.
 */
export async function acceptToken(
  ports: DirectoryPorts,
  caller: Caller,
  token: string,
  label: string,
): Promise<void> {
  const tokenHash = await sha256Hex(token);
  const held = await ports.store.directory.credentialByTokenHash(tokenHash);
  if (held !== null && held.revokedAt !== null) throw new RevokedTokenError(token, held);
  if (held !== null) return;
  const credential = credentialOf(ports, caller, { kind: "agent", hash: tokenHash, label });
  await ports.store.directory.addCredential(credential);
}

type Holder = Pick<Caller, "orgId" | "principalId">;

/** A secret's hash as a credential of a person, to be stored. */
function credentialOf(
  ports: DirectoryPorts,
  person: Holder,
  secret: { kind: CredentialKind; hash: string; label: string },
): NewCredential {
  return {
    orgId: person.orgId,
    id: ports.ids.uuid(),
    principalId: person.principalId,
    kind: secret.kind,
    label: secret.label,
    tokenHash: secret.hash,
    createdAt: ports.clock.now(),
  };
}

/** How a secret of each kind begins, so that a person can tell which is which, and so can a refusal. */
const PREFIX: Readonly<Record<CredentialKind, string>> = { agent: "ukt_", person: "ukp_" };

type Issued = Invitation["issued"][number];

/** A new random credential for a person, not yet stored: its record, and the secret as it is told once. */
async function mint(
  ports: DirectoryPorts,
  person: Holder,
  kind: CredentialKind,
  label: string,
): Promise<{ record: NewCredential; issued: Issued }> {
  const secret = `${PREFIX[kind]}${toHex(ports.ids.bytes(24))}`;
  const record = credentialOf(ports, person, { kind, hash: await sha256Hex(secret), label });
  return { record, issued: { kind, id: record.id, label, secret } };
}

/** A new random credential for a person, stored: the secret is returned once and never kept. */
async function issue(
  ports: DirectoryPorts,
  person: Holder,
  kind: CredentialKind,
  label: string,
): Promise<Issued> {
  const { record, issued } = await mint(ports, person, kind, label);
  await ports.store.directory.addCredential(record);
  return issued;
}

/** A new random agent token for the caller, returned once and never stored. */
export async function issueToken(
  ports: DirectoryPorts,
  caller: Caller,
  label: string,
): Promise<string> {
  return (await issue(ports, caller, "agent", label)).secret;
}

/** What a token made by `ukt token --rotate` is called. */
const ROTATED_LABEL = "made by ukt token --rotate";

/**
 * Ends every live agent token of the caller and issues one new one: what `ukt token --rotate`
 * does. Nobody else's token is touched, and neither is a key the caller signs in to the dashboard
 * with. Replacements of one person's tokens run one after another, so after any number of them
 * at once exactly one token is live and each reports what it ended. Returns the new token, once,
 * with how many were ended.
 */
export async function replaceTokens(
  ports: DirectoryPorts,
  caller: Caller,
): Promise<{ token: string; revoked: number }> {
  const { record, issued } = await mint(ports, caller, "agent", ROTATED_LABEL);
  const revoked = await ports.store.directory.replaceAgentCredentials(record, ports.clock.now());
  return { token: issued.secret, revoked };
}

export interface TokenIdentityOptions {
  /** Whether every request must carry a token, the host's one person's included. Left out, theirs need not. */
  readonly requireToken?: boolean;
}

/**
 * The identity of a local host and a community server: a bearer token whose hash the store holds.
 * A request that carried none is the host's own person while nobody else is on the host, unless
 * whoever runs it asked every caller for a token: what one person keeps on their own machine is
 * theirs to reach from it. The first person added ends that for everyone.
 */
export function createTokenIdentity(
  ports: DirectoryPorts,
  options: TokenIdentityOptions = {},
): Identity {
  const { directory } = ports.store;
  const holderOf = async (secret: string, kind: CredentialKind): Promise<Caller> => {
    if (secret === "") throw new AuthError("missing");
    const hash = await sha256Hex(secret);
    const caller = await directory.callerByTokenHash(hash, kind, ports.clock.now());
    if (caller === null) throw new AuthError("invalid");
    return caller;
  };
  const onlyPerson = async (): Promise<Caller> => {
    if (options.requireToken === true) throw new AuthError("missing");
    const owner = await ensureOwner(ports);
    if ((await directory.people(owner.orgId)).length !== 1) throw new AuthError("missing");
    return owner;
  };
  return {
    challenge: "Bearer",
    authenticate: (bearer) => (bearer === undefined ? onlyPerson() : holderOf(bearer, "agent")),
    signIn: (key) => holderOf(key, "person"),
    current: (caller) =>
      caller.credentialId === null
        ? directory.callerOf(caller.orgId, caller.principalId)
        : directory.callerOfCredential(caller.orgId, caller.credentialId),
  };
}

/** The same name, however it was typed: people are told apart by it wherever a fact says who wrote it. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Names whoever runs the server before anyone joins them. On a host of one their name is `you`,
 * which nobody else reads; beside a shared fact it would tell another person nothing.
 */
async function nameOperator(
  ports: DirectoryPorts,
  operator: Caller,
  given: string | undefined,
): Promise<void> {
  if (operator.displayName !== UNNAMED) return;
  const name = given?.trim() ?? "";
  if (name === "" || sameName(name, UNNAMED)) {
    throw invalidInput(
      "Whoever runs this server has no name yet.",
      "Say what the others should call you: pass your own name with the first invitation (`ukt invite <name> --operator-name <your name>`).",
    );
  }
  await ports.store.directory.rename(operator.orgId, operator.principalId, name);
}

/** What a credential is called by default: what it is and whose. */
function labelOf(kind: CredentialKind, name: string, given: string | undefined): string {
  const what = kind === "agent" ? "harness token" : "dashboard key";
  return given?.trim() || `${name}'s ${what}`;
}

/**
 * Adds a person, as whoever runs the server asks, with a private audience of their own, a token
 * for their harness and a key for themselves. A name that is taken is refused unless the call
 * says which one credential that person is to get more of: nobody is handed another person's
 * memory by a shared first name. The first person added makes the server one of several people:
 * it gets its shared audience, and from then on a project can be shared. The person, their
 * credentials and that audience are stored together or not at all, so an invitation that fails
 * can simply be made again.
 */
export async function invitePerson(
  ports: DirectoryPorts,
  operator: Caller,
  input: InviteRequest,
): Promise<Invitation> {
  const name = input.name.trim();
  if (name === "" || sameName(name, UNNAMED)) {
    throw invalidInput(`"${input.name}" cannot be a person's name.`, "Pass the person's own name.");
  }
  const { directory } = ports.store;
  const named = (people: readonly Person[]) =>
    people.find((person) => sameName(person.displayName, name));
  const known = named(await directory.people(operator.orgId));
  if ((known === undefined) !== (input.another === undefined)) {
    throw new ToolFailure("conflict", {
      what:
        known === undefined
          ? `Nobody called ${name} is on this server.`
          : `${known.displayName} is already on this server.`,
      meaning: "Nothing was issued.",
      next:
        known === undefined
          ? "Add them first, without asking for another credential."
          : "To add a different person, give them a name of their own. To give this person another harness token or another dashboard key, say which: `ukt invite <name> --token` or `ukt invite <name> --key`.",
    });
  }
  if (known === undefined) {
    const gone = named(await directory.removedPeople(operator.orgId));
    if (gone !== undefined) {
      throw new ToolFailure("conflict", {
        what: `${gone.displayName} was on this server and was removed.`,
        meaning:
          "Nothing was issued: what they shared still carries that name, and a new person with it could not be told from them.",
        next: "Give the new person a name of their own.",
      });
    }
  }
  if (known !== undefined && input.another !== undefined) {
    const holder = { orgId: operator.orgId, principalId: known.id };
    const label = labelOf(input.another, known.displayName, input.label);
    return {
      person: known.displayName,
      added: false,
      issued: [await issue(ports, holder, input.another, label)],
    };
  }
  await nameOperator(ports, operator, input.operator_name);
  const seed = principalSeed(ports.ids, {
    displayName: name,
    orgId: operator.orgId,
    subject: (principalId) => `local:${principalId}`,
  });
  const made = [
    await mint(ports, seed, "agent", labelOf("agent", name, input.label)),
    await mint(ports, seed, "person", labelOf("person", name, undefined)),
  ];
  const records = made.map(({ record }) => record);
  await directory.addPerson(seed, ports.ids.uuid(), records);
  return { person: name, added: true, issued: made.map(({ issued }) => issued) };
}

/** Everyone on the server with their credentials, as whoever runs it lists them. No secret is among them. */
export async function listPeople(
  ports: Pick<CorePorts, "store">,
  operator: Caller,
): Promise<PeopleList> {
  const { directory } = ports.store;
  const people = await directory.people(operator.orgId);
  const rows = people.map(async (person) => ({
    id: person.id,
    name: person.displayName,
    tokens: (await directory.credentials(operator.orgId, person.id)).map((token) => ({
      id: token.id,
      kind: token.kind,
      label: token.label,
      created_at: token.createdAt.toISOString(),
      last_used_at: token.lastUsedAt?.toISOString() ?? null,
      revoked_at: token.revokedAt?.toISOString() ?? null,
    })),
  }));
  return { people: await Promise.all(rows) };
}

/** Ends one credential, as whoever runs the server asks; every other one goes on working. */
export async function revokeToken(
  ports: Pick<CorePorts, "store" | "clock">,
  operator: Caller,
  tokenId: string,
): Promise<TokenRevoked> {
  const id = tokenId.trim().toLowerCase();
  const { directory } = ports.store;
  const people = await directory.people(operator.orgId);
  const held = await Promise.all(
    people.map((person) => directory.credentials(operator.orgId, person.id)),
  );
  const token = held.flat().find((credential) => credential.id === id);
  if (token === undefined) {
    throw new ToolFailure("not_found", {
      what: `No token ${tokenId} is on this server.`,
      meaning: "Nothing was changed.",
      next: "Run `ukt people` and pass a token's id as it is listed there.",
    });
  }
  const revoked = await directory.revokeCredential(operator.orgId, id, ports.clock.now());
  return { id, revoked };
}

/**
 * Removes a person, as whoever runs the server asks: they leave the server's people and every
 * credential of theirs ends. What they shared stays, under their name; what was private to them
 * stays and nobody reaches it. The person who runs the server is not removable. Once one person
 * is left, the server takes that person's harnesses on this machine with no token again.
 */
export async function removePerson(
  ports: Pick<CorePorts, "store" | "clock">,
  operator: Caller,
  personId: string,
): Promise<PersonRemoved> {
  const { directory } = ports.store;
  const id = personId.trim().toLowerCase();
  const person = (await directory.people(operator.orgId)).find((listed) => listed.id === id);
  if (person === undefined) {
    throw new ToolFailure("not_found", {
      what: `Nobody with the id ${personId} is on this server.`,
      meaning: "Nothing was changed.",
      next: "Run `ukt people` and pass a person as it is listed there.",
    });
  }
  if (person.id === operator.principalId) {
    throw new ToolFailure("invalid_input", {
      what: "Whoever runs this server cannot be removed from it.",
      meaning: "Nothing was changed.",
      next: "To end one of their credentials, use `ukt revoke <id>`.",
    });
  }
  const ended = await directory.removePerson(operator.orgId, person.id, ports.clock.now());
  return { id: person.id, name: person.displayName, credentials_ended: ended };
}
