import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, type RouterHistory } from "@tanstack/react-router";
import { useState } from "react";
import { isSignedOut, sessionQuery } from "./api.ts";
import { createAppRouter } from "./router.tsx";

/**
 * The data cache. A failure is shown with its own "Try again", so nothing retries by itself; a
 * request refused because the cookie ended asks the session again, which shows the sign-in page.
 */
function createQueryClient(): QueryClient {
  const askSession = (error: unknown) => {
    if (isSignedOut(error)) void client.resetQueries({ queryKey: sessionQuery.queryKey });
  };
  const client = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (query.queryKey[0] !== sessionQuery.queryKey[0]) askSession(error);
      },
    }),
    mutationCache: new MutationCache({ onError: askSession }),
    defaultOptions: { queries: { retry: false } },
  });
  return client;
}

/** The dashboard. `history` is the address bar's unless a test passes its own. */
export function App({ history }: { history?: RouterHistory }) {
  const [client] = useState(createQueryClient);
  const [router] = useState(() => createAppRouter(history));
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
