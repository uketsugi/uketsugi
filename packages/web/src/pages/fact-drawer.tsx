/**
 * One fact, in a drawer beside the list: what it claims, where it comes from, who checked it, what
 * happened to it, and the one change a person makes here, Redact, behind a confirmation.
 */
import type {
  ApiConfirmation,
  ApiFact,
  Citation,
  FactDetail,
  FactHistoryEntry,
} from "@uketsugi/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState, type RefObject } from "react";
import { factQuery, redactFact, refreshFacts } from "../api.ts";
import { SeenByMark } from "../by-project.tsx";
import { Detail, Details, Lead, Section, SideDrawer } from "../drawer.tsx";
import { useSession } from "../shell.tsx";
import {
  Ago,
  Button,
  CitationMark,
  ConfirmDialog,
  ErrorPanel,
  FlagMarks,
  QueryState,
  sentence,
  StatusMark,
  TrustMark,
} from "../ui.tsx";

/** A reference a browser can open. Anything else is shown as text, never as a link. */
function isWebAddress(ref: string): boolean {
  return /^https?:\/\//.test(ref);
}

function Citations({ citations }: { citations: Citation[] }) {
  return (
    <Section title="Citations">
      <ul className="space-y-2">
        {citations.map((citation, index) => (
          <li
            key={`${index} ${citation.ref}`}
            className="space-y-1.5 rounded-md border border-line p-3"
          >
            <p className="font-mono text-[0.8125rem] break-all">
              {isWebAddress(citation.ref) ? (
                <a href={citation.ref} rel="noreferrer" className="rounded-sm underline">
                  {citation.ref}
                </a>
              ) : (
                citation.ref
              )}
            </p>
            <p className="flex flex-wrap items-center gap-2 text-ink-muted">
              {citation.kind}
              <CitationMark of={citation.class} reason={citation.reason} />
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * Who checked the fact. Only another person's check confirms it; its author's own refreshes it,
 * and is not called a confirmation beside a status that still reads "unconfirmed".
 */
function Checks({ confirmations }: { confirmations: ApiConfirmation[] }) {
  return (
    <Section title="Checks">
      {confirmations.length === 0 ? (
        <p className="text-ink-muted">Nobody has confirmed this fact yet.</p>
      ) : (
        <ul className="space-y-1">
          {confirmations.map((check) => (
            <li key={`${check.person} ${check.at}`}>
              {check.by_author ? "Checked" : "Confirmed"} by {check.person}, <Ago at={check.at} />
              {check.source_version === null ? "" : ` at ${check.source_version}`}
              {check.checked === null ? "" : `: ${check.checked}`}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function FactLink({ id }: { id: string }) {
  return (
    <Link
      to="/facts"
      search={(shown) => ({ ...shown, fact: id })}
      className="rounded-sm font-mono text-[0.8125rem] break-all underline"
    >
      {id}
    </Link>
  );
}

function Connections({ fact }: { fact: ApiFact }) {
  if (fact.superseded_by === null) return null;
  return (
    <Section title="Connections">
      <Details>
        <Detail term="Superseded by">
          <FactLink id={fact.superseded_by} />
        </Detail>
      </Details>
    </Section>
  );
}

/** An event's kind in words: `FactPublished` reads "Fact published". */
function eventInWords(kind: string): string {
  return sentence(kind.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());
}

function History({ entries }: { entries: FactHistoryEntry[] }) {
  return (
    <Section title="History">
      <ol className="space-y-1">
        {entries.map((entry, index) => (
          <li key={`${index} ${entry.at}`}>
            {eventInWords(entry.kind)} <span className="text-ink-muted">· {entry.actor} ·</span>{" "}
            <Ago at={entry.at} />
          </li>
        ))}
      </ol>
    </Section>
  );
}

/**
 * Where a redacted fact's text can outlast the redaction, said before it and on the fact after:
 * the store deletes the text from its tables and scrubs neither its own log nor a backup.
 */
const ON_DISK =
  "A copy can stay behind on disk: the database’s own files can still hold the text for a while, and so can a backup, even one made after the redaction. Uketsugi does not remove those copies.";

/**
 * The one change a person makes here. `live` is the fact this one was merged into, if it was: a
 * redaction takes this fact's text and leaves that fact's, which says the same.
 */
function Redact(props: { id: string; live: string | null; after: RefObject<HTMLElement | null> }) {
  const { id, live, after } = props;
  const session = useSession();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const done = useRef(false);
  const redact = useMutation({
    mutationFn: () => redactFact(id, session.csrf),
    onSuccess: async () => {
      done.current = true;
      setOpen(false);
      await refreshFacts(client);
    },
  });
  const change = (next: boolean) => {
    if (next) redact.reset();
    setOpen(next);
  };
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={change}
      trigger={<Button tone="danger" />}
      triggerText="Redact…"
      title="Redact this fact?"
      failure={redact.isError ? <ErrorPanel error={redact.error} /> : null}
      keep="Keep the fact"
      change={{
        text: "Redact the fact",
        tone: "destroy",
        disabled: redact.isPending,
        onClick: () => redact.mutate(),
      }}
      // Once the fact is redacted its button is gone, so the focus goes to the top of the drawer.
      finalFocus={() => (done.current ? after.current : true)}
    >
      Agents stop receiving its text, and it is gone at once from the dashboard, from search and
      from any export made from now on. This cannot be undone.
      <span className="mt-2 block">{ON_DISK}</span>
      <span className="mt-2 block">
        If the text is a secret, such as a password or a key, change the secret as well.
      </span>
      {live === null ? null : (
        <span className="mt-2 block">
          This fact was merged into <span className="font-mono break-all">{live}</span>, which says
          the same and keeps its text: redact that fact as well if the claim itself should go.
        </span>
      )}
    </ConfirmDialog>
  );
}

function Text({ fact }: { fact: ApiFact }) {
  if (fact.redacted) {
    return (
      <p role="status">
        This fact was redacted. Agents no longer receive its text, and it is gone from the
        dashboard, from search and from exports made since. {ON_DISK}
      </p>
    );
  }
  return (
    <>
      <Lead>{fact.claim}</Lead>
      {fact.detail === null ? null : (
        <Section title="Detail">
          <p className="whitespace-pre-wrap">{fact.detail}</p>
        </Section>
      )}
      {fact.question === null ? null : (
        <Section title="Recorded to answer">
          <p>“{fact.question}”</p>
        </Section>
      )}
    </>
  );
}

/**
 * Why only the reader sees a fact of theirs, said beside the mark that says so: a project that is
 * shared does not show every fact in it, and the person is not left to guess which rule kept one.
 */
const PRIVATE_BECAUSE: Record<NonNullable<FactDetail["private_because"]>, string> = {
  project: "Only you see this fact: its project is private.",
  model_unchecked:
    "Only you see this fact, though you share its project: a model wrote it and nobody has checked it. Confirm it once you have checked it against its source, and it is shared.",
  no_source:
    "Only you see this fact, though you share its project: none of its citations can be looked up. It is shared once one can.",
  // A redacted fact stays its author's alone whatever they choose, so the way out names both cases.
  cites_private:
    "Only you see this fact, though you share its project: it cites a fact of yours that others cannot see. It is shared once that one is. If that one was redacted it never will be: have your agent correct this fact without that citation, and this fact is shared.",
  merged_word:
    "Only you see this fact, though you share its project: a duplicate merged into it has no citation that can be looked up, and would be shown with it. Redact that duplicate, or undo the merge on Activity, and this fact is shared.",
};

/**
 * What a person is told of a fact no agent published: where it came from, and that its source was
 * named by the session and looked up by nobody.
 */
const BY_A_MODEL =
  "A language model wrote this fact from what the session’s agent said, after the session was over. The agent did not publish it, and nobody looked its citations up when it was written.";

function FactBody({ id }: { id: string }) {
  const detail = useQuery(factQuery(id));
  return (
    <QueryState query={detail} what="the fact">
      {(data) => <FactShown detail={data} />}
    </QueryState>
  );
}

function FactShown({ detail }: { detail: FactDetail }) {
  const top = useRef<HTMLDivElement>(null);
  const { fact, confirmations, history, private_because: because } = detail;
  return (
    <>
      <div ref={top} tabIndex={-1} className="flex flex-wrap gap-1.5 outline-none">
        <StatusMark fact={fact} />
        <SeenByMark audience={fact.audience} />
        <TrustMark trust={fact.trust} />
        <FlagMarks flags={fact.flags} />
      </div>
      {because === undefined ? null : <p className="text-ink-muted">{PRIVATE_BECAUSE[because]}</p>}
      {fact.from_session === null ? null : <p className="text-ink-muted">{BY_A_MODEL}</p>}
      <Text fact={fact} />
      <Details>
        <Detail term="Project" className="break-all">
          {fact.project}
        </Detail>
        <Detail term="Author">{fact.author}</Detail>
        {fact.from_session === null ? null : (
          <Detail term="Written by">a language model, from session {fact.from_session}</Detail>
        )}
        <Detail term="Published">
          <Ago at={fact.created_at} />
        </Detail>
        <Detail term="Updated">
          <Ago at={fact.updated_at} />
        </Detail>
      </Details>
      <Citations citations={fact.citations} />
      <Checks confirmations={confirmations} />
      <Connections fact={fact} />
      <History entries={history} />
      {fact.redacted || !fact.own ? null : (
        <Redact id={fact.id} live={fact.superseded_by} after={top} />
      )}
    </>
  );
}

/** The drawer of the fact the address names. */
export function FactDrawer() {
  return (
    <SideDrawer name="Fact" param="fact">
      {(id) => <FactBody key={id} id={id} />}
    </SideDrawer>
  );
}
