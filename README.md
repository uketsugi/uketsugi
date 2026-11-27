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

Uketsugi is a small server you run on your own machine. It gives your coding agents one shared
memory and a way to hand work to each other. An agent writes down what it establishes about your
code as a fact with a citation. The next agent, in whichever harness it runs, searches that memory
before it investigates, and can pick up a task that another one left.

**It is for you if** you work with more than one coding agent, such as Claude Code and
Antigravity, or in many sessions on the same repositories, and want what one of them works out to
be there for the next. Your harnesses reach it over [MCP](https://modelcontextprotocol.io), and
everything stays on your machine.

**After the four steps of the [Quickstart](#quickstart)**, two of which download about 60 MB and
170 MB, you have the server running as your own service at `http://127.0.0.1:7410`, your
harnesses added to it, and sessions that are told to search memory before they investigate and to
publish what they establish. A small dashboard shows the facts, the tasks and what each session did.

> **Pre-release (0.2.0).** Linux on x86-64 only. It has been run end to end with Claude Code and
> Antigravity: each found what the other had recorded, and each finished a task the other had
> left. For Codex, VS Code and Cursor the line that adds the server was run, and no session was.
> Commands, and what is stored, may still change between versions.

The name is Japanese, 受け継ぎ: handing on, taking over from someone.

## Quickstart

You need Linux on x86-64 (glibc 2.28 or newer), with `curl`, `tar` and `sha256sum`. No root, and
no Node.js: the release brings its own runtime and leaves any Node you have alone.

### 1. Install

```sh
curl -fsSL https://github.com/uketsugi/uketsugi/releases/download/v0.2.0/install.sh | sh
```

It downloads one archive of about 60 MB, checks it against the SHA-256 the script carries,
unpacks it to `~/.local/lib/uketsugi` and puts the `ukt` command in `~/.local/bin`. Nothing else
is written. If it says `~/.local/bin` is not on your `PATH`, run the two lines it prints.

### 2. Set up

```sh
ukt setup
```

Set-up makes the data directory and shows what else it will do, then asks once: download the
embedding model (about 170 MB), which lets search match meaning, and install a systemd user
service that runs the server at `http://127.0.0.1:7410` and starts it when you log in. It ends by
printing the line to type for each harness. [What set-up does](#what-set-up-does) has the detail.
Without systemd, as in a container, run `ukt serve` in a terminal of its own.

### 3. Add the server to your harness

Claude Code:

```sh
claude mcp add --transport http --scope user uketsugi http://127.0.0.1:7410/mcp
```

Antigravity:

```sh
agy mcp add uketsugi http://127.0.0.1:7410/mcp
```

Codex, VS Code, Cursor and any other MCP client are under [Harnesses](#harnesses). No token is
involved: a server that only your machine reaches, with you as its one person, takes your
harnesses by their address alone.

### 4. Turn it on

A harness that has the server does not use it until its agent is told to. Start a new session in
a repository (one open before step 3 does not have the server).

- **Claude Code:** type `/uketsugi:activate`. It tells the agent in that session to search
  Uketsugi before investigating and to publish what it establishes; it writes nothing, and you type
  it again next time. To have every later session do it without a command, type
  `/uketsugi:setup` once: the agent puts a short block at the top of your user-level instruction
  file, `~/.claude/CLAUDE.md` (or `CLAUDE.md` in the folder `CLAUDE_CONFIG_DIR` names). Claude
  Code may ask you to approve the edit. It is the agent that writes the file, so look afterwards
  and see that the block is there. In print mode (`claude -p`) the two commands are
  `/mcp__uketsugi__activate` and `/mcp__uketsugi__setup`, and the server's tools must be allowed
  with `--allowedTools mcp__uketsugi`.
- **Antigravity** offers no server commands. Either put the block at the top of
  `~/.gemini/GEMINI.md` (`ukt ui` opens the dashboard, whose Connect page shows the block to
  copy), or install the plugin that ships with the release, which is the same block as a rule that
  is always on:

  ```sh
  agy plugin install ~/.local/lib/uketsugi/plugins/antigravity
  ```

Then ask the agent something about your code. It is told to search first; finding nothing, it
works the answer out and publishes it. In a new session, in either harness, ask again: it finds
the fact, with its citation to check. An agent does not always search before its first look at the
code, even when told to.

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
  with a note for whoever is next, or finish it. A task can also be left in another repository's
  project, for a later session there to find in its brief.
- **A new session starts with a brief.** It says what is open, how your last session here ended
  and what the project already knows. With the [Claude Code plugin](#the-claude-code-plugin) the
  agent has it before your first prompt; elsewhere it comes with the first answer it gets from
  Uketsugi.
- **You can see all of it.** `ukt ui` opens the dashboard in your browser, already signed in, with
  the facts, the tasks and what each session did, project by project. (`ukt ui --no-open` prints
  the link instead; it works once, within two minutes.)
- **You can put it right.** On the dashboard you read the note each session left and remove it; you
  correct the words of a fact of yours, and confirm a fact a model wrote once you have checked it;
  you close a task of yours that is stale; and you delete a project with what you hold in it, after being
  shown what goes. Agents are given the change from their next call. None of this is open to an
  agent or its token: it takes your signed-in browser. A correction keeps no copy of the words it
  replaced, and a deletion leaves what [your data](#your-data) says a redaction does.

A brief leads with the facts you told an agent, so a later session sees them first and each is
marked `(cites your person)`. It leads with the 20 newest facts that cite only you. An older one
has no lead: it is listed, and marked, only where it is among the project's newest 60 facts or one
a model chose for the brief, and otherwise your agent finds it by searching.

A project is its repository's origin remote, `host/owner/name`, and an agent passes it on every
call. A directory without one needs [a name of its own](#a-directory-with-no-origin-remote).

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

## Harnesses

Every harness takes the server by its address. `ukt setup` and `ukt doctor` print these lines for
the server as it runs, and the dashboard's Connect page shows the same, with the lines that carry
a token where the server asks for one.

| Harness     | Adds the server by               | Turned on by                                      | What has been run here                |
| ----------- | -------------------------------- | ------------------------------------------------- | ------------------------------------- |
| Claude Code | `claude mcp add`, or the plugin  | a command typed in a session, or the block        | sessions, with and without the plugin |
| Antigravity | `agy mcp add`                    | the block in `~/.gemini/GEMINI.md`, or its plugin | sessions                              |
| Codex       | `codex mcp add`                  | the block in the instruction file it reads        | the line that adds it; no session     |
| VS Code     | `code --add-mcp`                 | the block in the instruction file it reads        | the line that adds it; no session     |
| Cursor      | an entry in `~/.cursor/mcp.json` | the block in the instruction file it reads        | its agent read the entry; no session  |
| Another     | the URL                          | the block in the instruction file it reads        | nothing                               |

Claude Code and Antigravity are in the [Quickstart](#quickstart). For Codex and VS Code:

```sh
codex mcp add uketsugi --url http://127.0.0.1:7410/mcp
code --add-mcp '{"name":"uketsugi","type":"http","url":"http://127.0.0.1:7410/mcp"}'
```

Cursor has no command for it: in `~/.cursor/mcp.json`, under `"mcpServers"`, add
`"uketsugi": {"url": "http://127.0.0.1:7410/mcp"}`, and approve the server when its agent asks.

For each of these, put the block from the Connect page at the top of the instruction file the
harness reads.

### Another MCP client

Any client that takes a remote MCP server by its URL can use the same server:

- **URL:** `http://127.0.0.1:7410/mcp`, over Streamable HTTP.
- **Header:** `Authorization: Bearer <token>`, where the server asks for one (see
  [Sharing a server](#sharing-a-server)). `ukt token` prints it. On the server's own machine,
  while you are its only person, the header is left out.
- **Tools it will find:** `search_facts`, `publish_fact`, `update_fact`, `search_tasks`,
  `publish_task`, `claim_task` and `update_task`.

An agent uses the tools once its instructions say so: copy the block from the Connect page to the
top of the client's instruction file.

### The Claude Code plugin

The release also ships a plugin for Claude Code. Nothing needs it, and set-up never installs it.
It adds the server too, so use it instead of the `claude mcp add` line:

```sh
claude plugin install uketsugi --marketplace ~/.local/lib/uketsugi/plugins \
  --config url=http://127.0.0.1:7410
```

Claude Code ends the install by saying that two of the plugin's options are not set: the token
and `capture`. On your own machine neither is needed. From the next session on, in every
repository:

- **The agent starts with the session's brief**, before your first prompt, and is told to search
  Uketsugi before investigating and to publish what it establishes. Nothing is typed.
- **Where each turn ended is kept**: the agent's last message, scanned like everything else and
  private to you. A session you quit, or one that is killed, still tells the next one where it
  stopped.

What it sends, and when: Claude Code runs the plugin's hook when a session starts, before each call
to the server's tools, as each turn ends and when the session ends. Each time, the hook passes on
to your server what Claude Code handed it, with the repository's origin remote, which names the
project. The server reads from it the session, which tool call belongs to it and, as a turn ends,
the agent's last message, of which it keeps the first 4,000 characters the scan leaves. What you
type is not sent unless you turn on [`capture`](#reading-the-whole-conversation). The hooks need
`sh`, `curl` and `git`. A hook that cannot reach the server does nothing, and the session goes on
without it. On your own machine none of this goes further than your own server.

Where the server asks for a token, a second line gives it to the plugin on standard input, so that
it is never on a command line:

```sh
printf '{"token":"%s"}' "$(ukt token)" | claude plugin configure uketsugi@uketsugi --values-stdin
```

### A directory with no origin remote

An agent names its project by the repository's origin remote. In a directory that is not a
repository, or a repository with no origin, it has no name to give and gets no memory. For work
there, make a project name on the dashboard's Projects page. The page then shows a line to put in
that directory's instruction file (`CLAUDE.md` for Claude Code), such as:

```
The uketsugi project for this directory is `me/harbour-notes`.
```

## Running the server

### What set-up does

`ukt setup` makes the data directory, `~/.local/share/uketsugi`, and your token. It then shows what
else it would do, and where, and asks once:

- **The embedding model**, which lets search match meaning: a download of about 170 MB from the
  npm registry and Hugging Face, each file checked against a pinned hash, into the data directory.
  Without it search matches words only. The service does not see a `UKT_MODEL_DIR` of your shell:
  set-up says so, and the model must then be in the data directory.
- **A service**: one unit of your own systemd user manager,
  `~/.config/systemd/user/uketsugi.service` (under `$XDG_CONFIG_HOME` where that is set), which
  runs the server at `http://127.0.0.1:7410`, starts it when you log in and starts it again if it
  fails; one you stop stays stopped. Set-up writes that file and the link the manager makes to it
  in `default.target.wants` beside it: nothing else outside the data directory. No root, and no
  secret in it.

When it has started the server it checks that the server is yours, asks it for its tools as a
harness would and reads its store (this leaves nothing behind), then ends with the address and
what to type for each harness. Set-up runs no harness command and writes no harness file.

| Option                       | What it does                                                           |
| ---------------------------- | ---------------------------------------------------------------------- |
| `--plan`                     | prints the plan, the unit in full, and changes nothing                 |
| `--yes`                      | does all of it without asking                                          |
| `--no-model`, `--no-service` | leave that part out                                                    |
| `--port <port>`              | listens on another port than 7410                                      |
| `--data-dir <dir>`           | keeps the data elsewhere (or set `UKT_DATA_DIR`)                       |
| `--host`, `--allowed-host`   | let other machines reach it: see [Sharing a server](#sharing-a-server) |
| `--llm <provider/model>`     | gives it a [language model](#a-language-model-if-you-want-one)         |

Run again, set-up changes nothing that is in place and repairs what is not. It starts the service
again when it has installed the model or changed a setting, so that the server runs with it. Where
nobody can be asked, as in a script, it makes the data directory and installs the model, and leaves the service
to a run with `--yes`. `ukt setup --help` lists every option.

### The service

```sh
systemctl --user stop uketsugi      # and start, restart, status
journalctl --user -u uketsugi       # what the server printed
```

It runs while you are logged in to the machine. `loginctl enable-linger` keeps it running after
you log out; set-up tells you when that is off, and does not change it. A server that fails five
times in five minutes is not started again until `systemctl --user reset-failed uketsugi`.

`ukt doctor` checks the data directory, the token, the service, the server, the store and the
model, says what to do about anything that is wrong, and prints again what to type for each
harness.

**Without systemd.** In a container, or in a shell that cannot reach your service manager (one
entered with `su`), set-up says so and installs no service. Start the server yourself and give it
a terminal of its own:

```sh
ukt serve
```

It serves `http://127.0.0.1:7410` in the foreground until you press Ctrl-C.

**On a PostgreSQL server.** The store can live in a database you run instead of in the data
directory. The database needs the `vector` (pgvector 0.7 or newer) and `pg_trgm` extensions, and
the role you connect as must be allowed to create them. Name it once, to `ukt setup` or `ukt serve`:

```sh
ukt setup --database-url postgres://user:password@host:5432/database
ukt serve --database-url postgres://user:password@host:5432/database
```

The data directory remembers the address, in `settings.json`, so later commands on it need no
flag. `UKT_DATABASE_URL` does the same as the flag. One data directory has one store, and a
different address is refused. `ukt backup` and `ukt restore` do not apply to it: use `pg_dump` and
`pg_restore`.

**Upgrading.** Run the install line of the newer release. It replaces the one installed and,
without asking, restarts your service on the new one: your harnesses lose their connection for a
moment. A `ukt serve` you started yourself you stop and start again.

## Your data

Everything is on your machine:

| Path                                      | What it holds                                                                                                                                                                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.local/share/uketsugi`                 | The store, the token, how the server is set to run (`settings.json`), the embedding model, `backups/` and, where you named a language model, its key. It is `$XDG_DATA_HOME/uketsugi` where that is set, and `--data-dir` or `UKT_DATA_DIR` moves it. |
| `~/.local/lib/uketsugi`                   | The installed release.                                                                                                                                                                                                                                |
| `~/.local/bin/ukt`                        | The command.                                                                                                                                                                                                                                          |
| `~/.config/systemd/user/uketsugi.service` | The service's unit, where set-up installed one (under `$XDG_CONFIG_HOME` where that is set). It names the release's launcher and the data directory, and nothing else.                                                                                |

A harness keeps what you add to it in its own configuration: `~/.claude` for Claude Code and
`~/.gemini/config` for Antigravity. Set-up writes nothing there. The server listens on `127.0.0.1`
only, unless you set it up with `--host`.

- `ukt backup` writes the whole store to one file in `backups/`, while the server runs (`--out`
  names another file). `ukt restore <file>` puts it back, after saving the store as it is now to
  `backups/` unless you pass `--discard-current`. Everything goes back to the snapshot, people and
  tokens included: a token revoked since it was taken works again, and a project made private
  since is shared again. A server that runs as the service is stopped for it and started again;
  one you started yourself you stop first.
- `ukt export --markdown <folder>` writes every project's facts as Markdown, one file a project.
- Redacting a fact on the dashboard takes its text out of the dashboard, out of search and out of
  later exports. The text stays in the store's own files, and so in a backup made afterwards. On a
  PostgreSQL server it stays in the server's files and write-ahead log, though not in a `pg_dump`
  made afterwards. If the text was a secret, change the secret as well.
- `ukt token --rotate` replaces your token. A server that is running does it and goes on serving:
  the old token is refused at once. A harness that sends a token keeps the one it was given until
  you give it the new one: remove the server from it and add it again with the lines on the
  Connect page. One that sends none is not affected.

### Removing Uketsugi

```sh
ukt uninstall
rm -rf ~/.local/share/uketsugi ~/.local/lib/uketsugi ~/.local/bin/ukt
```

The first command undoes what set-up did outside the data directory: it stops and removes the
service, and the folders set-up made for it. It shows what it will do and asks first, and it
leaves your data and the program, which the second line deletes. It does not touch a harness,
since set-up did not: it prints the command that takes the server out of each, such as
`claude mcp remove uketsugi -s user`. If an agent wrote the block into your instruction file, or
you put it there, the lines between `<!-- uketsugi:start -->` and `<!-- uketsugi:end -->` are yours
to delete.

## Sharing a server

The same server serves several people. Whoever runs it adds each of them:

```sh
ukt invite Aiko --operator-name Ren
```

That prints a harness token and a dashboard key for the new person, once. (`--operator-name` is
your own name as the others will see it, needed before the first person is added.) Everything a
person's agents publish is private to that person until they share the project, which they do
themselves on the dashboard's Projects page. Sharing shows the others their facts there that
carry a citation that can be looked up, and their tasks, under their name. `ukt people` lists who
is on the server and `ukt revoke <id>` ends one token or key.

**Who needs a token.** A server that listens only on its own machine takes its one person's
harnesses there by their address alone, and `ukt setup`, `ukt doctor` and the Connect page say
whether it does. From the first person you add, every harness sends a token, yours included, and
the same holds for a server that listens beyond its machine. A proxy or a tunnel on the same
machine can look like a local program to the server: it recognises the ones that say a request
was forwarded, and not every one does. Before you put one in front of a server that you alone
use, set it up with `ukt setup --require-token`.

**Reaching it from other machines.** Set it up with
`ukt setup --host 0.0.0.0 --allowed-host <name>`. Set-up keeps how the server runs in the data
directory, so the service and a `ukt serve` you type start the same server. It answers only to the
names it is given, and it speaks plain HTTP, so put it behind a proxy that terminates TLS.

A person you invited installs nothing of Uketsugi's. They add the server to their harness with the
lines the Connect page shows them, which carry their token, or install the plugin the server hands
out. With the server at `https://memory.example.com` and their token in `UKT_TOKEN`, Claude Code is
connected by:

```sh
claude plugin install uketsugi --marketplace https://memory.example.com/plugins/marketplace.json \
  --config url=https://memory.example.com
printf '{"token":"%s"}' "$UKT_TOKEN" | claude plugin configure uketsugi@uketsugi --values-stdin
```

Claude Code fetches a plugin from a server over `https` only, and never from a loopback address,
so someone on the server's own machine installs it from the release's folder, as
[above](#the-claude-code-plugin), or adds the server by its URL. After the server is upgraded,
`claude plugin update uketsugi@uketsugi` fetches the plugin that goes with it. Fetching the plugin
from a server over `https` has not yet been run.

**Tell the people you invite what the plugin sends.** With it, what it sends goes to your server
from every repository that person works in: each one's origin remote, and the agent's last message
of each turn. Nobody else on the server is shown them, but they rest in a database you run. One
who does not want that adds the server by its URL instead, without the plugin.

## A language model, if you want one

Uketsugi needs no language model. Everything above runs on rules, and nothing your agents say
leaves your machine. You can give the server a model, and it then reads each session once the
session is over:

- **It writes down what the agent did not.** From what the session's agent said, it makes facts
  the agent established and never published. Each one must cite a file, a commit or a URL that the
  session itself named, and is stored the way a published fact is: scanned first, under your name,
  and marked as written by a model from that session. Only you see it until you or your agent has
  checked it and confirmed it, even in a project you share: a model's word is not put in front of
  your teammates' agents unchecked.
- **It judges what a rule cannot.** A fact that says in other words what one already held says is
  merged into it, or not stored. Two facts that cannot both be true are flagged, for the next
  agent to check against the code.
- **It chooses what the next brief shows first**, when a project holds more facts than a brief has
  room for.

A fact a model wrote says so wherever it is shown, to you and to an agent, with the session it
came from. Nobody looked up its citations when it was written, so treat it as you would a
colleague's note: your agent can confirm it once it has checked, or correct it, and you can
redact it.

Name the model once, as `provider/model`:

```sh
ukt setup --llm google/gemini-3.8-flash
```

`ukt setup` asks for the provider's key without showing it, or takes it from `UKT_LLM_KEY` where
nobody is at the terminal, and keeps both in the data directory, in a file only you can read. A
service in place starts again on it. `ukt setup --llm none` forgets them. A server you start with
`ukt serve` and no set-up takes `--llm` (or `UKT_LLM`) with the key in `UKT_LLM_KEY`.

The providers are `google`, `openai` and `anthropic`, and `openai-compatible` for anything that
serves OpenAI's chat API at a URL, such as a model on your own machine:
`ukt setup --llm openai-compatible/<model> --llm-url http://127.0.0.1:11434/v1`. The model step has
been run with Google's models; the other providers have not been run. `ukt doctor` asks the model
one small question and says whether it answers; `ukt doctor --no-llm` leaves the question out.

### What it costs

The server spends on the model only within bounds you can see and set:

- A session's readings together are held to 150,000 tokens, input and output together, as the
  provider counts them. Before each call the server adds its own estimate for that call, taken
  high, to what the provider has counted so far, and asks only if the total, with 8,000 kept back
  for the two small questions that close a reading, is within 150,000. A session is therefore read
  as far as its limit allows and no further; what it said past that is dropped.
- The server as a whole spends at most 1,000,000 tokens (in and out together) in any 24 hours
  unless you set `--llm-budget <tokens>` on `ukt setup` (remembered) or `ukt serve`. It takes no
  less than 20,000, which is about what one reading needs, and refuses a smaller number. Once the budget is reached, readings
  wait, and the turns they would read are kept until there is room.
- A reading that fails after it had cost tokens does not send again the turns it had read: they are
  deleted, and the facts drawn from them are kept. The turns it had not read wait, as they do for
  the budget, and are read when the provider answers. A provider that fails before a reading has
  cost anything, or refuses your key or account, makes the whole reading wait the same way, and
  `ukt doctor` says so. What waits is dropped after twelve hours.
- `ukt serve` prints a line for every session it read, with the tokens the model took in and gave
  out, and the dashboard's Activity page lists them. `ukt doctor` shows what the last 24 hours cost
  against the budget.

### What is sent, and what is not

**Sent to the provider you named:** what a session's agent said (its last message, or with
`capture` on, each turn's request and final answer), the one-line claims of the facts you published
in the session, the claims of your own facts in that project that it is compared with, and up to
60 more of your claims there that it chooses among, private ones included. A session is read once,
after it has ended or gone quiet for ten minutes, or when you start the next session in the
project and it has been idle; a turn that has been asked and not answered is left alone until it
is.

**Never sent:** your files, what your tools printed, another person's facts or sessions, and
anything at all while no model is configured. On a server shared by several people, only the
sessions of whoever runs it are read: naming a model is that person's choice, and it is not made
for anyone else.

### Reading the whole conversation

By default the model reads one thing of a session: the agent's last message, which the plugin
sends as each turn ends. To have it read the whole conversation, turn on the plugin's `capture`
option:

```sh
printf '{"capture":"true"}' | claude plugin configure uketsugi@uketsugi --values-stdin
```

The plugin then also sends what you ask and the agent's final answer of every turn. The server
scans each like any write, keeps it for the model alone, and deletes it once the model has read
it, or after twelve hours unread when the model cannot be reached. A session holds at most 100 turns, and a turn is cut to 4,000 characters of request and 16,000
of answer. A server with no model keeps none of it, but the plugin still sends it there, and it is
dropped on arrival: where the server is on another machine, that text crosses the network.

The scanner removes what has the shape of a credential it knows. A secret with no known shape,
such as a plain password typed into a prompt, is not caught, and with `capture` on it is sent to
the provider. Leave `capture` off for work where that could happen.

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
