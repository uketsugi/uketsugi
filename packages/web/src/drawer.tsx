/**
 * One record's drawer beside its list, and the parts every drawer is made of. A drawer does not
 * take the page: the list stays in use behind it.
 */
import { Drawer } from "@base-ui/react/drawer";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { X } from "lucide-react";
import type { ReactNode } from "react";

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** What the drawer says of the record, one term and its value to a line. */
export function Details({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">{children}</dl>;
}

/** One term of `Details` and its value. */
export function Detail(props: { term: string; className?: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-muted">{props.term}</dt>
      <dd className={props.className}>{props.children}</dd>
    </>
  );
}

/** The record's own words: what the drawer is about, for whoever cannot see it. */
export function Lead({ children }: { children: ReactNode }) {
  return <Drawer.Description className="text-base font-semibold">{children}</Drawer.Description>;
}

const CLOSE =
  "inline-flex size-7 cursor-pointer items-center justify-center rounded-md border border-line-strong hover:bg-sunken";

const POPUP =
  "pointer-events-auto h-full w-[26rem] max-w-full [transform:translateX(var(--drawer-swipe-movement-x))] overflow-y-auto border-l border-line bg-surface shadow-xl outline-none transition-[translate] duration-200 data-ending-style:translate-x-full data-starting-style:translate-x-full motion-reduce:transition-none";

interface SideDrawerProps {
  /** What kind of record it shows, in one word: its heading and the name of its close button. */
  readonly name: string;
  /** Where the address names the record: its search parameter. */
  readonly param: "fact" | "task";
  /** The record's body, for its id. */
  readonly children: (id: string) => ReactNode;
}

/** The drawer of the record the address names; closing it takes the record out of the address. */
export function SideDrawer({ name, param, children }: SideDrawerProps) {
  const id = useSearch({ strict: false })[param];
  const navigate = useNavigate();
  const change = (next: boolean) => {
    if (!next) void navigate({ to: ".", search: (shown) => ({ ...shown, [param]: undefined }) });
  };
  // Closing returns the focus to the row that opened the drawer. A row that is gone, as after a
  // redaction, leaves the focus nowhere, so it goes to the page.
  const refocus = (next: boolean) => {
    if (!next && document.activeElement === document.body) document.getElementById("main")?.focus();
  };
  return (
    <Drawer.Root
      open={id !== undefined}
      onOpenChange={change}
      onOpenChangeComplete={refocus}
      swipeDirection="right"
      modal={false}
      disablePointerDismissal
    >
      <Drawer.Portal>
        <Drawer.Viewport className="pointer-events-none fixed inset-0 flex justify-end md:top-12">
          <Drawer.Popup className={POPUP}>
            <Drawer.Content className="space-y-5 p-5">
              <div className="flex items-center justify-between">
                <Drawer.Title className="text-xs font-semibold tracking-wider text-ink-muted uppercase">
                  {name}
                </Drawer.Title>
                <Drawer.Close aria-label={`Close the ${name.toLowerCase()}`} className={CLOSE}>
                  <X aria-hidden className="size-4" />
                </Drawer.Close>
              </div>
              {id === undefined ? null : children(id)}
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
