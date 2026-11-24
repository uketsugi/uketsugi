/**
 * The domain's records. Ids are UUIDv7 strings made by the IdGen port; times are `Date`s read from
 * the Clock port. Nothing here knows how a record is stored or sent.
 */
import type {
  CitationClass,
  FlagKind,
  TaskNote as NoteView,
  Status,
  TaskState,
} from "@uketsugi/contracts";

export type { CitationClass, FlagKind, Status, TaskState };

/** Who is calling, as the Identity port resolved the request's credential. */
export interface Caller {
  /** The organization: the isolation boundary. A local host is one implicit organization. */
  readonly orgId: string;
  /** The person (or service account) the credential belongs to. */
  readonly principalId: string;
  readonly displayName: string;
  /** The credential the request was signed in with; null for a caller the host resolved with no token. */
  readonly credentialId: string | null;
  /** The person's own audience: where a write lands unless the person shares its project. */
  readonly privateAudienceId: string;
  /** What everyone on the server sees. Null on a host with one person: nothing is shared there. */
  readonly sharedAudienceId: string | null;
  /** Every audience the caller may read: the visible set. Every store read takes it. */
  readonly visibleAudienceIds: readonly string[];
}

/** The scope of a read: the organization and the audiences the reader may see. */
export interface ReadScope {
  readonly orgId: string;
  readonly audienceIds: readonly string[];
}

export const CREDENTIAL_KINDS = ["agent", "person"] as const;

