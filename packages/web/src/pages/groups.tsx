/**
 * Groups: the people of the organization a project can be shared with. Everyone is in `everyone`.
 * The person who made the organization makes other groups, says who is in them and, where people
 * sign in through a provider, makes the link that invites a person, and can hand the organization
 * to another of its people; everyone else sees the groups
 * they are in and who is in them.
 */
import type { GroupList } from "@uketsugi/contracts";
import { useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  addToGroup,
  capabilitiesQuery,
  groupsQuery,
  handOver,
  makeGroup,
  makeJoinLink,
  removeFromGroup,
} from "../api.ts";
import { Page, useChange, useSession } from "../shell.tsx";
import {
  Button,
  Card,
  CodeBlock,
  Empty,
  ChangeDialog,
  ErrorPanel,
  QueryState,
  submitOnce,
  TextBox,
} from "../ui.tsx";

type Group = GroupList["groups"][number];

const refreshGroups = (client: QueryClient) =>
  Promise.all([
    client.invalidateQueries({ queryKey: groupsQuery.queryKey }),
    client.invalidateQueries({ queryKey: ["projects"] }),
    client.invalidateQueries({ queryKey: ["facts"] }),
  ]);

/** Takes one person out of a group. Out of `everyone` is out of the organization, and the question says so. */
function Remove({ group, person, name }: { group: string; person: string; name: string }) {
  const removed = useChange((csrf) => removeFromGroup(group, person, csrf), refreshGroups);
  return (
    <Button
      size="sm"
      tone="danger"
      disabled={removed.isPending}
      aria-label={`Take ${name} out of ${group}`}
      onClick={() => removed.mutate()}
    >
      {group === "everyone" ? "Remove" : "Take out"}
    </Button>
  );
}

/** A choice among the organization's people. */
function PersonSelect(props: {
  id: string;
  people: GroupList["people"];
  person: string;
  onPerson: (id: string) => void;
}) {
  return (
    <select
      id={props.id}
      value={props.person}
      onChange={(event) => props.onPerson(event.target.value)}
      className="h-8 rounded-md border border-line-strong bg-surface px-2"
    >
      <option value="">Choose a person</option>
      {props.people.map((one) => (
        <option key={one.id} value={one.id}>
          {one.name}
        </option>
      ))}
    </select>
  );
}

/** Adds one of the organization's people to a group. */
function Add({ group, people }: { group: Group; people: GroupList["people"] }) {
  const [person, setPerson] = useState("");
  const added = useChange(
    (csrf) => addToGroup(group.name, { person }, csrf),
    async (client) => {
      setPerson("");
      await refreshGroups(client);
    },
  );
  const left = people.filter((one) => !group.members.some((member) => member.id === one.id));
  if (left.length === 0) return null;
  return (
    <form
      onSubmit={submitOnce(person === "" || added.isPending, added.mutate)}
      className="flex flex-wrap items-center gap-2"
    >
      <label htmlFor={`add-${group.name}`} className="font-medium">
        Add to {group.name}
      </label>
      <PersonSelect id={`add-${group.name}`} people={left} person={person} onPerson={setPerson} />
      <Button type="submit" disabled={person === "" || added.isPending}>
        Add
      </Button>
      {added.isError ? <ErrorPanel error={added.error} /> : null}
    </form>
  );
}

function GroupCard({ group, data }: { group: Group; data: GroupList }) {
  return (
    <Card label={group.name}>
      <div className="space-y-3 p-4">
        <h2 className="font-semibold">{group.name}</h2>
        <ul className="space-y-1">
          {group.members.map((member) => (
            <li key={member.id} className="flex items-center gap-3">
              <span>{member.name}</span>
              {data.administrator ? (
                <Remove group={group.name} person={member.id} name={member.name} />
              ) : null}
            </li>
          ))}
        </ul>
        {data.administrator ? <Add group={group} people={data.people} /> : null}
      </div>
    </Card>
  );
}

