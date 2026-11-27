/**
 * The dashboard's own parts: Base UI for behaviour, Tailwind classes over the tokens in
 * `styles.css` for looks. A status is always drawn by `Mark`: a shape, a colour and a word.
 */
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Button as BaseButton } from "@base-ui/react/button";
import {
  CITATION_WORD,
  type CitationClass,
  type FlagKind,
  type Status,
  type TaskState,
  type Trust,
} from "@uketsugi/contracts";
import { cva, cx, type VariantProps } from "class-variance-authority";
import { formatDistanceToNowStrict } from "date-fns";
import {
  Check,
  Circle,
  CircleCheck,
  Copy,
  CopyPlus,
  CornerUpRight,
  EyeOff,
  FileDiff,
  Flag,
  Forward,
  Hand,
  LinkIcon,
  Lock,
  MessageSquareQuote,
  Shield,
  ShieldCheck,
  TimerOff,
  TriangleAlert,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { partsOf } from "./api.ts";

export const buttonClass = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap select-none disabled:cursor-default disabled:opacity-60",
  {
    variants: {
      tone: {
        outline: "border-line-strong bg-surface text-ink hover:bg-sunken",
        primary: "border-accent bg-accent text-on-accent hover:opacity-90",
        danger: "border-danger bg-surface text-danger hover:bg-danger-soft",
        destroy: "border-danger bg-danger text-on-danger hover:opacity-90",
        code: "border-code-muted bg-code text-code-ink hover:bg-white/10",
      },
      size: { sm: "h-7 px-2.5 text-xs", md: "h-8 px-3 text-sm" },
    },
    defaultVariants: { tone: "outline", size: "md" },
  },
);

type ButtonProps = Omit<BaseButton.Props, "className"> & VariantProps<typeof buttonClass>;

export function Button({ tone, size, ...props }: ButtonProps) {
  return <BaseButton {...props} className={buttonClass({ tone, size })} />;
}

type Tone = "ok" | "warn" | "neutral" | "info" | "danger";

const TONE: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok-ink",
  warn: "bg-warn-soft text-warn-ink",
  neutral: "bg-neutral-soft text-neutral-ink",
  info: "bg-info-soft text-info-ink",
  danger: "bg-danger-soft text-danger-ink",
};

/** How one status is drawn: its colour and its shape. Its word is the contract's own, a citation's aside. */
export interface Look {
  readonly tone: Tone;
  readonly icon: LucideIcon;
}

export function Mark({ look, children }: { look: Look; children: ReactNode }) {
  const Icon = look.icon;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE[look.tone],
      )}
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      {children}
    </span>
  );
}

const STATUS: Record<Status, Look> = {
  confirmed: { tone: "ok", icon: CircleCheck },
  unconfirmed: { tone: "neutral", icon: Circle },
  superseded: { tone: "info", icon: CornerUpRight },
};

const REDACTED: Look = { tone: "danger", icon: EyeOff };

const FLAG: Record<FlagKind, Look> = {
  marked_stale: { tone: "warn", icon: Flag },
  possible_contradiction: { tone: "warn", icon: TriangleAlert },
  possible_duplicate: { tone: "warn", icon: CopyPlus },
  source_changed: { tone: "warn", icon: FileDiff },
};

const CITATION: Record<CitationClass, Look> = {
  checkable: { tone: "info", icon: LinkIcon },
  testimony: { tone: "neutral", icon: MessageSquareQuote },
};

const TRUST: Record<Trust, Look> = {
  reviewed: { tone: "ok", icon: ShieldCheck },
  unreviewed: { tone: "neutral", icon: Shield },
};

/** A fact's status in the contract's word, or "redacted" for a fact whose text is gone. */
export function StatusMark({ fact }: { fact: { status: Status; redacted: boolean } }) {
  if (fact.redacted) return <Mark look={REDACTED}>redacted</Mark>;
  return <Mark look={STATUS[fact.status]}>{fact.status}</Mark>;
}

/** A code of the contract as a person reads it: `marked_stale` reads "marked stale". */
export function inWords(code: string): string {
  return code.replaceAll("_", " ");
}

/** A text as it starts a sentence: its first letter in upper case. */
export function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A number of things, in words: "1 task", "3 tasks". */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

const TASK_STATE: Record<TaskState, Look> = {
  open: { tone: "neutral", icon: Circle },
  claimed: { tone: "info", icon: Hand },
  handed_off: { tone: "neutral", icon: Forward },
  done: { tone: "ok", icon: CircleCheck },
};

/** The states a task is shown in, in the order work moves through them. */
export const TASK_STATES = Object.keys(TASK_STATE) as TaskState[];

