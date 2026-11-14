/**
 * Connect: for each harness the server describes, what the person runs to connect it. A harness
 * with a plugin is connected by installing it: nobody types set-up or places the block, and the
 * route without the plugin is kept behind a disclosure. Where there is none, the server is added
 * by its URL, and the block goes in by the set-up command or by hand.
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

/** Where the server is and where its token comes from: what every way of connecting starts from. */
function ServerAndToken({ info, typed }: { info: ConnectInfo; typed: boolean }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5">
      <dt className="text-ink-muted">Server URL</dt>
      <dd className="flex flex-wrap items-center gap-2">
        <code className={INLINE_CODE}>{info.mcp_url}</code>
        <CopyButton text={info.mcp_url} label="the server URL" />
      </dd>
      <dt className="text-ink-muted">Token</dt>
      <dd>
        {typed ? (
          <>
            read from the environment variable <code className={INLINE_CODE}>{info.token_env}</code>
            ;{" "}
          </>
        ) : null}
        this page never shows the token itself. On the server&apos;s host,{" "}
        <code className={INLINE_CODE}>ukt token</code> prints yours.
      </dd>
    </dl>
  );
}

/**
 * Lines a person runs in a shell, which read the token from a variable of that shell. The line
 * that sets it comes first: with it unset the harness is given no token and the server refuses it.
 */
function TokenLines({ lines, label, info }: { lines: string; label: string; info: ConnectInfo }) {
  const variable = <code className={INLINE_CODE}>{info.token_env}</code>;
  return (
    <>
      <p>
        Run these in one terminal on the server&apos;s host. The first line puts your token in{" "}
        {variable}, where the rest read it:
      </p>
      <CodeBlock text={`${info.token_command}\n${lines}`} label={label} />
      <p className="text-ink-muted">
        On another machine, set {variable} to the token you were given in place of the first line.
      </p>
    </>
  );
}

/** How the server is added to a harness by its URL: a command to run, or the URL to give the client. */
function AddServer({ harness, info }: { harness: ConnectHarness; info: ConnectInfo }) {
  const typed = harness.add_kind === "command";
  return (
    <Step title={`Add the server to ${harness.name}`}>
      <ServerAndToken info={info} typed={typed} />
      {typed ? (
        <>
          <TokenLines
            lines={harness.add}
            label={`what adds the server to ${harness.name}`}
            info={info}
          />
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
          <p>Give the client this URL:</p>
          <CodeBlock text={harness.add} label={`what adds the server to ${harness.name}`} />
        </>
      )}
    </Step>
  );
}

type Plugin = NonNullable<ConnectHarness["plugin"]>;

/**
 * The step that installs a harness's plugin. Where the plugin adds the server too it is the only
 * step, and its lines read the token; where it does not, the server was added in the step before.
 */
function InstallPlugin({
  harness,
  plugin,
  info,
}: {
  harness: ConnectHarness;
  plugin: Plugin;
  info: ConnectInfo;
}) {
  const label = `what installs the plugin for ${harness.name}`;
  const taken = (
    <>
      To take it out again: <code className={INLINE_CODE}>{plugin.remove}</code>.
    </>
  );
  if (!plugin.adds_server)
    return (
      <Step title="Install the plugin">
        <CodeBlock text={plugin.install} label={label} />
        <p className="text-ink-muted">
          The plugin gives every session the block as a standing rule, so nobody places it in a
          file. {taken}
        </p>
      </Step>
    );
  return (
    <Step title={`Install the plugin for ${harness.name}`}>
      <ServerAndToken info={info} typed />
      <TokenLines lines={plugin.install} label={label} info={info} />
      <p className="text-ink-muted">
        The plugin adds the server. Every later session starts with its project&apos;s brief in
        front of the agent and uses memory with nothing typed, and where a session stopped is kept
        as a note for the next one. To give it another token, run the last line again. {taken}
      </p>
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

/** The command that uses memory in one session and writes nothing, where the harness offers it. */
function OneSession({ harness, info }: { harness: ConnectHarness; info: ConnectInfo }) {
  if (harness.activate === undefined) return null;
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <h2 className="font-semibold">Or, for one session only</h2>
      <CodeBlock text={harness.activate} label="the command for one session" />
      <p className="text-ink-muted">
        {info.commands.activate.description} It writes nothing: type it again in the next session.
      </p>
    </div>
  );
}

/** What a person does who goes without the plugin: what the plugin would have done, by hand. */
function WithoutPlugin({
  harness,
  plugin,
  info,
}: {
  harness: ConnectHarness;
  plugin: Plugin;
  info: ConnectInfo;
}) {
  return (
    <Collapsible.Root className="border-t border-line pt-3">
      <Collapsible.Trigger className="group flex cursor-pointer items-center gap-1 rounded-sm font-medium">
        <ChevronRight aria-hidden className="size-4 group-data-panel-open:rotate-90" />
        Without the plugin
      </Collapsible.Trigger>
      <Collapsible.Panel className="space-y-5 pt-3">
        <ol className="list-decimal space-y-5 pl-5 marker:font-semibold">
          {plugin.adds_server ? <AddServer harness={harness} info={info} /> : null}
          <WriteBlock harness={harness} info={info} />
        </ol>
        <OneSession harness={harness} info={info} />
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function Steps({ harness, info }: { harness: ConnectHarness; info: ConnectInfo }) {
  const { plugin } = harness;
  return (
    <div className="space-y-5 p-5">
      <ol className="list-decimal space-y-5 pl-5 marker:font-semibold">
        {plugin?.adds_server === true ? null : <AddServer harness={harness} info={info} />}
        {plugin === undefined ? (
          <WriteBlock harness={harness} info={info} />
        ) : (
          <InstallPlugin harness={harness} plugin={plugin} info={info} />
        )}
      </ol>
      {plugin === undefined ? (
        <OneSession harness={harness} info={info} />
      ) : (
        <WithoutPlugin harness={harness} plugin={plugin} info={info} />
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
    <Page title="Connect an agent" lead="Pick where you work, then run what it shows.">
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
