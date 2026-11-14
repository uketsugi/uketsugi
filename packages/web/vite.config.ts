import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The dashboard builds to `dist/`, which the server serves at its root: it answers every page
 * address with `index.html`, so assets are addressed from the root. Workspace packages resolve to
 * their source.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ["@uketsugi/source"] },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The tab's icon stays a file with a hashed name, as every asset is: nothing is inlined.
    assetsInlineLimit: 0,
    // The contract's index reads its tool schema at load; reading a property is not a side effect,
    // so the schema stays out of the bundle unless something here uses it.
    rolldownOptions: { treeshake: { propertyReadSideEffects: false } },
    // One file of script: React, the router, the data cache and the components, for every page.
    chunkSizeWarningLimit: 600,
  },
});