const LAPSED: Look = { tone: "warn", icon: TimerOff };

/** A task's state in the contract's word. A claimed task whose lease ran out is open again, and says why. */
export function TaskStateMark({ task }: { task: { state: TaskState; lapsed?: boolean } }) {
  if (task.lapsed === true) return <Mark look={LAPSED}>open · lease lapsed</Mark>;
  return <Mark look={TASK_STATE[task.state]}>{inWords(task.state)}</Mark>;
}

/** Who sees a record, as it is drawn: everyone on the server, or its person alone. */
export const SEEN_BY: Record<"private" | "shared", Look> = {
  shared: { tone: "info", icon: Users },
  private: { tone: "neutral", icon: Lock },
};

/** A record's flags, each in the contract's word. */
export function FlagMarks({ flags }: { flags: readonly FlagKind[] }) {
  return flags.map((kind) => (
    <Mark key={kind} look={FLAG[kind]}>
      {inWords(kind)}
    </Mark>
  ));
}

export function TrustMark({ trust }: { trust: Trust }) {
  return <Mark look={TRUST[trust]}>{trust}</Mark>;
}

/**
 * A citation's class in the words a person reads (`CITATION_WORD`), with the reason when it is
 * testimony, drawn in no colour a confirmation has: nothing checked it.
 */
export function CitationMark({ of, reason }: { of: CitationClass; reason?: string }) {
  const word = CITATION_WORD[of];
  return <Mark look={CITATION[of]}>{reason === undefined ? word : `${word} · ${reason}`}</Mark>;
}

/** A link that narrows a list, among its alternatives; the one in force is marked `aria-current`. */
export const FILTER_LINK =
  "inline-flex h-8 items-center rounded-md border border-line-strong bg-surface px-3 font-medium hover:bg-sunken aria-[current]:border-accent aria-[current]:bg-accent-soft aria-[current]:text-accent-ink";

/** How a dialog that asks before a change is drawn: centred, over a dimmed page. */
const DIALOG = {
  backdrop: "fixed inset-0 bg-black/40",
  popup:
    "fixed top-1/2 left-1/2 w-[28rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-lg border border-line bg-surface p-5 shadow-xl",
} as const;

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The button that opens the dialog, and what it says. */
  readonly trigger: ReactElement;
  readonly triggerText: ReactNode;
  readonly title: string;
  /** What the change does, said before it is made. */
  readonly children: ReactNode;
  /** Why the change last failed, where it did. */
  readonly failure?: ReactNode;
  /** The words of the button that leaves things as they are. */
  readonly keep: string;
  /** The button that makes the change. */
  readonly change: {
    readonly text: string;
    readonly tone: "primary" | "destroy";
    readonly disabled?: boolean;
    readonly onClick: () => void;
  };
  /** Where the focus goes when the dialog closes, where not back to its button. */
  readonly finalFocus?: AlertDialog.Popup.Props["finalFocus"];
}

/** A change a person is asked about before it is made: what it does, and the two ways out. */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const { change } = props;
  return (
    <AlertDialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialog.Trigger render={props.trigger}>{props.triggerText}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop forceRender className={DIALOG.backdrop} />
        <AlertDialog.Popup finalFocus={props.finalFocus} className={DIALOG.popup}>
          <AlertDialog.Title className="text-base font-semibold">{props.title}</AlertDialog.Title>
          <AlertDialog.Description>{props.children}</AlertDialog.Description>
          {props.failure}
          <div className="flex justify-end gap-2">
            <AlertDialog.Close render={<Button />}>{props.keep}</AlertDialog.Close>
            <Button tone={change.tone} disabled={change.disabled} onClick={change.onClick}>
              {change.text}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** What a change that asks first needs of the mutation that makes it. */
interface Mutation {
  mutate(variables: void, options: { onSuccess: () => void }): void;
  reset(): void;
  readonly isError: boolean;
  readonly isPending: boolean;
  readonly error: unknown;
}

interface ChangeDialogProps {
  readonly mutation: Mutation;
  readonly trigger: ReactElement;
  readonly triggerText: ReactNode;
  readonly title: string;
  /** What the change does, said before it is made. */
  readonly children: ReactNode;
  readonly keep: string;
  /** The words of the button that makes the change. */
  readonly text: string;
  readonly finalFocus?: ConfirmDialogProps["finalFocus"];
}

/**
 * A change that cannot be undone, asked about before it is made: the dialog opens, shows why the
 * last try failed, and closes itself when the mutation succeeds.
 */
export function ChangeDialog({ mutation, text, ...rest }: ChangeDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <ConfirmDialog
      {...rest}
      open={open}
      onOpenChange={(next) => {
        if (next) mutation.reset();
        setOpen(next);
      }}
      failure={mutation.isError ? <ErrorPanel error={mutation.error} /> : null}
      change={{
        text,
        tone: "destroy",
        disabled: mutation.isPending,
        onClick: () => mutation.mutate(undefined, { onSuccess: () => setOpen(false) }),
      }}
    />
  );
}

