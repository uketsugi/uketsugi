/**
 * Your data: what the person can take away, how long each kind of record is kept, and, where the
 * edition lets them, deleting the account with all of it. The deletion says first what goes, what
 * the people in each group lose, and what stays.
 */
import { AFTER_DELETION, RETENTION, type AccountContents } from "@uketsugi/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { accountContentsQuery, capabilitiesQuery, deleteAccount } from "../api.ts";
import { Page, useChange, useSession } from "../shell.tsx";
import { Button, Card, ChangeDialog, count, QueryState, TextBox } from "../ui.tsx";

const DOWNLOAD = "inline-block rounded-md border border-line-strong px-3 py-1.5 hover:bg-sunken";

function Download() {
  return (
    <Card label="Take your data with you">
      <div className="space-y-3 p-4">
        <h2 className="font-semibold">Take your data with you</h2>
        <p className="text-ink-muted">
          Everything you wrote, in every project and group: your facts, tasks, the notes your agents
          left, and your projects. Not what other people wrote.
        </p>
        <p className="space-x-3">
          <a className={DOWNLOAD} href="/api/export/mine" download>
            Download as JSON
          </a>
          <a className={DOWNLOAD} href="/api/export/mine?format=markdown" download>
            Download as Markdown
          </a>
        </p>
      </div>
    </Card>
  );
}

function Retention({ backups }: { backups: string }) {
  return (
    <Card label="How long it is kept">
      <div className="space-y-3 p-4">
        <h2 className="font-semibold">How long it is kept</h2>
        <dl className="space-y-2">
          {RETENTION.map((row) => (
            <div key={row.what}>
              <dt className="font-medium">{row.what}</dt>
              <dd className="text-ink-muted">{row.kept}</dd>
            </div>
          ))}
          <div>
            <dt className="font-medium">Backups</dt>
            <dd className="text-ink-muted">{backups}</dd>
          </div>
        </dl>
      </div>
    </Card>
  );
}

/** What deleting the account takes, group by group, and what stays. */
function Taken({ held }: { held: AccountContents }) {
  return (
    <div className="space-y-2">
      <p>
        This deletes {count(held.facts, "fact")}, {count(held.tasks, "task")},{" "}
        {count(held.sessions, "session")} and {count(held.task_notes, "note")} on tasks of yours,
        with the notes the sessions left, and your {count(held.confirmations, "confirmation")} of
        other people’s facts.
      </p>
      {held.groups.map((group) => (
        <p key={group.name}>
          In the group {group.name}, {count(group.facts, "fact")} and {count(group.tasks, "task")}{" "}
          of yours stop being readable by the {count(group.other_members, "other member")} there.
        </p>
      ))}
      <p>
        {count(held.others_facts, "fact")} and {count(held.others_tasks, "task")} of other people’s
        in the same projects stay.
      </p>
      {AFTER_DELETION.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

function Delete() {
  const { person } = useSession();
  const [name, setName] = useState("");
  const gone = useChange(
    (csrf) => deleteAccount(name.trim(), csrf),
    (client) => client.invalidateQueries(),
  );
  const contents = useQuery(accountContentsQuery);
  return (
    <Card label="Delete your account">
      <div className="space-y-3 p-4">
        <h2 className="font-semibold">Delete your account</h2>
        <QueryState query={contents} what="what the account holds">
          {(held) =>
            held.blocked === null ? (
              <>
                <Taken held={held} />
                <label className="block space-y-1">
                  <span>
                    Type <strong>{person}</strong> to delete the account.
                  </span>
                  <TextBox width="w-72" value={name} onText={setName} aria-label="Your name" />
                </label>
                <ChangeDialog
                  mutation={gone}
                  trigger={<Button tone="danger" disabled={name.trim() !== person} />}
                  triggerText="Delete my account…"
                  title="Delete your account?"
                  keep="Keep my account"
                  text="Delete my account and everything in it"
                >
                  This cannot be undone. You will be signed out, and the account cannot be opened
                  again.
                </ChangeDialog>
              </>
            ) : (
              <p className="text-ink-muted">{held.blocked}</p>
            )
          }
        </QueryState>
      </div>
    </Card>
  );
}

export function YourDataPage() {
  const data = useQuery(capabilitiesQuery).data?.data;
  return (
    <Page
      title="Your data"
      lead="What you can take with you, how long each kind of record is kept, and how to have it all deleted."
    >
      <div className="space-y-4">
        <Download />
        {data === undefined ? null : <Retention backups={data.backups} />}
        {data?.delete_account === true ? <Delete /> : null}
      </div>
    </Page>
  );
}
