import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The UI is served by Vite and the API by `wrangler dev`, with a proxy between
 * them. `npm run dev` starts both (see `scripts/dev.mjs`).
 *
 * The obvious alternative - `@cloudflare/vite-plugin`, one process - does not
 * work here: the plugin inspects the Worker's module graph in a runner that has
 * no `require`, and the MongoDB driver's CJS dependencies (`punycode/` via
 * `whatwg-url`) break it. Proxying costs one extra process and buys something
 * better anyway: the browser talks to exactly the `wrangler dev` Worker that
 * every integration test has been run against, rather than a second build of it.
 *
 * In production there is no proxy - `wrangler deploy` uploads `dist/` as static
 * assets and serves them from the same Worker.
 */
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/health": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
});
