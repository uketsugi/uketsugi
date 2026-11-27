/**
 * The shell every page sits in: the navigation, the top bar, the install's state, and the gate
 * that shows a page only to a signed-in person and the sign-in page to anyone else. A page this
 * build lacks is absent, never dimmed.
 */
import { Input } from "@base-ui/react/input";
import type { CapabilityDescriptor, DashboardSession } from "@uketsugi/contracts";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { cx } from "class-variance-authority";
import { CircleAlert, CircleCheck } from "lucide-react";
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { capabilitiesQuery, isSignedOut, sessionQuery, signIn, signOut } from "./api.ts";
import { Button, ErrorPanel, inWords, Loading, QueryFailed, Said } from "./ui.tsx";

const SessionContext = createContext<DashboardSession | null>(null);

/** Who is signed in. Every page renders inside the gate, so there is always someone. */
export function useSession(): DashboardSession {
  const session = use(SessionContext);
  if (session === null) throw new Error("a page was rendered outside the sign-in gate");
  return session;
}

/**
 * A change only the signed-in person makes: it is sent with their CSRF value, and what it changes
 * is asked for again once it has been made.
 */
export function useChange<V = void>(
  send: (csrf: string, variables: V) => Promise<unknown>,
  refresh: (client: QueryClient) => Promise<unknown>,
) {
  const { csrf } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (variables: V) => send(csrf, variables),
    onSuccess: () => refresh(client),
  });
}

const NAV = [
  {
    heading: null,
    pages: [
      { to: "/facts", name: "Facts" },
      { to: "/tasks", name: "Tasks" },
      { to: "/activity", name: "Activity" },
    ],
  },
  {
    heading: "This install",
    pages: [
      { to: "/projects", name: "Projects" },
      { to: "/groups", name: "Groups" },
      { to: "/your-data", name: "Your data" },
      { to: "/connect", name: "Connect" },
    ],
  },
] as const;

const NAV_LINK =
  "block rounded-md px-3 py-1.5 text-ink hover:bg-sunken aria-[current=page]:bg-accent-soft aria-[current=page]:font-semibold aria-[current=page]:text-accent-ink";

