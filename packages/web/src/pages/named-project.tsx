/**
 * Named projects, on Projects: the project of work that no origin remote names. A person makes
 * one here, `me/<slug>`; no agent can. An agent then learns it from the instruction file of the
 * directory it works in and from nowhere else, so every named project the person has is shown
 * with the line that goes in that file.
 */
import { Input } from "@base-ui/react/input";
import type { ApiProject } from "@uketsugi/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { createProject, projectsQuery } from "../api.ts";
import { useSession } from "../shell.tsx";
import { Button, Card, CodeBlock, ErrorPanel, INLINE_CODE } from "../ui.tsx";

const TITLE = "A project for a directory with no origin remote";
/** The most characters a slug may have: the contract's limit on `NewProjectRequest.slug`. */
const SLUG_LENGTH = 63;

/**
 * The line that tells an agent the project of a directory. These are the words that were tried:
 * with them in a directory's `CLAUDE.md`, Claude Code 2.1.325 searched and published under the
 * named project from its first question, and with nothing said it made no call at all.
 */
function instructionLine(key: string): string {
  return `The uketsugi project for this directory is \`${key}\`.`;
}

/** Makes a named project. A slug the server refuses is answered here, in the server's words. */
function Make() {
  const { csrf } = useSession();
  const client = useQueryClient();
  const [slug, setSlug] = useState("");
  const make = useMutation({
    mutationFn: () => createProject({ slug }, csrf),
    onSuccess: () => {
      setSlug("");
      return client.invalidateQueries({ queryKey: projectsQuery.queryKey });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    // A second Enter while the first is on its way would be refused: the project exists by then.
    if (!make.isPending) make.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <label htmlFor="slug" className="block font-medium">
        Slug
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex min-w-0 items-center gap-1 font-mono">
          <span aria-hidden>me/</span>
          <Input
            id="slug"
            required
            maxLength={SLUG_LENGTH}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby="slug-rule"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            className="h-8 w-56 max-w-full min-w-0 rounded-md border border-line-strong bg-surface px-3"
          />
        </span>
        <Button type="submit" tone="primary" disabled={make.isPending}>
          Make the project
        </Button>
      </div>
      <p id="slug-rule" className="text-ink-muted">
        Lower-case letters, digits and hyphens, starting with a letter or a digit. The project is
        named <code className={INLINE_CODE}>me/</code> followed by the slug, and the slug never
        changes.
      </p>
      <p role="status" className="empty:hidden">
        {make.isSuccess
          ? `${make.data.key} is made. Your agent does not know it yet: put its line, shown below, in the instruction file of the directory you work in.`
          : ""}
      </p>
      {make.isError ? <ErrorPanel error={make.error} /> : null}
    </form>
  );
}

/** The line for each named project, and where it goes. */
function Lines({ named }: { named: ApiProject[] }) {
  if (named.length === 0) return null;
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <h3 className="font-semibold">Tell your agent</h3>
      <p>
        An agent learns a named project from the instruction file of the directory it works in. Put
        the project’s line in that file, then start a new conversation in that directory. For Claude
        Code the file is <code className={INLINE_CODE}>CLAUDE.md</code> in that directory. For
        another harness it is the instruction file your harness reads in that directory.
      </p>
      <ul className="space-y-2">
        {named.map((project) => (
          <li key={project.key}>
            <CodeBlock text={instructionLine(project.key)} label={`the line for ${project.key}`} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function NamedProjects({ projects }: { projects: ApiProject[] }) {
  return (
    <Card label={TITLE}>
      <div className="space-y-4 p-4">
        <div className="space-y-2">
          <h2 className="font-semibold">{TITLE}</h2>
          <p>
            Most people never need this. An agent names the project it works in by the repository’s
            origin remote. A directory that is not a repository, or a repository with no origin
            remote, gives it no name, and the agent gets no memory and no tasks there.
          </p>
          <p>
            For work in such a directory, make a named project here, then tell your agent its name:
            once the project is made, this page shows the line to put in the directory’s instruction
            file. A named project is yours alone and stays private.
          </p>
        </div>
        <Make />
        <Lines named={projects.filter((project) => project.kind === "named")} />
      </div>
    </Card>
  );
}
