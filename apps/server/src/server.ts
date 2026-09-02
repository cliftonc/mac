// Load env from <repo-root>/secrets/.env BEFORE importing ./mastra — the Mastra
// instance reads config at module-evaluation time, and ESM evaluates imports in
// source order, so this side-effect import must be first. (See ./load-env.ts.)
import "./load-env.js";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { MastraServer, type HonoBindings, type HonoVariables } from "@mastra/hono";
import { corsOptions } from "./cors.js";
import { mastra, macRuntime } from "./mastra/index.js";

/**
 * Self-owned Hono server that EMBEDS Mastra (via `@mastra/hono`), replacing the
 * `mastra dev`-owned server.
 *
 * Why we own the server:
 *  - Hot-reload is ours (`tsx watch`): a file change kills the whole process and
 *    re-binds cleanly — no more `mastra dev` EADDRINUSE-on-restart (it never
 *    `closeAllConnections()`'d, so a held Studio keep-alive blocked the re-bind).
 *  - Long-running connectors (Slack Socket Mode, cron) can start at boot here,
 *    after `serve()`, instead of needing a server-start hook Mastra doesn't expose.
 *  - No `mastra build` step / `.mastra/output` — deploy is a vanilla Node app.
 *
 * `server.init()` mounts the Mastra-managed routes (`/api/agents/*`,
 * `/api/workflows/*`, …) AND the `server.apiRoutes` configured on the instance
 * (our `/webhooks/github`, `/approve`, `/cli/*`) — verified against the adapter
 * source: `routes = this.customApiRoutes ?? this.mastra.getServer()?.apiRoutes`.
 *
 * Studio is launched separately and points at this server:
 *   `pnpm -C apps/server studio`  →  `mastra studio -s 4111`
 */
const app = new Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>();

// CORS — the options live in `./cors.ts` (with the reasoning for echoing the
// caller's origin instead of `*`) so `test/hono-node-server.test.ts` can assert
// against the real configuration. Registered BEFORE init() so it also wraps the
// Mastra /api/* routes.
app.use("*", cors(corsOptions));

const server = new MastraServer({ app, mastra });
await server.init();

const port = Number(process.env.PORT ?? 4111);

serve({ fetch: app.fetch, port });

// Long-running connectors start AFTER the server is up. This is the payoff of
// owning the server: a Socket Mode WebSocket just starts here, gated on config —
// no server-start hook needed, and `mastra build` (which we no longer run) can't
// accidentally open the socket since this is the runtime entrypoint, not a
// module side-effect.
//
// `mac.runtime` is returned by `createMacApp` and combines all extension runtimes
// (currently: the Slack Socket Mode connector from `slack()`). Calling start()
// here delegates lifecycle ownership back to the extension that registered it.
if (macRuntime) {
  macRuntime.start().catch((err: unknown) => {
    console.error("[server] Runtime connector failed to start:", err);
  });
} else {
  console.log("[server] No runtime connectors configured (set SLACK_BOT_TOKEN + SLACK_APP_TOKEN to enable Slack)");
}