function Navigation() {
  return (
    <nav aria-label="Pages" className="flex-1 space-y-4 px-3">
      <p className="flex items-center gap-2 px-3 pt-4 text-base font-semibold">
        <span aria-hidden className="size-4 rounded-sm bg-accent" />
        uketsugi
      </p>
      {NAV.map((group) => (
        <div key={group.heading ?? "main"}>
          {group.heading === null ? null : (
            <p className="px-3 pb-1 text-xs font-semibold tracking-wider text-ink-muted uppercase">
              {group.heading}
            </p>
          )}
          <ul className="space-y-0.5">
            {group.pages.map((page) => (
              <li key={page.to}>
                <Link to={page.to} className={NAV_LINK}>
                  {page.name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** The install's state: ready, or each thing the server says is incomplete, by its code in words. */
function InstallState({ server }: { server: CapabilityDescriptor | undefined }) {
  if (server === undefined) return null;
  const ready = server.degraded.length === 0;
  const Icon = ready ? CircleCheck : CircleAlert;
  return (
    <footer className="space-y-1 border-t border-line px-6 py-3 text-xs text-ink-muted">
      <p className="flex items-start gap-1.5">
        <Icon aria-hidden className="mt-0.5 size-3 shrink-0" />
        {ready ? "server ready" : server.degraded.map(inWords).join("; ")}
      </p>
      <p>contract {server.contract_version}</p>
    </footer>
  );
}

function TopBar({ edition }: { edition: string | undefined }) {
  const session = useSession();
  const client = useQueryClient();
  const leave = useMutation({
    mutationFn: () => signOut(session.csrf),
    onSuccess: () => client.resetQueries({ queryKey: sessionQuery.queryKey }),
  });
  return (
    <header className="flex h-12 items-center justify-end gap-3 border-b border-line px-6">
      {edition === undefined ? null : (
        <span className="rounded-full border border-line-strong px-2.5 py-0.5 text-xs font-medium capitalize">
          {edition}
        </span>
      )}
      <span className="text-ink-muted">{session.person}</span>
      <Button size="sm" onClick={() => leave.mutate()} disabled={leave.isPending}>
        Sign out
      </Button>
    </header>
  );
}

function Shell() {
  const server = useQuery(capabilitiesQuery).data;
  const pathname = useLocation({ select: (location) => location.pathname });
  const main = useRef<HTMLElement>(null);
  const shown = useRef(pathname);
  // A new page takes the focus, so a keyboard or a screen reader starts at its top.
  useEffect(() => {
    if (shown.current === pathname) return;
    shown.current = pathname;
    main.current?.focus();
  }, [pathname]);
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <a
        href="#main"
        className="sr-only rounded-md bg-surface px-3 py-2 focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10"
        onClick={(event) => {
          event.preventDefault();
          main.current?.focus();
        }}
      >
        Skip to the page
      </a>
      <div className="flex shrink-0 flex-col border-line bg-sidebar max-md:border-b md:w-56 md:border-r">
        <Navigation />
        <InstallState server={server} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar edition={server?.edition} />
        <main id="main" ref={main} tabIndex={-1} className="flex-1 px-6 py-6 outline-none lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Alone({ children }: { children: ReactNode }) {
  return <main className="mx-auto max-w-xl space-y-3 px-6 py-16">{children}</main>;
}

/**
 * Signs in with the person's dashboard key: how a person on another machine than the server's
 * reaches the dashboard. It is theirs alone; the token a harness sends does not sign in. A key
 * the server does not know is answered here, in the server's words.
 */
function KeySignIn() {
  const client = useQueryClient();
  const [key, setKey] = useState("");
  const [state, setState] = useState<{ pending: boolean; failure?: unknown }>({ pending: false });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setState({ pending: true });
    signIn(key).then(
      () => client.resetQueries({ queryKey: sessionQuery.queryKey }),
      (failure: unknown) => setState({ pending: false, failure }),
    );
  };
  return (
    <form onSubmit={submit} className="space-y-3 pt-3">
      <label htmlFor="key" className="block font-medium">
        Your dashboard key
      </label>
      <Input
        id="key"
        type="password"
        autoComplete="off"
        required
        value={key}
        onChange={(event) => setKey(event.target.value)}
        className="h-8 w-full rounded-md border border-line-strong bg-surface px-3 font-mono"
      />
      <Button type="submit" tone="primary" disabled={state.pending}>
        Sign in
      </Button>
      {state.failure === undefined ? null : <ErrorPanel error={state.failure} />}
    </form>
  );
}

/**
 * The sign-in page: the two ways in, in the page's own words. The server refuses a browser without
 * a session as it refuses any request, and that answer is no failure to a person who has not
 * signed in yet, so it is not shown. `ended` says someone was signed in on this page and no
 * longer is, which is said first.
 */
function SignIn({ ended }: { ended: boolean }) {
  const capabilities = useQuery(capabilitiesQuery);
  if (capabilities.isPending)
    return (
      <Alone>
        <Loading what="the way in" />
      </Alone>
    );
  if (capabilities.isError) {
    return (
      <Alone>
        <QueryFailed query={capabilities} />
      </Alone>
    );
  }
  const { sign_in, key_form } = capabilities.data.dashboard;
  return (
    <Alone>
      <title>Sign in · Uketsugi</title>
      <h1 className="text-xl font-semibold">
        {ended ? "You are signed out" : "Sign in to Uketsugi"}
      </h1>
      {ended ? <p>This browser’s session has ended. Sign in again to carry on.</p> : null}
      {sign_in.map((way) => (
        <p key={way}>
          <Said text={way} />
        </p>
      ))}
      {key_form ? <KeySignIn /> : null}
    </Alone>
  );
}

/** The root of every route: the shell for a signed-in person, the sign-in page for anyone else. */
export function Gate() {
  const session = useQuery(sessionQuery);
  // Asking the session again forgets the last answer, so the page keeps whether it ever had one.
  const [signedInBefore, setSignedInBefore] = useState(false);
  if (session.isSuccess && !signedInBefore) setSignedInBefore(true);
  if (session.isPending) {
    return (
      <Alone>
        <Loading what="the dashboard" />
      </Alone>
    );
  }
  if (session.isError) {
    if (isSignedOut(session.error)) return <SignIn ended={signedInBefore} />;
    return (
      <Alone>
        <QueryFailed query={session} />
      </Alone>
    );
  }
  return (
    <SessionContext value={session.data}>
      <Shell />
    </SessionContext>
  );
}

/**
 * A page's frame: the document title, the heading and one line on what the page is for. With
 * `drawerOpen`, a wide screen leaves a record's drawer its width beside the page, not over it: the
 * drawer's 26rem, less the margin the page already has, and a gap.
 */
export function Page(props: {
  title: string;
  lead: string;
  drawerOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cx("space-y-5", props.drawerOpen === true && "xl:pr-[25.25rem]")}>
      <title>{`${props.title} · Uketsugi`}</title>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{props.title}</h1>
        <p className="text-ink-muted">{props.lead}</p>
      </div>
      {props.children}
    </div>
  );
}
