import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import type { Server } from "node:http";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { corsOptions } from "../src/cors.js";

/**
 * Adapter-level coverage for `@hono/node-server`.
 *
 * `src/server.ts` is the only consumer of the adapter, and nothing else here can
 * reach it: `pnpm -r typecheck` proves the call signature but never executes it,
 * and every other test in the workspace runs against `app.fetch` directly, which
 * bypasses the Node bridge entirely. So the whole of the adapter's job — turning
 * `IncomingMessage` into `Request` and a `Response` back into `ServerResponse` —
 * is untested by construction.
 *
 * That gap is what made the v1 -> v2 upgrade hard to judge: v2 rewrote exactly
 * that bridge (the LightweightRequest/LightweightResponse fast paths). These
 * tests pin the four behaviours `src/server.ts` actually depends on, so the next
 * adapter bump is a test run rather than a code read.
 */

const require_ = createRequire(import.meta.url);

/** The adapter's own dist is ESM-only with no `./package.json` export, so read the version off the resolved file path's package root. */
function versionOf(specifier: string, from: NodeJS.Require = require_): string {
  const entry = from.resolve(specifier);
  const marker = `/node_modules/${specifier}/`;
  const root = entry.slice(0, entry.lastIndexOf(marker) + marker.length);
  return from(`${root}package.json`).version as string;
}

const major = (version: string): number => Number(version.split(".")[0]);

const servers: Server[] = [];

function listen(app: Hono): Promise<{ base: string; server: Server }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve({ base: `http://127.0.0.1:${info.port}`, server });
    }) as unknown as Server;
    servers.push(server);
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

describe("@hono/node-server adapter", () => {
  it("is off the v1 line", () => {
    // Guards the assumption the rest of this file is written against. v2 dropped
    // Node 18 (we require >=22) and removed `@hono/node-server/vercel`, which
    // this repo never imported. Asserted as ">= 2" rather than "^2" so a future
    // major does not fail here spuriously — it only has to keep these four
    // behaviours, which the rest of this file checks directly.
    expect(major(versionOf("@hono/node-server"))).toBeGreaterThanOrEqual(2);
  });

  it("serves a route through serve({ fetch, port })", async () => {
    const app = new Hono();
    app.get("/ping", (c) => c.text("pong"));

    const { base } = await listen(app);
    const res = await fetch(`${base}/ping`);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pong");
  });

  it("echoes the request Origin with credentials, as Studio requires", async () => {
    // `src/server.ts` deliberately echoes the caller's Origin instead of `*`,
    // because Studio fetches with `credentials: 'include'` and the CORS spec
    // forbids a wildcard on a credentialed response. Uses the real options object
    // rather than a copy, so this fails if the production config drifts.
    const app = new Hono();
    app.use("*", cors(corsOptions));
    app.get("/ping", (c) => c.text("pong"));

    const { base } = await listen(app);

    const res = await fetch(`${base}/ping`, { headers: { Origin: "http://localhost:3000" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("vary")).toContain("Origin");

    const preflight = await fetch(`${base}/ping`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "content-type,x-mastra-client-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("x-mastra-client-type");
  });

  it("round-trips a JSON request body", async () => {
    const app = new Hono();
    app.post("/echo", async (c) => c.json(await c.req.json()));

    const { base } = await listen(app);
    const res = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world", n: 42 }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "world", n: 42 });
  });

  it("streams a ReadableStream response without buffering it", async () => {
    // Agent responses are streamed, so the adapter must hand each chunk to the
    // client as it is enqueued. Asserting on the collected body would pass just
    // as happily against a buffered response, so this holds the second chunk back
    // and requires the first to have already arrived — which only happens if the
    // adapter is not waiting for the stream to finish.
    const HOLD_MS = 150;
    let releaseSecondChunk = () => {};
    const secondChunkReleased = new Promise<void>((r) => {
      releaseSecondChunk = r;
    });

    const app = new Hono();
    app.get("/stream", () => {
      const enc = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode("data: one\n\n"));
          void secondChunkReleased.then(() => {
            controller.enqueue(enc.encode("data: two\n\n"));
            controller.close();
          });
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    });

    const { base } = await listen(app);
    const res = await fetch(`${base}/stream`);

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // Chunked, i.e. no up-front Content-Length — a buffered response would have one.
    expect(res.headers.get("content-length")).toBeNull();

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: one\n\n");

    // Only now does the handler enqueue the rest; the read above cannot have been
    // waiting on it.
    setTimeout(releaseSecondChunk, HOLD_MS);
    let rest = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toBe("data: two\n\n");
  });
});

describe("@hono/node-ws over the adapter", () => {
  // `@hono/node-ws@1.3.1` declares `peerDependencies: { "@hono/node-server": "^1.19.11" }`
  // and has no 2.x-compatible release, so `pnpm install` reports it as an unmet
  // peer. `.npmrc` sets `strict-peer-dependencies=false`, which means that warning
  // is the ONLY signal — nothing fails. It reaches us through `@mastra/hono`
  // (a runtime dependency) inside its `setupBrowserStream()` helper.
  //
  // In practice the declared range is conservative metadata: node-ws imports only
  // `hono/ws`, `ws` and `node:http`, and couples to the adapter solely through the
  // `http.Server` that `serve()` returns. This test is the evidence for that, so
  // the claim is re-checked on every run instead of living in a PR description.
  //
  // node-ws is not a direct dependency here, so resolve it the way `@mastra/hono`
  // does. If that ever stops resolving, `setupBrowserStream` has stopped working too.
  const fromMastraHono = createRequire(require_.resolve("@mastra/hono"));
  const fromNodeWs = createRequire(fromMastraHono.resolve("@hono/node-ws"));

  it("resolves the peer that pnpm warns about to the v2 adapter", () => {
    // Still on the 1.x line — i.e. the premise of this block (an unmet peer) still holds.
    expect(versionOf("@hono/node-ws", fromMastraHono)).toMatch(/^1\./);
    expect(major(versionOf("@hono/node-server", fromNodeWs))).toBeGreaterThanOrEqual(2);
  });

  it("completes a WebSocket handshake and message round trip", async () => {
    const { createNodeWebSocket } = fromMastraHono("@hono/node-ws");
    const WsClient = fromNodeWs("ws");

    const app = new Hono();
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

    const serverSaw: string[] = [];
    app.get(
      "/ws",
      upgradeWebSocket(() => ({
        onOpen(_event: unknown, ws: { send(data: string): void }) {
          serverSaw.push("open");
          ws.send("hello-from-server");
        },
        onMessage(event: { data: unknown }, ws: { send(data: string): void }) {
          serverSaw.push(`message:${String(event.data)}`);
          ws.send(`echo:${String(event.data)}`);
        },
        onClose() {
          serverSaw.push("close");
        },
      })),
    );

    const { base, server } = await listen(app);
    injectWebSocket(server);

    const received: string[] = [];
    const client = new WsClient(`${base.replace("http://", "ws://")}/ws`);
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => client.send("ping-from-client"));
      client.on("message", (data: unknown) => {
        received.push(String(data));
        if (received.length === 2) client.close();
      });
      client.on("close", () => resolve());
      client.on("error", reject);
    });

    expect(received).toEqual(["hello-from-server", "echo:ping-from-client"]);
    expect(serverSaw).toContain("open");
    expect(serverSaw).toContain("message:ping-from-client");
  });
});
