/**
 * The tables as the query builder sees them, in the domain's names (`connect` in `codec.ts`
 * renames). The DDL is the migration; this file is its types and nothing else. A column that
 * holds a code is typed with the code's own list. uuid columns are strings, timestamptz columns
 * are `Date`s, bytea columns are bytes, jsonb is written as JSON text and read parsed, int8 is
 * read as a number.
 */
import type {
  AUDIENCE_KINDS,
  ClassedCitation,
  CredentialKind,
  EventKind,
  FlagKind,
  JobKind,
  ProjectRef,
  RulingDecision,
  Status,
  TaskNote,
  TaskState,
  Treatment,
} from "@uketsugi/core";
import type { ColumnType, Generated, GeneratedAlways } from "kysely";

type Json<T> = ColumnType<T, string, string>;
type Bytes = Uint8Array;

export interface Database {
  principals: { orgId: string; id: string; displayName: string; subject: string };
  credentials: {
    orgId: string;
    id: string;
    principalId: string;
    kind: CredentialKind;
    label: string;
    tokenHash: Bytes;
    createdAt: Date;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
  };
  audiences: {
    orgId: string;
    id: string;
    kind: (typeof AUDIENCE_KINDS)[number];
    ownerId: string | null;
  };
  audienceHead: { orgId: string; audienceId: string; lastSeq: number };
  projects: {
    orgId: string;
    key: string;
    kind: ProjectRef["kind"];
    createdAt: Date;
  };
  projectChoices: {
    orgId: string;
    principalId: string;
    project: string;
    treatment: Treatment;
    displayName: string | null;
  };
  sessions: {
    orgId: string;
    id: string;
    principalId: string;
    displayId: string;
    clientName: string;
    clientVersion: string | null;
    conversationId: string | null;
    project: string | null;
    firstCallAt: Date;
    lastCallAt: Date;
    lastSearchAt: Date | null;
    lastPublishAt: Date | null;
    refusedCalls: number;
    calls: number;
    briefedAt: Date | null;
    noteText: string | null;
    noteFinal: boolean | null;
    noteAt: Date | null;
    digestedAt: Date | null;
    modelInputTokens: Generated<number>;
    modelOutputTokens: Generated<number>;
    digestFailedAt: Date | null;
    digestFailure: string | null;
    briefPicks: ColumnType<string[] | null, string | null, string | null>;
  };
  modelSpend: {
    orgId: string;
    at: Date;
    tokens: number;
  };
  sessionTurns: {
    orgId: string;
    sessionId: string;
    id: string;
    request: string | null;
    answer: string | null;
    at: Date;
  };
  facts: {
    orgId: string;
    id: string;
    audienceId: string;
    project: string;
    claim: string | null;
    detail: string | null;
    question: string | null;
    citations: ColumnType<ClassedCitation[] | null, string | null, string | null>;
    status: Status;
    author: string;
    contentHash: Bytes;
    claimHash: Bytes;
    supersededBy: string | null;
    /** A halfvec, written in its text form `[1,2,…]`. */
    vector: string | null;
    createdAt: Date;
    updatedAt: Date;
    redactedAt: Date | null;
    digestSession: string | null;
    searchText: GeneratedAlways<string>;
    tsv: GeneratedAlways<string>;
  };
  factIdents: { orgId: string; factId: string; ident: string };
  citedFacts: { orgId: string; factId: string; citedFact: string };
  confirmations: {
    orgId: string;
    factId: string;
    person: string;
    audienceId: string;
    at: Date;
    sourceVersion: string | null;
    checked: string | null;
  };
  flags: {
    orgId: string;
    id: string;
    audienceId: string;
    factId: string;
    kind: FlagKind;
    raisedByPerson: string | null;
    raisedByJob: string | null;
    at: Date;
    clearedAt: Date | null;
  };
  events: {
    orgId: string;
    audienceId: string;
    seq: number;
    at: Date;
    actorPerson: string | null;
    actorJob: string | null;
    session: string | null;
    kind: EventKind;
    subject: string;
    payload: Json<Record<string, unknown>>;
  };
  rulings: {
    orgId: string;
    id: string;
    audienceId: string;
    decision: RulingDecision;
    factId: string;
    decidedByPerson: string | null;
    decidedByJob: string | null;
    reasons: Json<string[]>;
    revertedBy: string | null;
    at: Date;
  };
  outbox: {
    orgId: string;
    id: string;
    /** Null for a job about a session, which has no audience. */
    audienceId: string | null;
    kind: JobKind;
    subject: string;
    runAfter: Date;
    attempts: Generated<number>;
    lockedUntil: Date | null;
    dead: Generated<boolean>;
  };
  tasks: {
    orgId: string;
    id: string;
    audienceId: string;
    project: string;
    title: string;
    description: string | null;
    state: TaskState;
    version: number;
    tracked: boolean;
    publisher: string;
    leaseTokenHash: Bytes | null;
    leaseHolder: string | null;
    leaseSession: string | null;
    leaseExpiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
  taskNotes: {
    orgId: string;
    taskId: string;
    id: string;
    audienceId: string;
    kind: TaskNote["kind"];
    author: string;
    session: string;
    text: string;
    at: Date;
  };
}