/**
 * What a credential opens. An `agent` token is what a harness sends: it calls the tools and
 * reads. A `person` key is what a person keeps to themselves: it opens the dashboard, where the
 * things only a person may do are done, and nothing else. A harness never needs the second.
 */
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** A principal's secret, as the directory keeps it. The secret itself is never stored, only its SHA-256. */
export interface Credential {
  readonly orgId: string;
  readonly id: string;
  readonly principalId: string;
  readonly kind: CredentialKind;
  readonly label: string;
  readonly createdAt: Date;
  /** When a request last signed in with it, to the minute; null until one has. */
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

/** A person of the organization, as whoever runs the server lists them. */
export interface Person {
  readonly id: string;
  readonly displayName: string;
}

/**
 * The kinds of audience, the unit of visibility: a person's own, and the one everyone on a server
 * with several people sees.
 */
export const AUDIENCE_KINDS = ["private", "shared"] as const;

export const TREATMENTS = ["private", "shared"] as const;

/**
 * How a person treats a project: `shared` shows what they publish there that others can check to
 * everyone on the server; `private` keeps all of it theirs. Only the person chooses.
 */
export type Treatment = (typeof TREATMENTS)[number];

export const PROJECT_KINDS = ["repository", "named"] as const;

/** A project as a call names it: its kind and its canonical key. */
export interface ProjectRef {
  readonly kind: (typeof PROJECT_KINDS)[number];
  /** `host/owner/name` for a repository; `<owner>/<slug>` for a named project. Lower case. */
  readonly key: string;
}

/** A project's record. Its key is its identity within the organization. */
export interface Project extends ProjectRef {
  readonly orgId: string;
}

/**
 * A project one person works in, with what is theirs alone about it: their choice for it (null
 * while they have made none) and the name they gave a named project of their own.
 */
export interface PersonProject extends Project {
  readonly choice: Treatment | null;
  readonly displayName: string | null;
}

/** A typed record of where a claim comes from. The kind decides the class. */
export type Citation =
  | { kind: "file"; repo: string; path: string; lines?: string; commit?: string }
  | { kind: "commit"; repo: string; commit: string }
  | { kind: "pull_request" | "issue"; repo: string; number: number }
  | { kind: "web"; url: string; quote?: string }
  | { kind: "fact"; fact: string }
  | { kind: "observation"; text: string; at?: string }
  | { kind: "document"; title: string; url?: string }
  | { kind: "person"; who: string; at?: string; quote?: string };

/** A citation with the class the server gave it, and why when it is testimony. */
export interface ClassedCitation {
  readonly citation: Citation;
  readonly class: CitationClass;
  readonly reason?: string;
}

/** One claim that stands by itself, with its citations, author and review status. */
export interface Fact {
  readonly orgId: string;
  readonly id: string;
  readonly audienceId: string;
  /** The canonical key of the project the fact was published in. */
  readonly project: string;
  /** Null in a stub: a redacted fact. */
  readonly claim: string | null;
  readonly detail: string | null;
  readonly question: string | null;
  readonly citations: readonly ClassedCitation[];
  readonly status: Status;
  /** The person whose agent published it. */
  readonly author: string;
  /** SHA-256 of the canonical form of claim, detail, question and citations, in hex. */
  readonly contentHash: string;
  /** SHA-256 of the normalized claim, in hex: how a repeated publish is recognised. */
  readonly claimHash: string;
  /**
   * The fact that replaced this one, when it is superseded: the next link of its chain, which may
   * be superseded in turn. The live fact at the chain's head is the store's `heads` to find.
   */
  readonly supersededBy: string | null;
  /** Whether a vector is stored for the fact. The vector itself stays in the store. */
  readonly embedded: boolean;
  /** When the fact's text was taken out; null unless it was redacted. Who did it is in the log. */
  readonly redactedAt: Date | null;
  /**
   * The session a model wrote the fact from, when one did: its author is that session's person,
   * who never saw it written. Null for a fact an agent published.
   */
  readonly digestSession: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The text and derived keys of a fact, as a publish or an in-place correction writes them. */
export interface FactContent {
  readonly claim: string;
  readonly detail: string | null;
  readonly question: string | null;
  readonly citations: readonly ClassedCitation[];
  readonly contentHash: string;
  readonly claimHash: string;
  /** Normalized identifiers found in the text, for the identifier stream. */
  readonly idents: readonly string[];
  /** The ids of the facts the citations name: how the facts that rest on a fact are found. */
  readonly citedFacts: readonly string[];
}

/** One person's check of a fact: who, when, and at which version of the source. */
export interface Confirmation {
  readonly orgId: string;
  readonly factId: string;
  readonly audienceId: string;
  readonly person: string;
  readonly at: Date;
  readonly sourceVersion: string | null;
  readonly checked: string | null;
}

/** Who raised a flag or made a ruling: a person, or a job with the runner that ran it. */
export type Actor =
  | { readonly kind: "person"; readonly id: string }
  | { readonly kind: "job"; readonly job: string; readonly runner: RunnerKind };

/** A mark of doubt on a fact. */
export interface Flag {
  readonly orgId: string;
  readonly id: string;
  readonly audienceId: string;
  readonly factId: string;
  readonly kind: FlagKind;
  readonly raisedBy: Actor;
  readonly at: Date;
  readonly clearedAt: Date | null;
}

export const RULING_DECISIONS = ["merge_duplicate", "revert"] as const;

/** What a ruling decided: a merge of duplicates, or the undoing of another ruling. */
export type RulingDecision = (typeof RULING_DECISIONS)[number];

/** One decision a person or a job made, recorded with codes and never text. */
export interface Ruling {
  readonly orgId: string;
  readonly id: string;
  readonly audienceId: string;
  readonly decision: RulingDecision;
  /** The fact the ruling is about. */
  readonly factId: string;
  readonly decidedBy: Actor;
  readonly reasons: readonly string[];
  /** The ruling that undid this one. */
  readonly revertedBy: string | null;
  readonly at: Date;
}

export const EVENT_KINDS = [
  "FactPublished",
  "FactRewritten",
  "FactSuperseded",
  "FactConfirmed",
  "FactRedacted",
  "FactShared",
  "FactWithdrawn",
  "FlagRaised",
  "FlagCleared",
  "RulingReverted",
  "TaskPublished",
  "TaskClaimed",
  "TaskReleased",
  "TaskDone",
  "TaskNoted",
  "TaskShared",
  "TaskWithdrawn",
] as const;

/** What happened to a record. An event holds ids, kinds and hashes, never text. */
export type EventKind = (typeof EVENT_KINDS)[number];

/** Where a task stood when a new lease was granted on it. */
export type ClaimedFrom = "open" | "handed_off" | "lapsed" | "take_over";

/** A move's payload. The entry in the log a record leaves says so; the one in the log it joins is empty. */
type Moved = { readonly left?: true };

/** A task's change: the version it made. */
type Versioned = { readonly version: number };

/** A change under a task's lease: the version it made, and the note the call added, if any. */
type Noted = Versioned & { readonly note?: string };

/** What each kind of event holds: ids, codes and hashes, never text. */
export interface EventPayloads {
  readonly FactPublished: {
    readonly id: string;
    readonly contentHash: string;
    readonly claimHash: string;
  };
  /** The text's hash before a correction and after. */
  readonly FactRewritten: { readonly before: string; readonly after: string };
  /** A merge, so that it can be undone. */
  readonly FactSuperseded: {
    readonly ruling: string;
    /** The fact that survived. */
    readonly by: string;
    /** The merged fact's status before. */
    readonly was: "confirmed" | "unconfirmed";
    /** Hashes of the citations the survivor took from the merged fact. */
    readonly taken: readonly string[];
  };
  readonly FactConfirmed: { readonly id: string; readonly person: string };
  readonly FactRedacted: Readonly<Record<string, never>>;
  readonly FactShared: Moved;
  readonly FactWithdrawn: Moved;
  /** `otherFact`: the fact it contradicts, or the source that changed under it. */
  readonly FlagRaised: {
    readonly id: string;
    readonly factId: string;
    readonly kind: FlagKind;
    readonly otherFact?: string;
  };
  readonly FlagCleared: {
    readonly factId: string;
    readonly kinds: readonly FlagKind[];
    readonly count: number;
  };
  readonly RulingReverted: { readonly ruling: string; readonly reverts: string };
  readonly TaskPublished: Versioned & { readonly tracked: boolean };
  /** `from`: where the task stood; `previous_holder`: whose lease it replaced. */
  readonly TaskClaimed: Versioned & {
    readonly from: ClaimedFrom;
    readonly previous_holder?: string;
    readonly lease_until: string;
  };
  readonly TaskReleased: Noted & { readonly handed_off: boolean };
  readonly TaskDone: Noted;
  readonly TaskNoted: Noted;
  readonly TaskShared: Moved;
  readonly TaskWithdrawn: Moved;
}

/**
 * The keys of a payload that hold a hash of a fact's text. Redacting a fact takes them out of
 * every event about it, so an event read back may lack them.
 */
export const EVENT_HASH_KEYS = ["contentHash", "claimHash", "before", "after", "taken"] as const;

type Redactable<P> = Omit<P, (typeof EVENT_HASH_KEYS)[number]> &
  Partial<Pick<P, Extract<keyof P, (typeof EVENT_HASH_KEYS)[number]>>>;

/**
 * An event to append in a unit; the unit gives it the next sequence of its audience. Its payload
 * is the kind's (`EventPayloads`) when it is made by `eventBy` or `eventOf`.
 */
export interface EventDraft {
  readonly kind: EventKind;
  readonly subject: string;
  readonly actor: Actor;
  readonly session: string | null;
  /** Ids, codes and hashes only. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** An event as its log holds it, one kind at a time: its payload is its kind's, less any hash a redaction took. */
export type StoredEvent<K extends EventKind = EventKind> = {
  readonly [P in K]: Omit<EventDraft, "kind" | "payload"> & {
    readonly kind: P;
    readonly payload: Redactable<EventPayloads[P]>;
    readonly orgId: string;
    readonly audienceId: string;
    readonly seq: number;
    readonly at: Date;
  };
}[K];

export const JOB_KINDS = ["embed", "consolidate", "digest"] as const;

/**
 * The jobs a worker runs. `embed` and `consolidate` are about a fact and are left by the unit
 * that wrote it. `digest` is about a session: a model's reading of it once it is over, on a
 * server that has a model.
 */
export type JobKind = (typeof JOB_KINDS)[number];

/** A follow-up job as a unit enqueues it, about a fact of the unit's audience. */
export interface JobDraft {
  readonly id: string;
  readonly kind: Exclude<JobKind, "digest">;
  /** The fact the job is about. */
  readonly subject: string;
  readonly runAfter: Date;
}

/** A job a worker has claimed. */
export interface ClaimedJob {
  readonly orgId: string;
  readonly id: string;
  readonly kind: JobKind;
  /** The fact the job is about, or for `digest` the session. */
  readonly subject: string;
  /** The audience of the job's fact; null for a job about a session, which has none. */
  readonly audienceId: string | null;
  /** When it was due, as the claim found it: a job armed again while it runs has a later time. */
  readonly runAfter: Date;
  /** How many times it has been claimed, this claim included. */
  readonly attempts: number;
}

/** What identifies an inferred session: who, from which client, in which conversation and project. */
export interface SessionKey {
  readonly orgId: string;
  readonly principalId: string;
  readonly clientName: string;
  /** The client's own conversation id where it sends one, else the id of the connection the server followed the call on, where it did. */
  readonly conversationId: string | null;
  /** The project's canonical key; null for calls refused for a missing or malformed project. */
  readonly project: string | null;
}

/** One run of an agent in one project, inferred by the server. No call passes a session. */
export interface Session extends SessionKey {
  readonly id: string;
  /** The short id results show, for example `s-7f2c`. */
  readonly displayId: string;
  readonly clientVersion: string | null;
  readonly firstCallAt: Date;
  readonly lastCallAt: Date;
  readonly lastSearchAt: Date | null;
  readonly lastPublishAt: Date | null;
  readonly refusedCalls: number;
  /** How many accepted calls it has made. */
  readonly calls: number;
  /** When a result carried the session's brief; null until one has. */
  readonly briefedAt: Date | null;
  /** The session's one note, if it has left one: a later note replaces an earlier. */
  readonly note: SessionNote | null;
  /** When a model last finished reading what the session left; null until one has. */
  readonly digestedAt: Date | null;
  /** The tokens every model call about the session took in and gave out, added up. */
  readonly modelTokens: ModelTokens;
  /** The last reading that failed and has not been followed by one that finished: when, and the provider's reason, without any key. */
  readonly digestFailure: DigestFailure | null;
}

/** A model's reading of a session that failed. */
export interface DigestFailure {
  readonly at: Date;
  readonly reason: string;
}

/** What model calls cost, in the provider's own count of tokens. */
export interface ModelTokens {
  readonly input: number;
  readonly output: number;
}

/**
 * Where a session stands, in the agent's own last words, scanned like any write. A final note is
 * the session's last word and ends it; any other is a note at a checkpoint, and the session goes on.
 */
export interface SessionNote {
  /** Empty for a session that ended having made calls and finished no turn: it closed without a word. */
  readonly text: string;
  readonly final: boolean;
  readonly at: Date;
}

/**
 * What a call does to its session's record: stamps its last search or its last publish of a fact,
 * counts a call refused for its project, or (`other`) only counts the call.
 */
export type SessionMark = "search" | "publish" | "other" | "refused";

/** Activity for one client name and version: how many sessions did what. */
export interface ActivityRow {
  readonly clientName: string;
  readonly clientVersion: string | null;
  readonly sessions: number;
  readonly searched: number;
  readonly published: number;
  readonly refused: number;
}

/**
 * Who ran the step a job's act came from: a rule, or a model at the endpoint the server's operator
 * configured.
 */
export type RunnerKind = "rules" | "endpoint";

/**
 * One turn of a session as its harness's hook sent it: what the person asked and the agent's final
 * answer, each scanned like any write. Only the model step reads a turn, once, and it is deleted
 * when it has been read.
 */
export interface Turn {
  readonly id: string;
  readonly request: string | null;
  readonly answer: string | null;
  readonly at: Date;
}

/**
 * A task's lease. It is held by its token, never by a session: `claim_task` returns the token
 * and a later write passes it back. Only the token's SHA-256 is stored.
 */
export interface TaskLease {
  /** SHA-256 of the fencing token, in hex. */
  readonly tokenHash: string;
  /** The person whose session took the lease. */
  readonly holder: string;
  /** The session that took it, for display only; a write is never checked against it. */
  readonly session: string;
  readonly expiresAt: Date;
}

/** A unit of work published to one audience and held by one lease at a time. */
export interface Task {
  readonly orgId: string;
  readonly id: string;
  readonly audienceId: string;
  /** The canonical key of the project the task belongs to. */
  readonly project: string;
  readonly title: string;
  readonly description: string | null;
  readonly state: TaskState;
  /** Bumped by every change. A write names the version it changes; a stale one is refused. */
  readonly version: number;
  /** A step of an agent's own plan: always private to the person. */
  readonly tracked: boolean;
  /** The person whose agent published it. */
  readonly publisher: string;
  /**
   * Null unless the task is claimed. A lease that ran out stays here until the task is claimed
   * again: whether it still holds is judged against the clock, never stored.
   */
  readonly lease: TaskLease | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A note on a task: progress at a checkpoint, or the handoff note of a release. */
export interface TaskNote {
  readonly orgId: string;
  readonly taskId: string;
  readonly id: string;
  readonly kind: NoteView["kind"];
  readonly author: string;
  /** The session it was written in: where its client's name is read from. */
  readonly session: string;
  readonly text: string;
  readonly at: Date;
}
