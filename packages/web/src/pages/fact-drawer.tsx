/**
 * One fact, in a drawer beside the list: what it claims, where it comes from, who checked it, what
 * happened to it, and what a person does to it here: correct its words, say they checked it, or
 * redact it, which is asked about first.
 */
import type {
  ApiConfirmation,
  ApiFact,
  Citation,
  FactDetail,
  FactHistoryEntry,
} from "@uketsugi/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState, type RefObject } from "react";
import { confirmFact, correctFact, factQuery, redactFact, refreshFacts } from "../api.ts";
import { SeenByMark } from "../by-project.tsx";
import { Detail, Details, Lead, Section, SideDrawer } from "../drawer.tsx";
import { useChange } from "../shell.tsx";
import {
  Ago,
  Button,
  ChangeDialog,
  CitationMark,
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
 * Redacts the fact. `live` is the fact this one was merged into, if it was: a redaction takes this
 * fact's text and leaves that fact's, which says the same.
 */
function Redact(props: { id: string; live: string | null; after: RefObject<HTMLElement | null> }) {
  const { id, live, after } = props;
  const redact = useChange((csrf) => redactFact(id, csrf), refreshFacts);
  return (
    <ChangeDialog
      mutation={redact}
      trigger={<Button tone="danger" />}
      triggerText="Redact…"
      title="Redact this fact?"
      keep="Keep the fact"
      text="Redact the fact"
      // Once the fact is redacted its button is gone, so the focus goes to the top of the drawer.
      finalFocus={() => (redact.isSuccess ? after.current : true)}
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
    </ChangeDialog>
  );
}

/** The fact's words in a form, for the person to put right. Sending them unchanged changes nothing. */
function Correct({ fact }: { fact: ApiFact }) {
  const [editing, setEditing] = useState(false);
  const [claim, setClaim] = useState(fact.claim ?? "");
  const [detail, setDetail] = useState(fact.detail ?? "");
  const correct = useChange(
    (csrf) => correctFact(fact.id, { claim, detail: detail === "" ? null : detail }, csrf),
    refreshFacts,
  );
  if (!editing) {
    return (
      <Button
        onClick={() => {
          setClaim(fact.claim ?? "");
          setDetail(fact.detail ?? "");
          correct.reset();
          setEditing(true);
        }}
      >
        Correct…
      </Button>
    );
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        correct.mutate(undefined, { onSuccess: () => setEditing(false) });
      }}
    >
      <label className="block font-medium" htmlFor="correct-claim">
        Claim
      </label>
      <textarea
        id="correct-claim"
        value={claim}
        onChange={(event) => setClaim(event.target.value)}
        rows={3}
        className="w-full rounded-md border border-line-strong bg-surface p-2"
      />
      <label className="block font-medium" htmlFor="correct-detail">
        Detail
      </label>
      <textarea
        id="correct-detail"
        value={detail}
        onChange={(event) => setDetail(event.target.value)}
        rows={4}
        className="w-full rounded-md border border-line-strong bg-surface p-2"
      />
      <p className="text-ink-muted">
        Agents are given these words from now on, under your name, and the history says you changed
        them. Uketsugi keeps no copy of the words they replace, and other people’s confirmations of
        the fact are dropped. {ON_DISK}
      </p>
      {correct.isError ? <ErrorPanel error={correct.error} /> : null}
      <div className="flex gap-2">
        <Button tone="primary" type="submit" disabled={correct.isPending || claim.trim() === ""}>
          Save the correction
        </Button>
        <Button onClick={() => setEditing(false)}>Leave it as it is</Button>
      </div>
    </form>
  );
}

/** Says the person has checked the fact against what it cites: the check a model's fact waits for. */
function Confirm({ fact }: { fact: ApiFact }) {
  const confirm = useChange((csrf) => confirmFact(fact.id, csrf), refreshFacts);
  return (
    <>
      <Button disabled={confirm.isPending} onClick={() => confirm.mutate()}>
        I have checked this fact
      </Button>
      {confirm.isError ? <ErrorPanel error={confirm.error} /> : null}
    </>
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
      {fact.redacted ? null : (
        <div className="flex flex-wrap gap-2">
          {fact.superseded_by === null &&
          fact.status === "unconfirmed" &&
          (fact.from_session !== null || !fact.own) ? (
            <Confirm fact={fact} />
          ) : null}
          {fact.superseded_by === null && fact.own ? <Correct fact={fact} /> : null}
          {fact.own ? <Redact id={fact.id} live={fact.superseded_by} after={top} /> : null}
        </div>
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