/** Makes a group. A name the server refuses is answered here, in the server's words. */
function Make() {
  const [name, setName] = useState("");
  const make = useChange(
    (csrf) => makeGroup({ name }, csrf),
    async (client) => {
      setName("");
      await refreshGroups(client);
    },
  );
  return (
    <form
      onSubmit={submitOnce(make.isPending, make.mutate)}
      className="flex flex-wrap items-center gap-2"
    >
      <label htmlFor="group-name" className="font-medium">
        Make a group
      </label>
      <TextBox
        id="group-name"
        required
        maxLength={80}
        autoComplete="off"
        value={name}
        onText={setName}
        width="w-56"
      />
      {make.isError ? <ErrorPanel error={make.error} /> : null}
      <Button type="submit" tone="primary" disabled={make.isPending}>
        Make the group
      </Button>
    </form>
  );
}

/** Hands the organization to another of its people, asked about first: they are its administrator, and the person is not. */
function HandOver({ people }: { people: GroupList["people"] }) {
  const [person, setPerson] = useState("");
  const chosen = people.find((one) => one.id === person);
  const handed = useChange((csrf) => handOver(person, csrf), refreshGroups);
  return (
    <Card label="Hand the organization over">
      <div className="flex flex-wrap items-center gap-2 p-4">
        <label htmlFor="hand-over" className="font-medium">
          Hand the organization to
        </label>
        <PersonSelect id="hand-over" people={people} person={person} onPerson={setPerson} />
        <ChangeDialog
          mutation={handed}
          trigger={<Button disabled={chosen === undefined} />}
          triggerText="Hand over"
          title={`Hand the organization to ${chosen?.name ?? ""}?`}
          keep="Keep it"
          text={`Yes, hand it to ${chosen?.name ?? ""}`}
        >
          {chosen?.name ?? "They"} will be the administrator: they make groups, say who is in them
          and invite people. You will be one of the people and cannot take it back unless they hand
          it to you. Until you have handed it on you cannot delete your account.
        </ChangeDialog>
      </div>
    </Card>
  );
}

/** Where people sign in through a provider, the link that brings a person into this organization. */
function Invite() {
  const { csrf } = useSession();
  const link = useMutation({ mutationFn: () => makeJoinLink(csrf) });
  return (
    <div className="space-y-2">
      <Button disabled={link.isPending} onClick={() => link.mutate()}>
        Make an invitation link
      </Button>
      {link.isSuccess ? (
        <>
          <CodeBlock text={link.data.link} label="the invitation link" />
          <p className="text-ink-muted">
            Send it to the person yourself. It works once, for the person who opens it and signs in,
            and stops working on <time dateTime={link.data.expires_at}>{link.data.expires_at}</time>
            . Whoever runs this service has to have invited them to it first.
          </p>
        </>
      ) : null}
      {link.isError ? <ErrorPanel error={link.error} /> : null}
    </div>
  );
}

function Listed({ data }: { data: GroupList }) {
  const capabilities = useQuery(capabilitiesQuery).data?.dashboard;
  const others = data.people.filter((one) => one.id !== data.you);
  const signsIn = capabilities !== undefined && !capabilities.key_form;
  return (
    <div className="space-y-4">
      {data.groups.length === 0 ? (
        <Empty sentence="You are in no group: nobody else is on this server yet" />
      ) : (
        data.groups.map((group) => <GroupCard key={group.name} group={group} data={data} />)
      )}
      {data.administrator ? (
        <div className="space-y-4">
          <Make />
          {signsIn ? <Invite /> : null}
          {others.length === 0 ? null : <HandOver people={others} />}
        </div>
      ) : null}
    </div>
  );
}

export function GroupsPage() {
  const groups = useQuery(groupsQuery);
  return (
    <Page
      title="Groups"
      lead="The people a project can be shared with. Each project is shared with one group, or kept private."
    >
      <QueryState query={groups} what="your groups">
        {(data) => <Listed data={data} />}
      </QueryState>
    </Page>
  );
}
