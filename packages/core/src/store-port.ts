/**
 * The Store port: the only way core reaches persistence. One adapter implements it for embedded
 * PostgreSQL and a server PostgreSQL alike.
 *
 * Rules every adapter keeps:
 * - A write to facts, their review records, events or jobs happens inside `unit`, which is one
 *   transaction opened on one audience: it locks the audience's head row, runs the callback, gives
 *   each appended event the next sequence, advances the head and commits. A callback that throws
 *   rolls everything back. The callback does nothing but call the unit: no model call, no network.
 *   A call from inside it to the store around it, a repository outside the unit or a second
 *   unit, is refused with an error: on one connection it would wait for itself forever.
 * - A person's write opens its unit on that person's own audience, whose head row is therefore
 *   the lock of everything that is theirs to decide: their choice for a project, and where their
 *   records are. From there the unit may reach the shared audience (`on`), whose head it locks
 *   second. No unit takes the two in the other order, or reaches another person's audience.
 * - A record changes audience only through a unit's `move`, with everything that hangs off it.
 *   The log does not: an entry stays in the log it was written in.
 * - Every read takes the reader's scope (organization and visible audiences) and returns nothing
 *   outside it. A record outside the scope reads as absent, never as forbidden.
 * - Directory records (principals, credentials, audiences, projects, sessions) are never joined
 *   with facts; the visible set is resolved first and passed in.
 */
import type {
  ActivityRow,
  Caller,
  ClaimedJob,
  Confirmation,
  Credential,
  CredentialKind,
  EventDraft,
  EventKind,
  Fact,
  FactContent,
  Flag,
  FlagKind,
  JobDraft,
  DigestFailure,
  ModelTokens,
  Person,
  PersonProject,
  Project,
  ProjectRef,
  ReadScope,
  Ruling,
  Session,
  SessionKey,
  SessionMark,
  SessionNote,
  StoredEvent,
  Task,
  TaskLease,
  TaskNote,
  TaskState,
  Treatment,
  Turn,
} from "./domain.ts";
import type { ModelVector } from "./ports.ts";
import type { SearchRepo } from "./search-port.ts";

/** The audience a unit writes in, and the instant it happens at. */
export interface UnitTarget {
  readonly orgId: string;
  readonly audienceId: string;
  /** The clock's reading for this write: every row the unit stamps carries it. */
  readonly at: Date;
}

/** A fact as a unit inserts it. */
export interface NewFact {
  readonly id: string;
  readonly project: string;
  readonly author: string;
  readonly content: FactContent;
  /** The fact's vector when the call made one; null leaves it to the embed job. */
  readonly vector: ModelVector | null;
  /** The session a model wrote the fact from. Left out for a fact an agent published. */
  readonly digestSession?: string;
}

/**
 * What a correction does to the fact's stored vector: a new vector replaces it; `kept` leaves it,
 * because what a vector is made from did not change; null clears it for the embed job.
 */
export type VectorChange = ModelVector | "kept" | null;

/** A flag as a unit raises it. */
export type NewFlag = Pick<Flag, "id" | "factId" | "kind" | "raisedBy">;

/** A ruling as a unit records it. */
export type NewRuling = Omit<Ruling, "orgId" | "audienceId" | "revertedBy" | "at">;

/** The records a move takes, and the two audiences of the organization it runs between. */
export interface Move {
  readonly from: string;
  readonly to: string;
  /** Facts by id. Each goes with every fact superseded by it, directly or through others. */
  readonly facts: readonly string[];
  readonly tasks: readonly string[];
}

