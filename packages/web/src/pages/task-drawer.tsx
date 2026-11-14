/**
 * One task, in a drawer beside the list: what is to be done, who published it and who holds it,
 * every note left on it and what happened to it, oldest first. A person reads here and changes
 * nothing: agents take, note, hand over and finish tasks.
 */
import type { ApiTask, TaskEvent, TaskNote } from "@uketsugi/contracts";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { taskQuery } from "../api.ts";
import { useSharing } from "../by-project.tsx";
import { Lead, Section, SideDrawer } from "../drawer.tsx";
import {
  Ago,
  ErrorPanel,
  inWords,
  Loading,
  Mark,
  SEEN_BY,
  sentence,
  TaskStateMark,
} from "../ui.tsx";

const route = getRouteApi("/tasks");

/** Someone and the client their agent worked from: "Lee via claude-code". */
function from(who: string, client: string | undefined): string {
  return client === undefined ? who : `${who} via ${client}`;
}

/** A task's lease: who took it and when it ends, or ended if nobody renewed it. Nothing for a task without one. */
export function Lease({ task }: { task: ApiTask }) {
  const { holder, lease_expires_at: end } = task;
  if (holder === undefined || end === undefined) return null;
  return (
    <>
      <span className="block">{from(holder, task.holder_client)}</span>
      <span className="block text-ink-muted">
        {task.lapsed === true ? "lease ended" : "lease ends"} <Ago at={end} />
      </span>
    </>
  );
}

function Notes({ notes }: { notes: TaskNote[] }) {
  return (
    <Section title="Notes">
      {notes.length === 0 ? (
        <p className="text-ink-muted">No note has been left on this task.</p>
      ) : (
        <ol className="space-y-2">
          {notes.map((note, index) => (
            <li
              key={`${index} ${note.at}`}
              className="space-y-1.5 rounded-md border border-line p-3"
            >
              <p className="text-ink-muted">
                {note.kind === "handoff" ? "Handoff note" : "Note"} ·{" "}
                {from(note.author, note.client)} · <Ago at={note.at} />
              </p>
              <p className="break-words whitespace-pre-wrap">{note.text}</p>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

/** What a claim came after, when the lease before it was not released. */
const AFTER: Record<NonNullable<TaskEvent["after"]>, string> = {
  lapsed: ", after the lease lapsed",
  take_over: ", taking it over",
};

function History({ events }: { events: TaskEvent[] }) {
  return (
    <Section title="History">
      {events.length === 0 ? (
        <p className="text-ink-muted">
          What happened to this task before it was shared is its publisher’s alone to read.
        </p>
      ) : (
        <ol className="space-y-1">
          {events.map((event, index) => (
            <li key={`${index} ${event.at}`}>
              {sentence(inWords(event.event))}
              {event.after === undefined ? "" : AFTER[event.after]}{" "}
              <span className="text-ink-muted">
                · {from(event.by, event.client)}
                {event.session === undefined ? "" : ` (${event.session})`} ·
              </span>{" "}
              <Ago at={event.at} />
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

function TaskBody({ id }: { id: string }) {
  const detail = useQuery(taskQuery(id));
  const sharing = useSharing();
  if (detail.isPending) return <Loading what="the task" />;
  if (detail.isError) {
    return <ErrorPanel error={detail.error} onRetry={() => void detail.refetch()} />;
  }
  const { task, notes, history } = detail.data;
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        <TaskStateMark task={task} />
        {sharing ? <Mark look={SEEN_BY[task.audience]}>{task.audience}</Mark> : null}
      </div>
      <Lead>{task.title}</Lead>
      {task.description === undefined ? null : (
        <Section title="What is to be done">
          <p className="break-words whitespace-pre-wrap">{task.description}</p>
        </Section>
      )}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-ink-muted">Project</dt>
        <dd className="break-all">{task.project}</dd>
        <dt className="text-ink-muted">Published</dt>
        <dd>
          {task.publisher === undefined ? "" : `by ${task.publisher}, `}
          <Ago at={task.created_at} />
        </dd>
        {task.tracked === true ? (
          <>
            <dt className="text-ink-muted">Kind</dt>
            <dd>A step of an agent’s own plan, private to its person</dd>
          </>
        ) : null}
        {task.holder === undefined ? null : (
          <>
            <dt className="text-ink-muted">Lease</dt>
            <dd>
              <Lease task={task} />
            </dd>
          </>
        )}
        <dt className="text-ink-muted">Changed</dt>
        <dd>
          <Ago at={task.updated_at} />
        </dd>
      </dl>
      <Notes notes={notes} />
      <History events={history} />
    </>
  );
}

/** The drawer of the task the address names. */
export function TaskDrawer() {
  const { task: id } = route.useSearch();
  const navigate = route.useNavigate();
  const close = () => void navigate({ search: (shown) => ({ ...shown, task: undefined }) });
  return (
    <SideDrawer name="Task" open={id !== undefined} onClose={close}>
      {id === undefined ? null : <TaskBody key={id} id={id} />}
    </SideDrawer>
  );
}
