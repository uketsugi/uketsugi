/** How every page test starts: a mocked server, the whole app at an address, and an axe check. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, configure, render } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { HANG_GUARD_MS } from "@uketsugi/testkit";
import axe from "axe-core";
import { http, HttpResponse, type JsonBodyType } from "msw";
import { setupServer } from "msw/node";
import { createElement } from "react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { App } from "../src/app.tsx";
import { activity } from "./activity-fixtures.ts";
import * as fixtures from "./fixtures.ts";

/** The language the real page declares; a test's document has none of its own. */
const page = readFileSync(join(import.meta.dirname, "../index.html"), "utf8");
const LANGUAGE = /<html lang="([a-z-]+)"/.exec(page)?.[1] ?? "";

/** A handler that answers one path of the API with a body, whatever the query. */
export function answer(path: string, body: JsonBodyType, status = 200) {
  return http.get(`*${path}`, () => HttpResponse.json(body, { status }));
}

/** The server every test starts from: someone is signed in and every page has something to show. */
export const api = setupServer(
  answer("/api/session", fixtures.session),
  answer("/api/capabilities", fixtures.capabilities),
  answer("/api/connect", fixtures.connect),
  answer("/api/projects", fixtures.projects),
  answer("/api/facts", { facts: [fixtures.retries, fixtures.idempotency], next: null }),
  answer(`/api/facts/${fixtures.retries.id}`, fixtures.retriesDetail),
  answer("/api/tasks", fixtures.tasks),
  answer(`/api/tasks/${fixtures.handedOff.id}`, fixtures.handedOffDetail),
  answer("/api/activity", activity),
  answer("/api/rulings", fixtures.rulings),
);

/** Runs the mocked server for a test file. A request no handler answers fails the test. */
export function mockApi(): void {
  beforeAll(() => {
    // A query that waits for the page finds it when it is there; a busy machine only makes that
    // later, so it gives up only at the hang guard.
    configure({ asyncUtilTimeout: HANG_GUARD_MS });
    api.listen({ onUnhandledFrame: "error" });
    document.documentElement.lang = LANGUAGE;
    // jsdom lays nothing out and draws nothing: it cannot scroll, which the router asks of it on
    // every navigation, and it has no canvas, which axe asks for when it measures text.
    window.scrollTo = () => undefined;
    HTMLCanvasElement.prototype.getContext = () => null;
  });
  afterEach(() => {
    cleanup();
    api.resetHandlers();
  });
  afterAll(() => api.close());
}

/** Opens the dashboard at an address and returns the person's keyboard and pointer. */
export function open(address: string): UserEvent {
  const user = userEvent.setup();
  render(createElement(App, { history: createMemoryHistory({ initialEntries: [address] }) }));
  return user;
}

/**
 * What axe finds wrong with the document as it stands, one line per rule; empty when nothing.
 * Contrast needs a layout, which jsdom has not: `tokens.test.ts` measures it on the tokens.
 */
export async function violations(): Promise<string[]> {
  const result = await axe.run(document.documentElement, {
    resultTypes: ["violations"],
    rules: { "color-contrast": { enabled: false } },
  });
  return result.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.html).join(" | ")}`,
  );
}
