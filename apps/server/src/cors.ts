import type { cors } from "hono/cors";

/**
 * CORS options for the server, kept in their own module so tests can assert
 * against the real configuration rather than a copy of it. `server.ts` cannot be
 * imported from a test — its first statement is the `./load-env.js` side-effect
 * import, which reads `secrets/.env` and builds the whole Mastra instance.
 *
 * The `@mastra/hono` adapter applies NO access-control handling (verified: zero
 * of it in its dist), unlike the `mastra dev` server. Studio's browser SPA
 * (:3000) calls this API at :4111 cross-origin, so we must supply it.
 *
 * CRITICAL: Studio sends its fetches with `credentials: 'include'`. Per the CORS
 * spec a credentialed request CANNOT use a wildcard `Access-Control-Allow-Origin`
 * — the browser blocks the *response* even though the preflight passes (hence the
 * symptom: "preflight 204, actual fetch CORS error"). So we ECHO the caller's
 * origin (not `*`) AND send `Access-Control-Allow-Credentials: true`. `origin` as
 * a function makes Hono reflect the request origin (+ `Vary: Origin`); the
 * `|| "*"` only covers no-Origin callers (curl/same-origin), where creds don't
 * apply.
 *
 * Covered by `test/hono-node-server.test.ts`.
 */
// `hono/cors` does not export its options type, so derive it from `cors` itself —
// that way this cannot drift from what the middleware actually accepts.
type CorsOptions = NonNullable<Parameters<typeof cors>[0]>;

export const corsOptions: CorsOptions = {
  origin: (origin) => origin || "*",
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "x-mastra-client-type", "x-mastra-dev-playground"],
  exposeHeaders: ["Content-Length", "X-Requested-With"],
};