export function Card({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <section aria-label={label} className="rounded-lg border border-line bg-surface">
      {children}
    </section>
  );
}

/** A time as "4 minutes ago", with the exact time for whoever asks. */
export function Ago({ at }: { at: string }) {
  const date = new Date(at);
  return (
    <time dateTime={at} title={date.toLocaleString()}>
      {formatDistanceToNowStrict(date, { addSuffix: true })}
    </time>
  );
}

export function CopyButton({ text, label, tone }: { text: string; label: string; tone?: "code" }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => void navigator.clipboard.writeText(text).then(() => setCopied(true));
  const Icon = copied ? Check : Copy;
  return (
    <>
      <Button size="sm" tone={tone} aria-label={`Copy ${label}`} onClick={copy}>
        <Icon aria-hidden className="size-3" />
        {copied ? "Copied" : "Copy"}
      </Button>
      <span role="status" className="sr-only">
        {copied ? `Copied ${label}` : ""}
      </span>
    </>
  );
}

/** How a command or a name is drawn inside a sentence. */
export const INLINE_CODE = "rounded-sm bg-neutral-soft px-1 py-0.5 font-mono text-[0.8125rem]";

/** A sentence the server says, with what it puts in backticks shown as code. */
export function Said({ text }: { text: string }) {
  return text.split("`").map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className={INLINE_CODE}>
        {part}
      </code>
    ) : (
      part
    ),
  );
}

/** Text a person copies or types: a command, a URL, a configuration. It wraps and never scrolls. */
export function CodeBlock({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex items-start gap-3 rounded-md bg-code p-3 text-code-ink [--focus:var(--focus-on-code)]">
      <pre className="min-w-0 flex-1 font-mono text-[0.8125rem] leading-relaxed break-words whitespace-pre-wrap">
        <code>{text}</code>
      </pre>
      <CopyButton text={text} label={label} tone="code" />
    </div>
  );
}

/** A failure in its three parts: what happened, what it means, what to do next. */
export function ErrorPanel({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const parts = partsOf(error);
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-lg border border-danger bg-danger-soft p-4 text-danger-ink"
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="space-y-1">
        <p className="font-semibold">{parts.what}</p>
        <p>{parts.meaning}</p>
        <p>{parts.next}</p>
        {parts.retry && onRetry !== undefined ? (
          <p className="pt-1">
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** What a page reads of a query to show where it stands. */
interface Queried<T> {
  readonly data: T | undefined;
  readonly isError: boolean;
  readonly error: unknown;
  refetch(): unknown;
}

/**
 * A query's failure, with the button that asks again. `inset` is the padding it takes inside a
 * card.
 */
export function QueryFailed({ query, inset }: { query: Queried<unknown>; inset?: string }) {
  const panel = <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />;
  return inset === undefined ? panel : <div className={inset}>{panel}</div>;
}

/**
 * Where a query stands: "Loading" the `what` until it has its data, its failure with a retry, and
 * once it has the data, what `children` makes of it.
 */
export function QueryState<T>(props: {
  query: Queried<T>;
  what: string;
  inset?: string;
  children: (data: T) => ReactNode;
}) {
  const { query } = props;
  if (query.isError) return <QueryFailed query={query} inset={props.inset} />;
  if (query.data === undefined) return <Loading what={props.what} />;
  return props.children(query.data);
}

export function Loading({ what }: { what: string }) {
  return (
    <p role="status" className="p-4 text-ink-muted">
      Loading {what}…
    </p>
  );
}

/** An empty page: one sentence and at most one action. */
export function Empty({ sentence, children }: { sentence: string; children?: ReactNode }) {
  return (
    <div className="space-y-3 p-6 text-center">
      <p className="text-ink-muted">{sentence}</p>
      {children}
    </div>
  );
}

/** An empty page's action when it is something to say to an agent: the words, and a button that copies them. */
export function ToSay({ text, label }: { text: string; label: string }) {
  return (
    <p className="flex flex-wrap items-center justify-center gap-2">
      <span>“{text}”</span>
      <CopyButton text={text} label={label} />
    </p>
  );
}
