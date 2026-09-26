import { defineConfig, createLogger } from "vite";

// The game reaches server.py (the local graph sampler) through /api, which
// only ever proxies to localhost. When server.py isn't running the game uses
// its built-in in-browser sampler -- an expected state, not an error -- so
// collapse Vite's per-request proxy stack traces into one short,
// rate-limited notice.
const logger = createLogger();
const logError = logger.error.bind(logger);
let lastNotice = 0;
logger.error = (msg, options) => {
  if (typeof msg === "string" && msg.includes("http proxy error")) {
    const now = Date.now();
    if (now - lastNotice > 30_000) {
      lastNotice = now;
      logger.warn("[api] server.py (local sampler on :8000) not reachable -- game is using its in-browser sampler", {
        timestamp: true,
      });
    }
    return;
  }
  logError(msg, options);
};

const apiProxy = { "/api": { target: "http://127.0.0.1:8000", changeOrigin: true } };

export default defineConfig({
  customLogger: logger,
  // One bundle is fine for a single-page game; three.js alone is ~500 kB.
  build: { chunkSizeWarningLimit: 800 },
  server: { port: 5173, proxy: apiProxy },
  preview: { port: 4173, proxy: apiProxy },
});
