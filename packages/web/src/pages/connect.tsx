/**
 * Connect: for each harness the server describes, its address, the variable that holds the token,
 * and then the one command to type. Where a harness offers that command nobody pastes the block
 * and it is shown for reference; where it does not, the block is given to copy.
 */
import { Collapsible } from "@base-ui/react/collapsible";
import { Tabs } from "@base-ui/react/tabs";
import type { ActivitySession, ConnectHarness, ConnectInfo } from "@uketsugi/contracts";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { Ban, ChevronRight, Search, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { activityQuery, connectQuery } from "../api.ts";
import { Page } from "../shell.tsx";
import {
  Ago,
  Card,
  CodeBlock,
  CopyButton,
  ErrorPanel,
  INLINE_CODE,
  Loading,
  Mark,
  type Look,
} from "../ui.tsx";

const route = getRouteApi("/connect");

/** How often the recent sessions are read again, so that a first session is seen to arrive. */
const REFRESH_MS = 5000;
/** How far back the recent sessions are asked for, in days. */
const RECENT_DAYS = 7;

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="space-y-2 pl-1">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </li>
  );
}

/**
 * How the server is added. A harness that is added by a command reads the token from a variable
 * of the shell the command runs in, so the line that sets it comes first: with it unset the
 * harness is added without a token and the server refuses it.
 */
function AddServer({ harness, info }: { harness: ConnectHarness; info: ConnectInfo }) {
  const typed = harness.add_kind === "command";
  const variable = <code className={INLINE_CODE}>{info.token_env}</code>;
  return (
    <Step title={`Add the server to ${harness.name}`}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5">
        <dt className="text-ink-muted">Server URL</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <code className={INLINE_CODE}>{info.mcp_url}</code>
          <CopyButton text={info.mcp_url} label="the server URL" />
        </dd>
        <dt className="text-ink-muted">Token</dt>
        <dd>
          {typed ? <>read from the environment variable {variable}; </> : null}
          this page never shows the token itself. On the server&apos;s host,{" "}
          <code className={INLINE_CODE}>ukt token</code> prints yours.
        </dd>
      </dl>
      {typed ? (
        <>
          <p>
            Run these in one terminal on the server&apos;s host. The first line puts your token in{" "}
            {variable}, where the second reads it:
          </p>
          <CodeBlock
            text={`${info.token_command}\n${harness.add}`}
            label={`what adds the server to ${harness.name}`}
          />
          <p className="text-ink-muted">
            On another machine, set {variable} to the token you were given in place of the first
            line.
          </p>
          {harness.remove === undefined ? null : (
            <p className="text-ink-muted">
              {harness.name} keeps the token it was added with. To give it another, after{" "}
              <code className={INLINE_CODE}>ukt token --rotate</code> for one, first remove the
              server with <code className={INLINE_CODE}>{harness.remove}</code>, then run the lines
              above again.
            </p>
          )}
        </>
      ) : (
        <>
          <p>Put this in {harness.add_file ?? "the client's configuration"}:</p>
          <CodeBlock text={harness.add} label={`what adds the server to ${harness.name}`} />
        </>
      )}
    </Step>
  );
}

/**
 * The step that puts the block in the instruction file. Where the harness offers the server's
 * commands the person types one and the agent writes the block. Where it does not, the person
 * pastes the block, so it is given here to copy, with the file it goes in where the server knows it.
 */
function WriteBlock({ harness, info }: { harness: ConnectHarness; info: ConnectInfo }) {
  const file =
    harness.instruction_file === undefined ? (
      "its user-level instruction file"
    ) : (
      <code className={INLINE_CODE}>{harness.instruction_file}</code>
    );
  if (harness.setup !== undefined)
    return (
      <Step title="Type the set-up command">
        <CodeBlock text={harness.setup} label="the set-up command" />
        {harness.instruction_file_command === undefined ? (
          <p className="text-ink-muted">
            {info.commands.setup.description} The agent writes the block first in {file}, once. Your
            harness may ask you to approve the edit. Every later session then uses memory with
            nothing typed.
          </p>
        ) : (
          // The file is not in the same place on every machine, so the agent is not left to
          // guess it: it runs the command the server gives it and writes where that says.
          <p className="text-ink-muted">
            {info.commands.setup.description} The agent writes the block first in that file, once.
            The file is {file} unless your harness keeps its configuration somewhere else, so the
            agent finds it by running{" "}
            <code className={INLINE_CODE}>{harness.instruction_file_command}</code>. Your harness
            may ask you to approve that command and the edit. Every later session then uses memory
            with nothing typed.
          </p>
        )}
      </Step>
    );
  return (
    <Step title="Put the block in the instruction file">
      <p>
        {harness.instruction_file === undefined
          ? "Where the client lists a server's prompts as commands, type its set-up command and the agent does this. Where it does not, put"
          : `${harness.name} does not offer a server's commands, so nothing writes the block for you. Put`}{" "}
        this block at the very top of {file}, making the file if it is not there and keeping what it
        already holds below the block:
      </p>
      <CodeBlock text={info.block} label="the block" />
      <p className="text-ink-muted">Every later session then uses memory with nothing typed.</p>
    </Step>
  );
}

