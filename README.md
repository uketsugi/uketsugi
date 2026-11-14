<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/hero-dark.svg">
    <img src="assets/hero-light.svg" width="880" alt="Three small agents in a relay: the first hands a scroll to the second, and a third waits for its turn.">
  </picture>
</p>

<h1 align="center">Uketsugi <sub>受け継ぎ</sub></h1>

<p align="center">
  <strong>Memory and task handoff for AI coding agents:<br>across sessions, across agents, across vendors.</strong>
</p>

Uketsugi is a shared memory for AI coding agents, and a way for them to hand work to one another.
What one agent works out about your code is there for the next one, whichever vendor's harness it
runs in and whenever it starts. Work that one agent began can be picked up by another.

The name is Japanese, 受け継ぎ: handing on, taking over from someone.

It is a small server that agents reach over [MCP](https://modelcontextprotocol.io), and you run it
yourself. One install on your own machine needs nothing else set up; the same server can be shared
by several people.

> **Pre-release (0.1.0).** Uketsugi runs on Linux x86-64 today. It has been run end to end with
> two harnesses, Claude Code and Antigravity: each found what the other had recorded, and each
> finished a task the other had left. It is built for any harness that can add an MCP server by
> its URL, and [connecting one](#another-mcp-client) takes a URL and a token. Commands, and what
> is stored, may still change between versions.

## How it works

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/steps-dark.svg">
    <img src="assets/steps-light.svg" width="880" alt="Learn it once: a fact, with where it comes from. Find it later, before working it out again. Hand it on: a task the next one can pick up.">
  </picture>
</p>

- **An agent writes down what it establishes.** A fact is one claim with at least one citation (a
  file and its lines, a commit, a URL) and the question it answers. Before a fact is stored it is
  scanned, and anything recognised as a credential is replaced with a marker such as
  `[redacted:github-token]`.
- **The next agent looks before it digs.** A search returns the facts that match, their citations
  to check, and how confident the match is. With the embedding model installed, a question can
  find a fact that answers it in other words.
- **Unfinished work becomes a task.** An agent that takes a task holds a lease on it, so a second
  agent is told it is taken rather than doing it twice. It can leave notes, hand the task over
  with a note for whoever is next, or finish it. A task can be left for another repository.
- **A new session starts with a brief.** The first answer it gets from Uketsugi also says what is
  open, what the last session here published, and what the project already knows.
- **You can see all of it.** A small dashboard shows the facts, the tasks and what each session
  did, project by project.

A project is its repository's origin remote, `host/owner/name`. An agent passes it on every call.
A directory without one needs [a name of its own](#a-directory-with-no-origin-remote).

## Quickstart

For Linux on x86-64, checked on Ubuntu 22.04 and in a Debian 13 container. You need `curl`, `tar`
and `sha256sum`. No root, and no Node.js: the release brings its own runtime and leaves any Node
you have alone.

**1. Install**

```sh
curl -fsSL https://github.com/uketsugi/uketsugi/releases/download/v0.1.0/install.sh | sh
```

The script downloads one archive of 56 MB from the same release, checks it against the SHA-256 it
carries, unpacks it to `~/.local/lib/uketsugi` (about 170 MB) and puts the `ukt` command in
`~/.local/bin`. Nothing else is written. If it says `~/.local/bin` is not on your `PATH`, run the
two lines it prints: one for this shell, one for new ones.

**2. Set up**

```sh
ukt setup
```

This makes the data directory, `~/.local/share/uketsugi`, and a token for your harness. It also
installs the embedding model that lets search match meaning: a download of about 170 MB from the
npm registry and Hugging Face, each file checked against a pinned hash. `ukt setup --no-model`
leaves the model out, and search then matches words only.

**3. Start the server**

```sh
ukt serve
```

It serves `http://127.0.0.1:7410` in the foreground until you press Ctrl-C, so give it a terminal
of its own. From another terminal, `ukt doctor` checks the data directory, the token, the server,
the store and the model, and says what to do about anything that is wrong.

**4. Connect Claude Code**

In another terminal:

```sh
export UKT_TOKEN="$(ukt token)"
claude mcp add --transport http --scope user uketsugi http://127.0.0.1:7410/mcp \
  --header "Authorization: Bearer $UKT_TOKEN"
```

Then start Claude Code in a repository and type:

```
/uketsugi:setup
```

This asks the agent to put a short block at the top of your user-level instruction file. That is
`~/.claude/CLAUDE.md`, or `CLAUDE.md` in the folder `CLAUDE_CONFIG_DIR` names if you have set one;
the agent finds it by running one `echo` command. Claude Code may ask you to approve that command
and the edit. The block tells every later session to search Uketsugi before investigating how or
why something works, and to publish what it establishes, with a citation.

It is the agent that writes the file, so look afterwards and see that the block is there. You can
also place it yourself: the dashboard's Connect page shows the block, and it goes at the very top
of the file. After that you work as you always do.

### Antigravity

Antigravity has no set-up command, so both steps are done by hand:

1. Put the server in `~/.gemini/config/mcp_config.json`, with your token itself in place of
   `<token>` (`ukt token` prints it):

   ```json
   {
     "mcpServers": {
       "uketsugi": {
         "url": "http://127.0.0.1:7410/mcp",
         "headers": { "Authorization": "Bearer <token>" }
       }
     }
   }
   ```

2. Copy the block from the Antigravity tab of the dashboard's Connect page to the very top of
   `~/.gemini/GEMINI.md`.

### Another MCP client

Any client that takes a remote MCP server by its URL can use the same server:

- **URL:** `http://127.0.0.1:7410/mcp`, over Streamable HTTP.
- **Header:** `Authorization: Bearer <token>`. `ukt token` prints the token.
- **Tools it will find:** `search_facts`, `publish_fact`, `update_fact`, `search_tasks`,
  `publish_task`, `claim_task` and `update_task`.

An agent uses the tools once its instructions say so: copy the block from the Connect page to the
top of the client's instruction file.

### A directory with no origin remote

An agent names its project by the repository's origin remote. In a directory that is not a
repository, or a repository with no origin, it has no name to give and gets no memory. For work
there, make a project name on the dashboard's Projects page. The page then shows a line to put in
that directory's instruction file (`CLAUDE.md` for Claude Code), such as:

```
The uketsugi project for this directory is `me/harbour-notes`.
```

## What you will see

Ask your agent something about the code. It searches first, finds nothing, works the answer out
and publishes it. Then start a new session and ask again:

<p align="center">
  <img src="assets/later-session.png" width="880" alt="Claude Code, asked whether the timetable can be refreshed every five minutes, answers from what the project's shared memory already recorded and checks it against the code.">
</p>
<p align="center"><sub>A new Claude Code session in the same repository. Nothing was typed before the question.</sub></p>

`ukt ui` opens the dashboard in your browser, already signed in. (`ukt ui --no-open` prints the
link instead; it works once.)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/dashboard-facts-dark.png">
    <img src="assets/dashboard-facts-light.png" width="880" alt="The dashboard's Facts page: the facts of one project, and one of them open with its detail, the question it answers and its citations.">
  </picture>
</p>
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/dashboard-handoff-dark.png">
    <img src="assets/dashboard-handoff-light.png" width="880" alt="The dashboard's Tasks page, showing finished tasks. One is open beside the list: its history says it was published through Antigravity, then claimed and finished through Claude Code.">
  </picture>
</p>
<p align="center"><sub>From Claude Code and Antigravity sessions on two small made-up repositories. The task shown beside the list was left by one harness and finished by the other.</sub></p>

## Your data

Everything is on your machine, in three places:

| Path                      | What it holds                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `~/.local/share/uketsugi` | The store, the token, the embedding model and `backups/`. `--data-dir` or `UKT_DATA_DIR` moves it. |
| `~/.local/lib/uketsugi`   | The installed release.                                                                             |
| `~/.local/bin/ukt`        | The command.                                                                                       |

The server listens on `127.0.0.1` only, unless you start it with `--host`.

- `ukt backup` writes the whole store to one file, while the server runs. `ukt restore <file>`
  puts it back, with the server stopped.
- `ukt export --markdown <folder>` writes every project's facts as Markdown, one file a project.
- Redacting a fact on the dashboard takes its text out of the dashboard, out of search and out of
  later exports. It does not reach the store's own files or a backup, even one made afterwards.
  If the text was a secret, change the secret as well.
- `ukt token --rotate` replaces your token, with the server stopped. A harness keeps the token it
  was added with, so remove the server from it and add it again: for Claude Code,
  `claude mcp remove uketsugi -s user`, then the two lines of step 4.

To remove Uketsugi, stop the server and delete those three paths:

```sh
rm -rf ~/.local/share/uketsugi ~/.local/lib/uketsugi ~/.local/bin/ukt
claude mcp remove uketsugi -s user
```

Then delete the block between `<!-- uketsugi:start -->` and `<!-- uketsugi:end -->` in the same
instruction file set-up wrote it to. For Antigravity, take the server out of `mcp_config.json` and
the block out of `GEMINI.md`.

## Sharing a server

The same server serves several people. Whoever runs it adds each of them:

```sh
ukt invite Aiko --operator-name Ren
```

That prints a harness token and a dashboard key for the new person, once. Everything a person's
agents publish is private to that person until they share the project, which they do themselves
on the dashboard's Projects page. Sharing shows the others their facts there that carry a citation
that can be looked up, and their tasks, under their name. `ukt people` lists who is on the server and
`ukt revoke <id>` ends one token or key.

To reach it from other machines, start it with `ukt serve --host 0.0.0.0 --allowed-host <name>`.
It answers only to the names it is given, and it speaks plain HTTP, so put it behind a proxy that
terminates TLS.

## From source

The code is a TypeScript workspace. It needs Node.js 24.21 or newer in the 24 line, and pnpm 9.

```sh
pnpm install
pnpm check                          # types, lint, formatting, tests
pnpm ukt serve --data-dir ./data    # the server, run from source
deploy/build.sh                     # the release archive and its install.sh, in deploy/dist
```

## Licence

Apache-2.0: see [LICENSE](LICENSE). [NOTICE](NOTICE) lists what is included from other projects.
