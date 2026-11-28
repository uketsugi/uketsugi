/**
 * What is kept of a person's data and for how long, in the words the dashboard shows and the
 * READMEs repeat. A test holds each README to these lines, and the store's tests hold each line to
 * what the code does, so a change to one is a change to all.
 */

/** Each kind of record, and how long it is kept. A deletion that takes a record takes it from the database itself. */
export const RETENTION = [
  {
    what: "Facts, tasks and the notes on them",
    kept: "Kept until you delete them, their project or your account. There is no timer.",
  },
  {
    what: "Earlier wordings of a fact, and redacted facts",
    kept: "An earlier wording stays with its fact until that is deleted. A redacted fact keeps no text.",
  },
  {
    what: "A session's note",
    kept: "Kept until you remove it, or delete its project or your account.",
  },
  {
    what: "What you and an agent said, kept for a language model to read",
    kept: "Deleted once the model has read it, or when you remove the session's note.",
  },
  {
    what: "The log of who did what",
    kept: "Holds ids, kinds and hashes and no text. The entries about a record are deleted with it.",
  },
  {
    what: "Tokens",
    kept: "Only a token's hash is kept, until the account is deleted.",
  },
  {
    what: "Totals of language-model use",
    kept: "Counts of tokens, each with the id of the person whose session it was for and no text, kept for seven days. Deleting the account takes the id off them.",
  },
] as const;

/** What deleting an account leaves, and what a person is told before it is done. */
export const AFTER_DELETION = [
  "Deleting your account deletes every fact, task, note and session you wrote, in every project and in every group you shared it with, wherever it now is, a group you have since left included: the people in those groups stop reading it. Facts of other people that cited yours are marked as having a source that changed.",
  "What stays is what other people wrote, and what you did to their records, which the log keeps as ids and codes with no text, under an account that has no name.",
  "Of the account itself two things stay, and no text: its internal id, on the account's own row and private audience and wherever you are named on what is not yours, on the log, flags, invitations and a task's lease; and a one-way hash of the identifier your sign-in provider gave you, kept so that the account cannot be opened again, which anyone who holds that identifier could match.",
] as const;

/** What the open edition says of backups. */
export const LOCAL_BACKUPS =
  "A backup is a file you make with `ukt backup` and keep on your own disk. Deleting a project or a fact does not reach it, and restoring one brings back what it held.";