function Steps({ harness, info }: { harness: ConnectHarness; info: ConnectInfo }) {
  return (
    <div className="space-y-5 p-5">
      <ol className="list-decimal space-y-5 pl-5 marker:font-semibold">
        <AddServer harness={harness} info={info} />
        <WriteBlock harness={harness} info={info} />
      </ol>
      {harness.activate === undefined ? null : (
        <div className="space-y-2 border-t border-line pt-4">
          <h2 className="font-semibold">Or, for one session only</h2>
          <CodeBlock text={harness.activate} label="the command for one session" />
          <p className="text-ink-muted">
            {info.commands.activate.description} It writes nothing: type it again in the next
            session.
          </p>
        </div>
      )}
      {harness.note === undefined ? null : <p className="text-ink-muted">{harness.note}</p>}
      <p className="border-t border-line pt-4 text-ink-muted">
        An agent names its project by the repository&apos;s origin remote. For a directory that is
        not a repository, or a repository with no origin remote, make a project name of your own on{" "}
        <Link to="/projects" className="font-medium underline">
          Projects
        </Link>
        .
      </p>
    </div>
  );
}

function BlockReference({ block }: { block: string }) {
  return (
    <Collapsible.Root className="border-t border-line px-5 py-3">
      <Collapsible.Trigger className="group flex cursor-pointer items-center gap-1 rounded-sm font-medium">
        <ChevronRight aria-hidden className="size-4 group-data-panel-open:rotate-90" />
        The block set-up writes
      </Collapsible.Trigger>
      <Collapsible.Panel className="space-y-2 pt-2">
        <p className="text-ink-muted">
          For reference. Where a client offers the set-up command, the agent writes this block and
          nobody pastes it.
        </p>
        <pre className="rounded-md bg-sunken p-3 font-mono text-[0.8125rem] break-words whitespace-pre-wrap">
          {block}
        </pre>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

const TAB =
  "h-8 cursor-pointer rounded-md border border-line-strong bg-surface px-3 font-medium hover:bg-sunken data-active:border-accent data-active:bg-accent-soft data-active:text-accent-ink";

/** One tab for each harness the server describes, in the server's order. */
function Harnesses({ info }: { info: ConnectInfo }) {
  const { harness } = route.useSearch();
  const navigate = route.useNavigate();
  const selected = info.harnesses.find((each) => each.id === harness) ?? info.harnesses[0];
  return (
    <Tabs.Root
      value={selected?.id ?? null}
      onValueChange={(id) => void navigate({ search: { harness: String(id) }, replace: true })}
      className="space-y-4"
    >
      <Tabs.List aria-label="Where you work" className="flex flex-wrap gap-2">
        {info.harnesses.map((each) => (
          <Tabs.Tab key={each.id} value={each.id} className={TAB}>
            {each.name}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {info.harnesses.map((each) => (
        <Tabs.Panel key={each.id} value={each.id}>
          <Card>
            <Steps harness={each} info={info} />
            {each.setup === undefined ? null : <BlockReference block={info.block} />}
          </Card>
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}

const DID: Look = { tone: "ok", icon: Search };
const WROTE: Look = { tone: "ok", icon: Upload };
const REFUSED: Look = { tone: "warn", icon: Ban };

function SessionRow({ session }: { session: ActivitySession }) {
  return (
    <li className="space-y-1 rounded-md border border-line p-3">
      <p>
        <span className="font-semibold">{session.client}</span>{" "}
        <span className="text-ink-muted">
          {session.version === null ? "" : `${session.version} · `}
          <span className="font-mono">{session.session}</span>
        </span>
      </p>
      <p className="text-ink-muted">
        {session.project ?? "no project named"} · last call <Ago at={session.last_call_at} />
      </p>
      <p className="flex flex-wrap gap-1.5">
        {session.last_search_at === null ? null : <Mark look={DID}>searched</Mark>}
        {session.last_publish_at === null ? null : <Mark look={WROTE}>published</Mark>}
        {session.refused_calls === 0 ? null : (
          <Mark look={REFUSED}>{session.refused_calls} refused for a missing project</Mark>
        )}
      </p>
    </li>
  );
}

function RecentSessions() {
  const activity = useQuery(activityQuery(RECENT_DAYS, REFRESH_MS));
  const sessions = activity.data?.recent ?? [];
  return (
    <Card label="Recent sessions">
      <div className="space-y-3 p-5">
        <h2 className="font-semibold">Recent sessions</h2>
        {activity.isError ? <ErrorPanel error={activity.error} /> : null}
        <p role="status" className="sr-only">
          {activity.isSuccess ? `${sessions.length} recent sessions` : ""}
        </p>
        <ul className="space-y-2">
          {sessions.map((session) => (
            <SessionRow key={session.session} session={session} />
          ))}
        </ul>
        <p className="rounded-md border border-dashed border-line-strong p-3 text-ink-muted">
          Waiting for the {sessions.length === 0 ? "first" : "next"} session… this list updates by
          itself.
        </p>
      </div>
    </Card>
  );
}

export function ConnectPage() {
  const connect = useQuery(connectQuery);
  return (
    <Page
      title="Connect an agent"
      lead="Pick where you work. Add the server by its URL, then type one command."
    >
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
        {connect.isPending ? (
          <Loading what="the set-up" />
        ) : connect.isError ? (
          <ErrorPanel error={connect.error} onRetry={() => void connect.refetch()} />
        ) : (
          <Harnesses info={connect.data} />
        )}
        <RecentSessions />
      </div>
    </Page>
  );
}
