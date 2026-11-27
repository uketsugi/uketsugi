/** What the Activity page is shown: per-client counts and the person's recent sessions. */
import type { ActivityReport } from "@uketsugi/contracts";
import { PROJECT } from "./fixtures.ts";

export const activity: ActivityReport = {
  since: "2026-11-06T00:00:00Z",
  clients: [
    {
      client: "claude-code",
      version: "2.1.0",
      sessions: 12,
      searched: 9,
      published: 7,
      refused: 1,
    },
    { client: "antigravity", version: null, sessions: 30, searched: 28, published: 25, refused: 0 },
  ],
  recent: [
    {
      session: "s-7f2c",
      client: "claude-code",
      version: "2.1.0",
      project: PROJECT,
      first_call_at: "2026-11-13T09:00:00Z",
      last_call_at: "2026-11-13T09:20:00Z",
      last_search_at: "2026-11-13T09:01:00Z",
      last_publish_at: null,
      refused_calls: 2,
      note: null,
      digest: null,
    },
  ],
};

/** A session a language model read once it was over, and what the reading cost. */
export const readByModel: ActivityReport["recent"][number] = {
  session: "s-41ab",
  client: "claude-code",
  version: "2.1.0",
  project: PROJECT,
  first_call_at: "2026-11-13T10:00:00Z",
  last_call_at: "2026-11-13T10:40:00Z",
  last_search_at: "2026-11-13T10:01:00Z",
  last_publish_at: null,
  refused_calls: 0,
  note: null,
  digest: { at: "2026-11-13T10:41:00Z", input_tokens: 4210, output_tokens: 380 },
};
