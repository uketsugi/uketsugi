/**
 * One task, in a drawer beside the list: what is to be done, who published it and who holds it,
 * every note left on it and what happened to it, oldest first. Agents take, note, hand over and
 * finish tasks; a person closes a stale task of theirs (one they published or their agent holds),
 * behind a confirmation. The server says "you" of the reader.
 */
import type { ApiTask, TaskDetail, TaskEvent, TaskNote } from "@uketsugi/contracts";
import { useQuery } from "@tanstack/react-query";
import { closeTask, taskQuery } from "../api.ts";
import { SeenByMark } from "../by-project.tsx";
import { useChange } from "../shell.tsx";
import { Detail, Details, Lead, Section, SideDrawer } from "../drawer.tsx";
import { Ago, Button, ChangeDialog, inWords, QueryState, sentence, TaskStateMark } from "../ui.tsx";

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

/** Marks the task done, whoever holds it. Agents stop being offered it and the brief stops listing it. */
function Close({ task }: { task: ApiTask }) {
  const close = useChange(
    (csrf) => closeTask(task.id, csrf),
    (client) => client.invalidateQueries({ queryKey: ["tasks"] }),
  );
  return (
    <ChangeDialog
      mutation={close}
      trigger={<Button />}
      triggerText="Close task…"
      title="Close this task?"
      keep="Leave it open"
      text="Close the task"
    >
      It is marked done, and its history says you closed it. No agent is offered it again, and the
      next session’s brief no longer lists it.
      {task.holder === undefined ? null : (
        <span className="mt-2 block">
          An agent holds it now: its lease is ended, and that agent’s next update is refused.
        </span>
      )}
    </ChangeDialog>
  );
}

function TaskBody({ id }: { id: string }) {
  const detail = useQuery(taskQuery(id));
  return (
    <QueryState query={detail} what="the task">
      {(data) => <TaskShown detail={data} />}
    </QueryState>
  );
}

function TaskShown({ detail }: { detail: TaskDetail }) {
  const { task, notes, history } = detail;
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        <TaskStateMark task={task} />
        <SeenByMark audience={task.audience} />
      </div>
      <Lead>{task.title}</Lead>
      {task.description === undefined ? null : (
        <Section title="What is to be done">
          <p className="break-words whitespace-pre-wrap">{task.description}</p>
        </Section>
      )}
      <Details>
        <Detail term="Project" className="break-all">
          {task.project}
        </Detail>
        <Detail term="Published">
          {task.publisher === undefined ? "" : `by ${task.publisher}, `}
          <Ago at={task.created_at} />
        </Detail>
        {task.tracked === true ? (
          <Detail term="Kind">A step of an agent’s own plan, private to its person</Detail>
        ) : null}
        {task.holder === undefined ? null : (
          <Detail term="Lease">
            <Lease task={task} />
          </Detail>
        )}
        <Detail term="Changed">
          <Ago at={task.updated_at} />
        </Detail>
      </Details>
      <Notes notes={notes} />
      <History events={history} />
      {task.state === "done" || !(task.publisher === "you" || task.holder === "you") ? null : (
        <Close task={task} />
      )}
    </>
  );
}

/** The drawer of the task the address names. */
export function TaskDrawer() {
  return (
    <SideDrawer name="Task" param="task">
      {(id) => <TaskBody key={id} id={id} />}
    </SideDrawer>
  );
}