/** Facts inside a unit: every method works in the unit's audience and sees the unit's own writes. */
export interface UnitFacts {
  get(id: string): Promise<Fact | null>;
  /** The facts found among `ids`, in no particular order. */
  getMany(ids: readonly string[]): Promise<Fact[]>;
  /** Every fact one person wrote in a project that this audience holds: live, superseded and stubs. */
  writtenBy(author: string, project: string): Promise<Fact[]>;
  /** The facts superseded by a fact, directly or through others: the chain behind it. */
  behind(id: string): Promise<Fact[]>;
  /**
   * Every log entry that records the fact's being merged into another, newest first, in whichever
   * log it was written and however many entries came after it: where a merge's survivor, and what
   * it took, are read from, inside the unit that acts on them. None for a fact this audience does
   * not hold.
   */
  merges(id: string): Promise<StoredEvent<"FactSuperseded">[]>;
  /** The author's live fact in this project with this normalized-claim hash, if any: how a repeated publish is found. */
  findByClaimHash(author: string, project: string, claimHash: string): Promise<Fact | null>;
  /** Inserts the fact as `unconfirmed`, with its search columns, its identifiers and the facts it cites. */
  insert(fact: NewFact): Promise<void>;
  /**
   * The author's correction: replaces text, citations, hashes, identifiers and cited facts. A fact
   * a model wrote is its author's own words from then on. Throws when the unit's audience holds no
   * such fact.
   */
  rewrite(id: string, content: FactContent, vector: VectorChange): Promise<void>;
  /**
   * Replaces the fact's citations, the facts they name and its content hash, and clears its
   * vector, which was made from them; its text stays. Throws when the unit's audience holds no
   * such fact.
   */
  setCitations(id: string, change: CitationsChange): Promise<void>;
  /**
   * Takes the given hashes out of what the fact's merge events say its survivor took from it, in
   * whichever log they were written: a survivor that gives a citation back is no longer on record
   * as holding its hash. Nothing is touched for a fact the unit's audience does not hold.
   */
  forgetTaken(id: string, hashes: readonly string[]): Promise<void>;
  /**
   * Makes `id` superseded by `by`, a live fact of the audience other than itself; anything else
   * throws. The link is written here once and never rewritten: a chain grows at its head.
   */
  supersede(id: string, by: string): Promise<void>;
  /** Makes the fact `confirmed` or `unconfirmed`. */
  setStatus(id: string, status: "confirmed" | "unconfirmed"): Promise<void>;
  /** Undoes a supersession: the fact is live again with `status`. The facts it superseded still name it. */
  restore(id: string, status: "confirmed" | "unconfirmed"): Promise<void>;
  /** The live fact at the head of each superseded fact's chain, by that fact's id. A fact that is not superseded has no entry. */
  heads(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /**
   * Takes the text of the fact, and of every fact superseded by it, directly or through others,
   * out of every structure that holds it: the row with its search columns, vector and hashes,
   * identifiers, cited facts, confirmations, pending jobs, and the hashes in its events, in every
   * log that holds one. Each leaves a stub that keeps when it was redacted. Returns the ids redacted.
   */
  redact(id: string): Promise<string[]>;
  /** The ids of the live facts in this audience that cite the fact. */
  citing(id: string): Promise<string[]>;
}

/** A fact's citations as a unit replaces them: with the facts they name and the hash that follows. */
export type CitationsChange = Pick<FactContent, "citations" | "citedFacts" | "contentHash">;

/** Confirmations, flags and rulings inside a unit. */
export interface UnitReview {
  /** Records one person's check. One row per person and fact: a repeat refreshes it. */
  confirm(confirmation: Omit<Confirmation, "orgId" | "audienceId">): Promise<void>;
  /** Deletes every confirmation of the fact but `exceptPerson`'s; returns how many went. */
  clearConfirmations(factId: string, exceptPerson: string): Promise<number>;
  /** Raises a flag. False when the same raiser already holds an open flag of this kind on the fact. */
  raiseFlag(flag: NewFlag): Promise<boolean>;
  /** Clears the fact's open flags of the given kinds; returns how many it cleared. */
  clearFlags(factId: string, kinds: readonly FlagKind[]): Promise<number>;
  record(ruling: NewRuling): Promise<void>;
  /** Marks `rulingId` as undone by `by`. False when it does not exist or was already reverted. */
  revert(rulingId: string, by: string): Promise<boolean>;
}

/** A task as a unit inserts it: open and at version 1, or claimed when it comes with a lease. */
export type NewTask = Pick<
  Task,
  "id" | "project" | "title" | "description" | "tracked" | "publisher" | "lease"
>;

/** What a write changes on a task. A field left out stays as it is. */
export interface TaskChange {
  readonly state?: TaskState;
  /** A new lease, or null to free the lease. */
  readonly lease?: TaskLease | null;
}

/** Tasks inside a unit: every method works in the unit's audience and sees the unit's own writes. */
export interface UnitTasks {
  get(id: string): Promise<Task | null>;
  /** Every task one person published in a project that this audience holds. */
  publishedBy(publisher: string, project: string): Promise<Task[]>;
  /** The publisher's task of this title in this project that is not done, if any: how a repeated publish is found. */
  findOpenByTitle(publisher: string, project: string, title: string): Promise<Task | null>;
  insert(task: NewTask): Promise<void>;
  /**
   * Applies a change only while the task is still at `version`, and bumps the version. Returns the
   * task as it now stands, or null when the version was stale and nothing changed.
   */
  change(id: string, version: number, change: TaskChange): Promise<Task | null>;
  /**
   * Moves the end of the lease the task holds. A renewal is not a change: the version and the
   * time of the last change stay. Returns the task, or null when it holds no lease.
   */
  renew(id: string, expiresAt: Date): Promise<Task | null>;
  /** Adds a note. It does not bump the task's version. */
  addNote(note: Omit<TaskNote, "orgId" | "at">): Promise<void>;
  /** The task's newest note, if it has one: how a repeated note or handoff is recognised. */
  lastNote(taskId: string): Promise<TaskNote | null>;
}

/** What a unit writes in one audience: every method works in that audience and sees the unit's own writes. */
export interface UnitWrites {
  readonly audienceId: string;
  readonly facts: UnitFacts;
  readonly review: UnitReview;
  readonly tasks: UnitTasks;
  /** Appends an event to the audience's log and returns the sequence it took. */
  append(event: EventDraft): Promise<number>;
  /** Leaves a follow-up job about a fact of the audience; it commits with the unit. */
  enqueue(job: JobDraft): Promise<void>;
}

/** One state unit: the writes in the audience it was opened on, and what reaches beyond it. */
export interface Unit extends UnitWrites {
  /**
   * The same unit's writes in the organization's shared audience, whose head is locked now, after
   * the unit's own. Only a unit opened on a person's own audience may ask: any other is refused,
   * so that no two units ever wait for each other's head.
   */
  on(sharedAudienceId: string): Promise<UnitWrites>;
  /**
   * How the person whose audience the unit is open on treats a project, as it stands inside the
   * unit; null while they have made no choice. Their head row is held, so it cannot change
   * before the unit ends.
   */
  choice(project: string): Promise<Treatment | null>;
  /** Records that person's choice for a project; it commits, or not, with everything else the unit does. */
  choose(project: string, treatment: Treatment): Promise<void>;
  /**
   * Moves records between the unit's audience and the shared one, each with everything that
   * hangs off it: a fact with the facts superseded by it, its confirmations, flags, rulings and
   * pending jobs; a task with its notes. What the logs hold about them stays where it was
   * written. Returns the ids that moved, the facts behind a given fact among them; a record
   * `from` does not hold is left out.
   */
  move(move: Move): Promise<{ facts: string[]; tasks: string[] }>;
}

/** A page of facts for the dashboard and the export, newest first. Stubs are among them: a caller that shows only text leaves them out. */
export interface FactListQuery {
  readonly project?: string;
  /** Returns facts strictly older than this position: the last fact of the page before. */
  readonly before?: { readonly updatedAt: Date; readonly id: string };
  /** Only live facts whose every citation is a person's word (`kind` person): what the person told an agent. */
  readonly citedOnlyToPerson?: boolean;
  readonly limit: number;
}

/** Facts outside a unit. */
export interface FactsRepo {
  get(scope: ReadScope, id: string): Promise<Fact | null>;
  /** The facts found among `ids`, in no particular order. */
  getMany(scope: ReadScope, ids: readonly string[]): Promise<Fact[]>;
  /** The live fact at the head of each superseded fact's chain, by that fact's id. A fact that is not superseded has no entry. */
  heads(scope: ReadScope, ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** The facts superseded by a fact, directly or through others, that the scope holds: the chain behind it. */
  behind(scope: ReadScope, id: string): Promise<Fact[]>;
  list(scope: ReadScope, query: FactListQuery): Promise<Fact[]>;
  /** How many live facts a project holds in the reader's scope. */
  count(scope: ReadScope, project: string): Promise<number>;
  /**
   * Stores the claim's vector, only while the fact's content hash is still `contentHash` and the
   * store's recorded model is the vector's: a server of another model, still running beside this
   * one, stores nothing. Takes no audience lock and writes no event. False when the fact changed or
   * is gone, or the model is not the store's.
   */
  setVector(orgId: string, id: string, contentHash: string, vector: ModelVector): Promise<boolean>;
}

/** Which tasks a listing returns. */
export interface TaskListQuery {
  /** Only tasks of this project; absent means every project. */
  readonly project?: string;
  /** Only tasks in these states; absent means every state. */
  readonly states?: readonly TaskState[];
  /** Only tasks this person published or holds. */
  readonly person?: string;
  readonly limit: number;
}

/** One step of a task's life as the audience's log holds it: ids and codes, never text. */
export type TaskStep = {
  [K in EventKind]: Pick<StoredEvent<K>, "seq" | "at" | "kind" | "actor" | "session" | "payload">;
}[EventKind];

/** Tasks outside a unit. Whether a lease has expired is the reader's to judge against the clock. */
export interface TasksRepo {
  get(scope: ReadScope, id: string): Promise<Task | null>;
  /** Tasks most recently changed first. */
  list(scope: ReadScope, query: TaskListQuery): Promise<Task[]>;
  /** How many tasks a listing without a limit would return. */
  count(scope: ReadScope, query: Omit<TaskListQuery, "limit">): Promise<number>;
  /** The notes of the given tasks, oldest first. */
  notes(scope: ReadScope, taskIds: readonly string[]): Promise<TaskNote[]>;
  /** The newest note of each of the given tasks that has one: what a list and the brief show. */
  latestNotes(scope: ReadScope, taskIds: readonly string[]): Promise<TaskNote[]>;
  /** Everything the logs the reader may see hold about one task, oldest first: its publishing, claims, notes, releases and completion. */
  history(scope: ReadScope, taskId: string): Promise<TaskStep[]>;
}

/** Confirmations, flags and rulings outside a unit. */
export interface ReviewRepo {
  confirmations(scope: ReadScope, factIds: readonly string[]): Promise<Confirmation[]>;
  openFlags(scope: ReadScope, factIds: readonly string[]): Promise<Flag[]>;
  /** Rulings newest first, for Activity: by when they were made, then in the order they were recorded. */
  rulings(scope: ReadScope, limit: number): Promise<Ruling[]>;
  ruling(scope: ReadScope, id: string): Promise<Ruling | null>;
  /** Every ruling about the given facts, reverted or not. */
  rulingsOf(scope: ReadScope, factIds: readonly string[]): Promise<Ruling[]>;
  /** Events after `afterSeq` in one audience, oldest first. */
  events(
    scope: ReadScope,
    audienceId: string,
    afterSeq: number,
    limit: number,
  ): Promise<StoredEvent[]>;
  /**
   * What the logs the reader may see hold about one record, newest first: for a fact, its
   * publishing, corrections and checks. A record that moved has entries in two logs.
   */
  history(scope: ReadScope, subject: string, limit: number): Promise<StoredEvent[]>;
  /**
   * The ids of the facts published in one session, oldest first, as the logs the reader may see
   * record it: by an agent's call in that session, or by a model that read it.
   */
  publishedIn(scope: ReadScope, sessionId: string): Promise<string[]>;
}

/**
 * The outbox as a worker sees it. Claiming work crosses organizations by nature. A unit leaves the
 * jobs about its facts (`UnitWrites.enqueue`); the job about a session is armed here, since a
 * session is written outside any unit.
 */
/** What the outbox holds: jobs that will run, jobs given up, the embeddings among those, and the readings that failed with the provider's reason. */
export interface JobCounts {
  readonly waiting: number;
  readonly dead: number;
  /** Of the dead, those given up in the last 24 hours: what a person is told of, once. */
  readonly deadRecent: number;
  readonly deadEmbeds: number;
  /** Readings that wait now because the provider failed or refused the call: a session with a failure kept and a reading due. */
  readonly readingsWaiting: number;
  /** Readings given up in the last 24 hours after the provider's failure or an answer that could not be read. */
  readonly readingsGivenUp: number;
  /** The provider's words for the latest failure of those readings, without any key; null when there is none. */
  readonly lastReadingFailure: string | null;
}

export interface JobsRepo {
  /** Claims up to `limit` due jobs until `now + leaseMs`, oldest first. No other claim takes them meanwhile. */
  claim(now: Date, leaseMs: number, limit: number): Promise<ClaimedJob[]>;
  /**
   * Retires a finished job. One that was armed again while it ran (its time is no longer the one
   * the claim found) stays, free to be claimed at its new time.
   */
  complete(job: Pick<ClaimedJob, "orgId" | "id" | "runAfter">): Promise<void>;
  /** Releases a failed job to run again at `retryAt`, or marks it dead when `retryAt` is null. */
  fail(job: Pick<ClaimedJob, "orgId" | "id">, retryAt: Date | null): Promise<void>;
  /** How many jobs wait and how many are dead, for the health route. */
  counts(): Promise<JobCounts>;
  /**
   * Makes the store's vectors those of the embedder whose id is `model`: when the store's vectors
   * were made under another id (or under none that it records) they are all set to null and `model`
   * is recorded, in one statement, and no search scores a vector of another model meanwhile. Then
   * leaves an `embed` job, due at `now`, for every live fact that has no vector and no embed job
   * that will still run: what a host owes the facts published while it had no model, those whose
   * job died, and every fact after a change of model. The job takes its fact's id. Returns how
   * many it left or brought back.
   */
  embedMissing(model: string, now: Date): Promise<number>;
  /** The id of the model that made the store's vectors, or null while no model has taken the store. */
  embeddingModel(): Promise<string | null>;
  /**
   * Leaves the one `digest` job of a session, due at `dueAt`, or moves it there when the session
   * has one already, sooner or later: a session's reading waits for the last thing the session
   * leaves. The job takes its session's id. A job that had failed starts its attempts from none.
   */
  armDigest(orgId: string, sessionId: string, dueAt: Date): Promise<void>;
  /** Makes a session's `digest` job due at `now` if it waits for a later time; none is left where none waits. */
  hastenDigest(orgId: string, sessionId: string, now: Date): Promise<void>;
}

/** Inferred sessions, each with its note. A session write takes no audience lock and writes no event. */
export interface SessionsRepo {
  /** The session with this key whose last call is the most recent. Whether it is still open is the reader's to judge. */
  latestOf(key: SessionKey): Promise<Session | null>;
  open(session: Session): Promise<void>;
  /**
   * Stamps the session's last call, and its last search or publish, or counts a refused call. A
   * session that began before its client's version was known takes `version` where it is given.
   */
  touch(
    orgId: string,
    id: string,
    at: Date,
    mark: SessionMark,
    version: string | null,
  ): Promise<void>;
  /**
   * One person's sessions whose last call is at or after `since`, counted per client name and
   * version. A session that only began (no call, none refused, no note) is not counted.
   */
  activity(orgId: string, principalId: string, since: Date): Promise<ActivityRow[]>;
  /** Records that a result carries the session's brief (`at`), or that it did not after all (null). */
  setBriefed(orgId: string, id: string, at: Date | null): Promise<void>;
  /** Sets the session's note; the note it had is replaced. */
  setNote(orgId: string, id: string, note: SessionNote): Promise<void>;
  /** The person's session in a project with the most recent call. */
  latest(orgId: string, principalId: string, project: string): Promise<Session | null>;
  /**
   * The person's session in a project before `session`, as a brief tells of it: of those that
   * made a call or left a note, the one heard from last, by its last call or its note, whichever
   * is later. A session that only began says nothing of how work stands, and is passed over.
   */
  previous(
    orgId: string,
    principalId: string,
    project: string,
    session: string,
  ): Promise<Session | null>;
  /**
   * The session of a client's conversation with the most recent call, whichever project it is in:
   * where a note is left by a hook that cannot name the project. A session without a project is
   * not one.
   */
  latestIn(
    orgId: string,
    principalId: string,
    clientName: string,
    conversationId: string,
  ): Promise<Session | null>;
  /** The person's sessions, most recent call first, those that only began left out. */
  recent(orgId: string, principalId: string, limit: number): Promise<Session[]>;
  /** The sessions found among `ids`: where a task's lease, note or step reads its client's name. */
  byIds(orgId: string, ids: readonly string[]): Promise<Session[]>;
  /** Keeps a turn of a session until the model step has read it, or drops it where the session already holds `MOST_TURNS_KEPT`. */
  addTurn(orgId: string, sessionId: string, turn: Turn): Promise<void>;
  /**
   * Keeps the agent's final answer of a turn: on the session's newest turn that has a request and
   * no answer yet, or, where there is none, as a turn of its own with `id`. A turn's hook sends
   * the request when the turn begins and the answer when it ends.
   */
  answerTurn(
    orgId: string,
    sessionId: string,
    answered: { id: string; answer: string; at: Date },
  ): Promise<void>;
  /** The session's turns that wait to be read, oldest first. */
  turns(orgId: string, sessionId: string): Promise<Turn[]>;
  /** Deletes every turn the session has waiting: what a reading that is given up could not read. */
  dropTurns(orgId: string, sessionId: string): Promise<void>;
  /**
   * Records that a model finished reading the session, in one step: the turns it read are
   * deleted, the session is stamped as read at `at`, and the facts it chose for the person's next
   * brief in the project replace an earlier choice when it made one. A failure recorded before is cleared.
   */
  digested(
    orgId: string,
    id: string,
    read: { at: Date; turns: readonly string[]; picks?: readonly string[] },
  ): Promise<void>;
  /**
   * Records that a model's reading of the session failed, with the latest reason. The time kept is that of the first
   * failure since a reading last finished, which the next finished reading clears.
   */
  digestFailed(orgId: string, id: string, failure: DigestFailure): Promise<void>;
  /** Adds what model calls about the session cost, made at `at`, to what it has cost so far and to the server's account. */
  spent(orgId: string, id: string, tokens: ModelTokens, at: Date): Promise<void>;
  /** What model calls have cost, input and output together, since `since`, across everyone the server serves. */
  spentSince(since: Date): Promise<number>;
  /**
   * Whether the session has a turn that was asked after `since` and has no answer yet: the agent
   * is working on it, and what it will say is not there to be read.
   */
  runningTurn(orgId: string, sessionId: string, since: Date): Promise<boolean>;
  /**
   * The facts chosen for a person's next brief in a project, in order: the choice of the reading
   * that finished last among their sessions there. None when no reading has chosen.
   */
  picks(orgId: string, principalId: string, project: string): Promise<string[]>;
}

/** An organization's projects, and each person's choice for the ones they work in. */
export interface ProjectsRepo {
  find(orgId: string, key: string): Promise<Project | null>;
  /** The project with this key, created if it does not exist yet. */
  ensure(orgId: string, ref: ProjectRef): Promise<Project>;
  /**
   * The projects one person works in, by key: those a session of theirs made a call in or left a
   * note in, and those they made a choice for. A project where a session only began is not one
   * yet. Another person's projects are not among them.
   */
  listOf(orgId: string, principalId: string): Promise<PersonProject[]>;
  /** The person's choice for a project; null while they have made none. */
  choice(orgId: string, principalId: string, project: string): Promise<Treatment | null>;
  /**
   * Records the person's choice for a project; the one before it is replaced. `displayName`,
   * when given, becomes their name for the project; left out, the name they gave stays.
   */
  choose(
    orgId: string,
    principalId: string,
    project: string,
    treatment: Treatment,
    displayName?: string,
  ): Promise<void>;
}

/** The ids a new principal takes if `ensurePrincipal` has to create it. */
export interface PrincipalSeed {
  /** What identifies the principal to its identity provider. The local owner's is `local:owner`. */
  readonly subject: string;
  readonly displayName: string;
  /** The organization it joins: a new id for the first person of a host, the host's own for the rest. */
  readonly orgId: string;
  readonly principalId: string;
  readonly audienceId: string;
}

/** A credential to store: its record as made, and the SHA-256 of its token, in hex. */
export interface NewCredential extends Omit<Credential, "lastUsedAt" | "revokedAt"> {
  readonly tokenHash: string;
}

/** Principals, their credentials and their audiences. */
export interface DirectoryRepo {
  /**
   * The caller for a subject. A subject seen for the first time becomes a principal of the seed's
   * organization, with a private audience and its head row, created together from the seed's ids.
   */
  ensurePrincipal(seed: PrincipalSeed): Promise<Caller>;
  /**
   * Adds a person to an organization that has people: their principal and private audience, their
   * credentials, and the organization's shared audience, made with `sharedAudienceId` and its head
   * row if there is none yet. All of it is one transaction: a failure leaves no person behind who
   * has no credential, or whose organization has nothing to share in. From then on every caller of
   * the organization sees the shared audience.
   */
  addPerson(
    seed: PrincipalSeed,
    sharedAudienceId: string,
    credentials: readonly NewCredential[],
  ): Promise<void>;
  /** The organization's people, in the order they were added. */
  people(orgId: string): Promise<Person[]>;
  rename(orgId: string, principalId: string, displayName: string): Promise<void>;
  /**
   * The caller a live secret's hash belongs to, when it is a credential of this kind, with the
   * credential stamped as used at `usedAt` (at most once a minute). Looks across organizations:
   * the credential names its own.
   */
  callerByTokenHash(tokenHash: string, kind: CredentialKind, usedAt: Date): Promise<Caller | null>;
  /** A person of the organization as a caller the host itself vouches for, signed in with no credential. */
  callerOf(orgId: string, principalId: string): Promise<Caller | null>;
  /** The caller a credential belongs to as they stand now; null once it is revoked or gone. */
  callerOfCredential(orgId: string, credentialId: string): Promise<Caller | null>;
  /** The credential a token's hash belongs to, live or revoked, in whichever organization; null when none has it. */
  credentialByTokenHash(tokenHash: string): Promise<Credential | null>;
  addCredential(credential: NewCredential): Promise<void>;
  credentials(orgId: string, principalId: string): Promise<Credential[]>;
  /**
   * Ends every live agent credential of a person and stores `credential` in their place, as one
   * step that no other replacement of theirs interleaves with: afterwards exactly one of their
   * agent credentials is live. Returns how many it ended.
   */
  replaceAgentCredentials(credential: NewCredential, at: Date): Promise<number>;
  /** False when the organization has no such live credential. */
  revokeCredential(orgId: string, id: string, at: Date): Promise<boolean>;
  /** Display names by principal id; an unknown id has none. */
  names(orgId: string, principalIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

/** The store. */
export interface Store {
  /** Runs one state unit on one audience and returns what the callback returned. */
  unit<T>(target: UnitTarget, fn: (unit: Unit) => Promise<T>): Promise<T>;
  readonly facts: FactsRepo;
  readonly search: SearchRepo;
  readonly review: ReviewRepo;
  readonly tasks: TasksRepo;
  readonly jobs: JobsRepo;
  readonly sessions: SessionsRepo;
  readonly projects: ProjectsRepo;
  readonly directory: DirectoryRepo;
  /** Releases the engine and its data directory. */
  close(): Promise<void>;
}
