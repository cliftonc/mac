# Last Light → Mastra migration log

This repo re-implements [`lastlight`](../lastlight) (a GitHub repo-maintenance agent) as an
idiomatic [Mastra](https://mastra.ai) v1 app. We copy code/config from lastlight as needed,
keep things as close to vanilla Mastra as possible, and **drop misfits with a note here**.

Source of truth for lastlight's behavior: `../lastlight/spec/` and `../lastlight/CLAUDE.md`.

## Status

- **M1 — Scaffold (DONE):** pnpm monorepo (Turbo removed — see gotchas); `apps/maintenance`
  is the deployable Mastra unit. `pnpm -C apps/maintenance build` (= `mastra build -d src/mastra`)
  produces a Hono server in `.mastra/output/`; `node --env-file=.env .mastra/output/index.mjs`
  boots ("Mastra API running at http://localhost:4111/api"). Assets (prompts, skills,
  agent-context, `.env`, PEM) copied from lastlight.
- **M2 — Chat agent (DONE, verified live):** `src/mastra/agents/chat.ts` — Mastra `Agent`
  with persona from `agent-context/*.md`, LibSQL `Memory` (thread per conversation), and the
  read-only GitHub tools from `packages/github`. Verified: asked it to look up
  `cliftonc/lastlight#1`, it called `github_get_issue` (via the minted GitHub-App token) and
  returned the real title/state. Provider OpenAI (`gpt-5.1`).
- **M3 — pr-review workflow + real sandbox (DONE, verified live):** posted a real review to
  `cliftonc/lastlight#69` (`last-light-bot[bot]`, COMMENTED). Details below.
- **M4 — build workflow:** in progress.
- **M5–M7:** see `../../.claude/plans/ok-we-have-a-splendid-fairy.md`.

## Packages

- **`apps/maintenance`** — the deployable Mastra app. `src/mastra/index.ts` builds the
  `Mastra` instance (storage, logger, agents, workflows). `config.ts` (env-based config),
  `memory.ts` (LibSQL Memory), `agent-context.ts` (persona loader), `workspace.ts`
  (LocalFilesystem+LocalSandbox), `agents/` (chat, reviewer, sandbox-probe), `workflows/`
  (pr-review).
- **`packages/github`** — ported from lastlight, framework-agnostic + Mastra tools:
  - `profiles.ts` — `GitAccessProfile`, `GITHUB_PERMISSION_PROFILES`, `resolveProfile` (verbatim).
  - `auth.ts` — `mintInstallationToken` / `mintTokenForProfile` (RS256 app JWT → installation
    token, per-profile downscoping). **Dropped** lastlight's `~/.gitconfig` credential-helper
    writing — the sandbox gets the token via env.
  - `client.ts` — `createInstallationOctokit` / `createTokenOctokit`.
  - `tools.ts` — read-only Mastra tools: `github_read_file`, `github_get_issue`,
    `github_list_issue_comments`, `github_search_issues`, `github_get_pull_request_diff`.
  - `write-tools.ts` — `postPullRequestReview()` (+ `github_post_review` tool) with a COMMENT
    fallback when APPROVE/REQUEST_CHANGES is rejected on the bot's own PR.

## M3 detail (pr-review)

- Real Mastra `Workspace` via `@mastra/core/workspace` (`LocalFilesystem` + `LocalSandbox`)
  in `workspace.ts`. Verified the sandbox runs shell: a probe agent ran `echo … && pwd` via
  `mastra_workspace_execute_command`.
- `agents/reviewer.ts` — read-only review agent (diff + file tools + sandbox). It does NOT
  post; it emits a `VERDICT: APPROVE|REQUEST_CHANGES|COMMENT` marker + markdown body
  (`parseVerdict`).
- `workflows/pr-review.ts` — `createWorkflow({id,inputSchema,outputSchema}).then(review).commit()`.
  The step mints a `review-write` token, runs the agent, then **posts the review
  deterministically** from the workflow via `postPullRequestReview()` — not via the agent's
  tool loop.
- **Two bugs the live test caught & fixed:**
  1. *Agent non-determinism* — the agent sometimes narrated a review instead of calling the
     post tool, so nothing posted. Fix: verdict-marker + workflow-posts split (mirrors
     lastlight's reviewer-emits-verdict / orchestrator-acts design).
  2. *Self-approval* — GitHub rejects APPROVE/REQUEST_CHANGES on the bot's own PR. Fallback
     to a COMMENT review.

## Pinned Mastra API signatures (verified against installed packages, not docs)

Installed: `@mastra/core` **1.37.1**, `@mastra/libsql` 1.11.1, `@mastra/loggers` 1.1.1,
`@mastra/memory` 1.20.0, `mastra` (CLI) 1.10.2, `ai` 6.x, `@ai-sdk/openai` 3.x, `zod` 4.x.

- **Entry:** `new Mastra({ storage, logger, agents, workflows, /* server, observability */ })`
  from `@mastra/core`.
- **Agent:** `new Agent({ id, name, instructions, model, tools?, memory?, workspace? })` from
  `@mastra/core/agent`. **`id` is required.** `model` is a router string (e.g. `'openai/gpt-4o'`).
  Passing `workspace` auto-adds `mastra_workspace_execute_command` + file tools.
- **Tools:** `createTool({ id, description, inputSchema, outputSchema, execute })` from
  `@mastra/core/tools`. **`execute` is `(inputData, context) =>`** — input is the FIRST arg
  (not `{ context }`).
- **Workflows:** `createWorkflow({ id, inputSchema, outputSchema })` + `createStep({ id,
  inputSchema, outputSchema, execute })` from `@mastra/core/workflows`. Build with
  `.then(step).commit()`. Step `execute` is `async ({ inputData }) => ...`.
  REST: `POST /api/workflows/:id/create-run` → `{runId}`, then
  `POST /api/workflows/:id/start-async?runId=<id>` with body `{"inputData":{…}}` (runId is a
  QUERY param; `start` is fire-and-forget, `start-async` returns the finished result).
  Loop/branch/suspend method names to pin in M4.
- **Workspace/Sandbox:** `Workspace`, `LocalFilesystem`, `LocalSandbox` from
  `@mastra/core/workspace` (NOT the main entry; the `@mastra/workspace-*` packages aren't
  published at this version). `LocalSandbox({ workingDirectory, env, timeout })`,
  `LocalFilesystem({ basePath })`.
- **Server routes:** `registerApiRoute(path, options)` from `@mastra/core/server` — path is
  the FIRST positional arg; options `{ method, handler, middleware?, requiresAuth?, openapi? }`,
  `handler` is a Hono `Handler`. (For M5.)
- **Storage:** `new LibSQLStore({ id, url })` from `@mastra/libsql`. **`id` is required.**
- **Logger:** `PinoLogger` from `@mastra/loggers`.

### Peer-dep notes
`@mastra/core` pulls AI-SDK utils that peer-depend on `zod@^3`, but we use `zod@4`. Install
warns; build/typecheck/runtime pass so far. Revisit if zod-schema tools misbehave.

`@hono/node-ws@1.3.1` peer-depends on `@hono/node-server@^1.19.11`, but we run the adapter
at v2, so install warns `✕ unmet peer @hono/node-server@^1.19.11: found 2.x`. node-ws has no
2.x-compatible release. It arrives via two paths, and only one of them pairs it with v2:

- `@mastra/hono` (a runtime dep) → node-ws, inside its `setupBrowserStream()` helper. This
  is the pairing the warning is about. Nothing here calls `setupBrowserStream`, and the
  range is conservative anyway — node-ws imports `hono/ws`, `ws` and `node:http` only, and
  couples to the adapter solely through the `http.Server` that `serve()` returns, which v2
  still returns. `apps/server/test/hono-node-server.test.ts` runs a real handshake over the
  combination, so this is checked rather than assumed.
- `mastra` (a devDep, for `mastra studio`) → `@mastra/deployer` → node-ws. Not affected:
  `@mastra/deployer` bundles its own copy of node-server 1.19.14 inline, so node-ws is
  handed a v1 server there regardless of what we resolve.

Revisit if node-ws ships a 2.x peer range.

## Gotchas hit (and fixes)

- **`pnpm: command not found`** — pnpm isn't global; this machine uses nvm. `mastra build`'s
  deploy step shells out to `pnpm install`, so pnpm must be on PATH. Fix: `corepack enable`.
- **libsql "error 14"** — LibSQL creates the file but not the parent dir, and `mastra
  dev`/`build` run from `.mastra/output`, so a relative `./data/...` misses. Fix: resolve an
  ABSOLUTE db path from `LASTLIGHT_DB_URL`/`LASTLIGHT_STATE_DIR` (set in `.env`).
- **Turbo `WARNING IO error: No such file or directory`** — cosmetic cache-write warning;
  build still succeeds. Removed Turbo entirely (it's a task runner, not a bundler — unrelated
  to vite/turbopack); root scripts delegate via `pnpm -C apps/maintenance <script>`.
- **`mastra dev|build` need `-d src/mastra`** — entry isn't at the default path.
- **`dev` from repo root** — must run from `apps/maintenance` (`pnpm -C apps/maintenance dev`).
- **Eager secret reads crash boot** — building the Octokit (reads the PEM) at module load
  took down the server when the PEM path was relative/missing. Fix: wrap GitHub-tool init in
  try/catch (boot never fails on an optional secret) + copy PEM to absolute `secrets/app.pem`.
- **macOS has no `timeout`** — use background tasks + a polling loop instead.

## Sandbox (`MAC_SANDBOX`)

`apps/server/src/mastra/workspace.ts` selects the execution mode from a single
`MAC_SANDBOX` env var (default `auto`). Local modes are built in; cloud providers
are opt-in via a `SANDBOX_PROVIDERS` registry. The `WorkspaceFactory`/
`resolveWorkspace` seam and all workflows/agents are unchanged. See README "Sandbox".

- `auto` (default) — local host, native OS isolation where available
  (`LocalSandbox.detectIsolation()`), else none.
- `local` — local host, no isolation (trusted dev).
- `seatbelt` — macOS `sandbox-exec`. `bwrap` — Linux bubblewrap.
- `e2b`/`daytona`/`modal`/`blaxel`/`agentcore` — cloud; install the `@mastra/*`
  package and register a one-line factory returning `{ sandbox }` (cloud providers
  bring their own filesystem).

Under a local isolation mode, `nativeSandbox` grants write to the checkout dir +
network (`MAC_SANDBOX_ALLOW_NETWORK=0` to block). Mastra's profile allows reads
globally but writes only to the workspace (+ /tmp), so tool caches (`HOME`, npm,
XDG) are **redirected into the checkout** (`isolatedCacheEnv`) — no host
`~/.npm`/`~/.cache` writes. **Verified** by `scripts/try-sandbox.ts`: under
`seatbelt`/`auto`, a workspace write and a redirected cache write succeed while a
`$HOME` write is blocked.

## State directory (`MAC_STATE_DIR`)

Local state (sqlite `mac.db`, `observability.duckdb`, and `workspaces/`) defaults
to `<repo-root>/data` — `config.ts` resolves the root by walking up for
`pnpm-workspace.yaml`, so it's cwd- and bundle-independent (no absolute path needed,
unlike the old libsql-error-14 workaround). Override with `MAC_STATE_DIR` /
`MAC_WORKSPACES_DIR`.

## Dropped / deferred (with reasons)

- **Network egress firewall** (gondolin `allowedHttpHosts`; docker SNI-peek + coredns
  sinkhole; SSRF floor) — **deferred** per spike scope. `LocalSandbox` runs on the host with
  no isolation/egress firewall. Re-add (or swap to a remote sandbox) before production.
- **gondolin QEMU sandbox + docker firewall sidecars** — replaced by Mastra `LocalSandbox`
  (no `/dev/kvm` dependency); a remote Mastra sandbox provider (`@mastra/e2b`,
  `@mastra/daytona`, …) is the prod path.
- **JSONL envelope shim + `SessionReader`** — replaced by Mastra built-in AI tracing (Studio).
- **Custom React/Vite admin dashboard** — Mastra Studio (`mastra dev`) for now.
- **DAG runner, restart-count circuit breaker, daily/hourly stat rollups** — port only if a
  workflow needs them.
- **Config overlay/instance layering** — simplified to `.env` + a single config file.
- **`code.mastra.ai` / `mastra-ai/code` repo** — repo is private/non-existent; we use the
  published `mastracode` + `@mastra/*` from npm. (mastracode not yet wired; pr-review uses our
  own Agent over a Mastra Workspace.)

## Env (from lastlight `.env`)

`apps/maintenance/.env` carries the GitHub App config (`GITHUB_APP_ID`,
`GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`), `WEBHOOK_SECRET`, Slack tokens,
`OPENAI_API_KEY` (active provider), and `LASTLIGHT_STATE_DIR` (absolute). The GitHub App PEM
is at `secrets/app.pem` (gitignored). `LASTLIGHT_MODEL` overrides the default model
(`openai/gpt-4o`). Legacy `OPENCODE_*`/`LASTLIGHT_MODEL` names from lastlight are tolerated.

---

# MAC Package Refactor

> Source of package-boundary truth: [`docs/mastra-package-refactor.md`](docs/mastra-package-refactor.md).
> This section records the migration state and the Phase 0 boundary inventory.

The app is being refactored from a single deployable into a reusable set of Mastra
building blocks under the `@nearform/*` scope:

- `@nearform/mac` — shared contracts (`/core`: events, routing, capability + authoring
  helpers) and the `createMacApp(...)` preset/host.
- `@nearform/mac-github` — GitHub platform package (auth, tools, webhook connector).
  Replaces `@lastlight/github`.
- `@nearform/mac-slack` — Slack platform package (tools + Socket Mode connector).
- `@nearform/mac-agent-workflows` — agents, workflow factories, and all markdown
  instruction assets (`prompts/`, `skills/`, `agent-context/`).

Dependency direction is one-way into `@nearform/mac/core`; the agent-workflow package may
only `import type` the platform `/capabilities` contracts (no runtime platform deps).

### Phase 10 — Publish readiness / compatibility

- **`@lastlight/github` is fully replaced** by `@nearform/mac-github`. No compatibility
  shim or alias package is retained — there is exactly one GitHub package, and all
  importers (the app + `@nearform/mac-agent-workflows`) use the new name. This resolves the
  open question "How much backward compatibility should `@lastlight/github` retain?": none.
  The clean break is acceptable because the package was never published externally; it only
  ever had in-repo importers, all updated in one pass (Phase 1).
- **No cycles, asserted in CI:** `packages/mac/test/dependency-graph.test.ts` reads the four
  `@nearform/*` `package.json` files, builds the internal dependency graph, and asserts it is
  acyclic with `@nearform/mac` as the sink (no `@nearform/*` runtime dep) and
  `@nearform/mac-agent-workflows` at the top (depending on `mac` + both platform packages via
  their dependency-light `/capabilities` key import). It also checks each package exposes its
  documented `exports` subpaths (`mac` → `./core`; platforms + agent-workflows → `./capabilities`).
- **Docs:** package READMEs added for `@nearform/mac`, `@nearform/mac-slack`, and
  `@nearform/mac-agent-workflows` (matching the existing `@nearform/mac-github` README);
  `docs/examples.md` holds the four minimal `createMacApp` snippets; `CHANGELOG.md` records the
  versioning policy (all `@nearform/mac*` packages version together while pre-1.0).

### Test safety net (Phase 0)

Vitest is wired at the workspace root (`vitest.config.ts`, `pnpm test`). Coverage that pins
behavior before code moves:

- `apps/maintenance/test/github-normalize.test.ts` — signature verify, bot/ignore filtering,
  payload → `EventEnvelope` normalization (pure functions; move with the GitHub connector in
  Phase 3).
- `apps/maintenance/test/router.test.ts` — deterministic router decisions with the LLM
  classifier/screener mocked (moves with the router into `@nearform/mac/core` in Phase 2).

Golden prompt snapshots were intentionally **not** added (owner preference): Phase 5a
preserves composed agent instructions by careful construction, not a snapshot suite.

## Phase 0 — Runtime Boundary Inventory

### 1. GitHub auth & tools (`packages/github`)

**Owners** (re-exported from `packages/github/src/index.ts:1-31`):
- `profiles.ts`: `GITHUB_PERMISSION_PROFILES`, `resolveProfile` + types `GitAccessProfile`,
  `GitHubPermissionLevel`, `GitHubTokenPermissions`.
- `auth.ts`: `mintInstallationToken`, `mintTokenForProfile`, `githubAppConfigFromEnv` + types
  `GitHubAppConfig`, `InstallationToken`.
- `client.ts`: `createInstallationOctokit`, `createTokenOctokit`.
- `tools.ts`: `createGithubReadTools` (+ `GithubReadTools`).
- `write-tools.ts`: `createGithubReviewTools`, `postPullRequestReview` (+ `GithubReviewTools`,
  `ReviewEvent`, `PostedReview`).
- `issue-tools.ts`: `addIssueComment`, `updateIssueComment`, `addIssueReaction`
  (+ `ReactionContent`, `PostedComment`).

**env / `*FromEnv`:** the only `process.env` touch in the package is
`githubAppConfigFromEnv(env = process.env)` (`auth.ts:92`, reads `GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_APP_INSTALLATION_ID`) — via an injectable default
parameter. **No module-load side effects**: all network (`auth.ts:61`, Octokit calls) and
file I/O (`readFileSync(privateKeyPath)` `auth.ts:53`, `client.ts:14`) live inside exported
functions. No listeners.

### 2. GitHub webhook ingestion (`server/github-webhook.ts` + `engine/github-normalize.ts`)

**Owners:** `github-webhook.ts` exports `githubWebhookRoute`
(`registerApiRoute("/webhooks/github", POST, requiresAuth:false)`, `:44`) + internal
`replyOnIssue()` (`:33`). `github-normalize.ts` exports `IGNORED_ACTIONS` (`:21`),
`verifySignature` (`:39`), `isFilteredBotEvent` (`:56`), `normalizeGithubEvent` (`:79`).

**Flow** (`github-webhook.ts:47-95`): read body → `verifySignature(body, sig, webhookSecret())`
→ `IGNORED_ACTIONS.has(action)` → `isFilteredBotEvent(payload, eventType, action, botLogin())`
→ `isManagedRepo(repository.full_name)` → `normalizeGithubEvent(...)` →
`createDispatcher(c.get("mastra"))` then fire-and-forget `dispatch(envelope)` → `202`.

**env:** no direct `process.env`. Indirect: `webhookSecret()` (`WEBHOOK_SECRET`), `botLogin()`
(`GITHUB_APP_BOT_NAME`), `replyOnIssue` calls `githubAppConfigFromEnv()` +
`mintTokenForProfile(cfg, "issues-write")`, `isManagedRepo` → `LASTLIGHT_MANAGED_REPOS`.
**No import-time side effects** — `registerApiRoute` just returns a descriptor.

### 3. Slack connector (`connectors/slack/*`)

**Owners:** `connector.ts` — `SlackConnector` class (`:45`), `startSlackConnector(config, dispatch)`
(`:280`), `DispatchFn` type (`:43`). `notify.ts` — `setSlackClient`, `getSlackClient`,
`postStatus`, `updateStatus`, `postMessage`, `SlackTarget`. `mrkdwn.ts` — `markdownToSlackMrkdwn`
(pure).

**Normalization to `EventEnvelope`** (`connector.ts:176-193`): `id: slack-${messageId}`,
`source:"slack"`, `type:"message"`, `sender: platformUsername`, `body: cleanText`. `raw` is the
Slack `msg` spread then OVERSTAMPED with `sessionId`, `platformUserId`, `channelId`, `threadId`
(= resolved reply anchor `replyThreadId`, NOT `msg.thread_ts`), `team`.

**reply() closure** (`:165-174`): per-chunk `app.client.chat.postMessage({channel: channelId,
text: markdownToSlackMrkdwn(chunk), thread_ts: replyThreadId})`. Closes over `channelId`,
`replyThreadId`, bolt `app.client`.

**Stamped raw fields:** `channelId = msg.channel`; `threadId = msg.thread_ts || msg.ts`
(`:155`); `team = msg.team`; `sessionId = slack:${channelId}:${replyThreadId}` (`:160`);
`platformUserId = msg.user`.

**Gating:** subtype/no-user/no-text/`bot_id` dropped at listener (`:96-98`); allowlist
(`:137-140`); non-DM non-mention only continues if `${channelId}:${threadId}` ∈ `activeThreads`
(`:144-147`); DMs always pass. **Mention stripping** `stripBotMention` removes `<@botUserId>`
(`:205-208`); empty → drop. **Active-thread continuation** in-memory `Set` (`:54-55,:156`),
lost on restart, no DB.

**Lifecycle:** `start()` → `app.client.auth.test()` resolves `botUserId`, `setSlackClient(...)`,
`app.start()` opens the Socket Mode WebSocket. `stop()` → `app.stop()`. `new App(...)` is in the
constructor, WebSocket opens only in `start()` (called from `server.ts`). **No listener at import.**

**env:** none direct in `connector.ts`/`mrkdwn.ts`; `notify.ts:35-40` `getSlackClient()` →
`slackConfig()` (`SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`). Config (`botToken`,`appToken`,
`allowedUsers`,`homeChannel`) read by the caller (`server.ts`) and passed in.

### 4. Router & dispatch (`engine/router.ts`, `engine/dispatch.ts`)

**Owners:** `router.ts` — `routeEvent(envelope, deps)` (`:58`), `RoutingResult`/`RouterDb`/
`RouterDeps`. `dispatch.ts` — `createDispatcher(mastra, deps)` (`:193`), internal `dispatchSkill`,
`startWorkflow`, `slackOrigin`.

`dispatchSkill` only implements `pr-review` → `pr-review` wf, `github-orchestrator` → `build` wf,
`chat` → `mastra.getAgent("chat").generate` (Memory `{thread, resource}`), `approval-response` →
nudge reply; else 🚧/skip (`IMPLEMENTED = {"pr-review","github-orchestrator"}` `:22`).

**slackOrigin** (`dispatch.ts:46-53`): only for `source==="slack"`, reads `raw.channelId` /
`raw.threadId`, threads `{slackChannel, slackThread}` into workflow `inputData` (`:96-101,
:120-132`). `router.ts:287-293` also re-derives the reply-gate trigger id
(`slack:${team}:${channel}:${thread}`) and reads `raw.sessionId` for chat/reset contexts.
**env:** none direct; `router.ts` uses `isManagedRepo` (`LASTLIGHT_MANAGED_REPOS`) + the LLM
classifier/screener (which read provider keys via `engine/llm.ts`). No import-time side effects.

### 5. Agents (`agents/*`) — all use `model: defaultModel()` (`LASTLIGHT_MODEL`); registered in `index.ts:60-74`

| id | factory / instance | registered | tools | workspace |
|----|----|----|----|----|
| `chat` (`chat.ts:19`) | factory | yes | read tools iff `githubAppConfigFromEnv()` set + PEM readable, else `{}` | none; `createChatMemory()` |
| `sandbox-probe` (`sandbox-probe.ts:10`) | factory | yes | none | `createCodeWorkspace("probe")` (static) |
| `guardrails` (`guardrails.ts:70`) | instance | yes | none | `workspaceFromContext` (per-run) |
| `architect` (`architect.ts:48`) | instance | yes | `readToolsFromContext` (per-run token) | `workspaceFromContext` |
| `executor` (`executor.ts:35`) | instance | yes | none | `workspaceFromContext` |
| `fix` (`executor.ts:70`) | instance | yes | none | `workspaceFromContext` |
| `reviewer` (`reviewer.ts:24`) | instance | yes | `readToolsFromContext` | `workspaceFromContext` |
| `build-reviewer` (`reviewer.ts:56`) | instance | yes | none | none (diff in prompt) |

Per-run wiring in `agents/runtime.ts`: `buildAgentContext(taskId, token)` sets RC keys
`taskId`/`token`; `workspaceFromContext` → `createCodeWorkspace(taskId)`; `readToolsFromContext`
→ `createGithubReadTools(createTokenOctokit(token))`. Instances evaluate `defaultModel()`,
`agentMaxSteps()`, `loadAgentContext()` at module load.

### 6. Workflows (`workflows/pr-review.ts`, `workflows/build.ts`)

**pr-review:** single `reviewStep` (`:41`). In-step token mint: `githubAppConfigFromEnv()`
(`:55`, throws if null) → `resolveProfile("pr-review")` → `mintTokenForProfile(cfg, profile)`
(`review-write`). Agent via `mastra.getAgent("reviewer")` + `generate(..., {requestContext:
buildAgentContext(taskId, token), tracingContext})`. Posts deterministically via
`createTokenOctokit(token)` + `postPullRequestReview(...)`. Slack mirror via `postMessage` if
`slackChannel`+`slackThread`. No approval gate.

**build:** `guardrails → architect → post_architect (suspend/resume) → executor →
dountil(review→executor_fix) → finalize → pr` (`:996-1016`). In-step mints via `requireAppConfig()`
(`githubAppConfigFromEnv()` `:251`), `mintReadToken()` (`read`, clone), `mintWriteToken()`
(`build`→`repo-write`, commit/push/comment/PR). Workspace `createCodeWorkspace(taskId)` per step
+ git helpers (`git.ts`). Agents via `mastra.getAgent(...)` + `buildAgentContext`. Approval:
`post_architect` `suspend({message,branch,plan})` → resume reads `resumeData {decision,reason}`.
Status comment via `renderStatusComment` (embeds signed `approvalLink(runId,…)`) +
`addIssueComment`/`updateIssueComment`/`addIssueReaction`; PR via `octokit.rest.pulls.create`.
Slack via `postStatus`/`updateStatus` + terminal `postMessage`. **FromEnv:**
`githubAppConfigFromEnv()` at `pr-review.ts:55` and `build.ts:251`. No module-load side effects.

### 7. Workspace factory (`workspace.ts`)

`createCodeWorkspace(taskDir)` (`:19`) builds a Mastra `Workspace` = `LocalFilesystem({basePath})`
+ `LocalSandbox({workingDirectory, env, timeout})`. Root = `LASTLIGHT_WORKSPACES_DIR` or
`<cwd>/workspaces`; per-task `mkdirSync`. **LocalSandbox executes on the host, no isolation/egress
firewall.** env: `LASTLIGHT_WORKSPACES_DIR`, `LASTLIGHT_SANDBOX_TIMEOUT_MS`,
`LASTLIGHT_SANDBOX_INHERIT_ENV`, curated `process.env` allowlist (`:66-94`), `GITHUB_TOKEN`/
`GH_TOKEN`. Note `sandbox-probe` calls `createCodeWorkspace("probe")` at agent construction, so a
`workspaces/probe` dir is created when the Mastra instance is built.

### 8. Approval route (`server/approval.ts`)

`approvalRoute = registerApiRoute("/approve", GET, requiresAuth:false)` (`:32`). Token scheme:
query `runId`,`token`,`decision`,`reason?`; validates `token === approvalToken(runId)` =
`HMAC-SHA256(approvalSecret, runId).slice(0,32)` (`config.ts:95-97`); `approvalSecret` =
`LASTLIGHT_APPROVAL_SECRET ?? ADMIN_SECRET ?? WEBHOOK_SECRET ?? "lastlight-dev-approval-secret"`.
No session check. Resume: `getWorkflow("build")` → require `status==="suspended"` →
`createRun({runId})` → fire-and-forget `run.resume({step:"post_architect", resumeData})`.

### 9. Server boot (`server.ts`)

1. `import "dotenv/config"` first (`:4`). 2. import `./mastra/index.js` → **Mastra instance
constructed at module-eval** (composite store `LibSQLStore(dbUrl())` + `DuckDBStore(duckDbPath())`,
observability, all agents incl. `sandbox-probe` `mkdirSync`, workflows, apiRoutes). 3. Hono app +
CORS. 4. `new MastraServer({app, mastra})` + `await server.init()` mounts `/api/*` + custom routes.
5. `port = process.env.PORT ?? 4111`; `serve({fetch, port})`. 6. **Slack starts AFTER `serve()`**
(`:75-83`): `slackConfig()`; if non-null → `startSlackConnector(slack, createDispatcher(mastra))`;
else "Slack disabled".

## `@lastlight/github` package.json / exports map

`name: "@lastlight/github"`, `private`, `type: module`. `main: "./dist/index.js"`,
`types: "./src/index.ts"`. `exports["."] = { types: "./src/index.ts", import: "./dist/index.js" }`
(types point at SOURCE; consumed source-only via `bundler.transpilePackages:
["@lastlight/github"]` in `index.ts:91-93`).

### Importers of `@lastlight/github` (to update in Phase 1)

| file:line | symbols |
|----|----|
| `agents/chat.ts:2-6` | `createGithubReadTools`, `createInstallationOctokit`, `githubAppConfigFromEnv` |
| `agents/runtime.ts:2` | `createGithubReadTools`, `createTokenOctokit` |
| `server/github-webhook.ts:3-8` | `githubAppConfigFromEnv`, `mintTokenForProfile`, `createTokenOctokit`, `addIssueComment` |
| `workflows/pr-review.ts:3-9` | `createTokenOctokit`, `githubAppConfigFromEnv`, `mintTokenForProfile`, `postPullRequestReview`, `resolveProfile` |
| `workflows/build.ts:4-14` | `githubAppConfigFromEnv`, `mintTokenForProfile`, `resolveProfile`, `createTokenOctokit`, `addIssueComment`, `updateIssueComment`, `addIssueReaction`, `type ReactionContent`, `type GitHubAppConfig` |
| `mastra/index.ts:87,92` | string reference only (`bundler.transpilePackages`) |

## `process.env` / `*FromEnv` read sites (to eliminate from reusable package code)

App `config.ts` centralizes most reads: `LASTLIGHT_DB_URL`, `LASTLIGHT_STATE_DIR`,
`LASTLIGHT_OBS_DB_PATH`, `LASTLIGHT_MODEL`, `LASTLIGHT_AGENT_MAX_STEPS`, `WEBHOOK_SECRET`,
`GITHUB_APP_BOT_NAME`, `PORT`, `LASTLIGHT_PUBLIC_URL`, `LASTLIGHT_APPROVAL_SECRET`,
`ADMIN_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_ALLOWED_USERS`,
`SLACK_HOME_CHANNEL`. Other sites: `agent-context.ts:29` (`LASTLIGHT_AGENT_CONTEXT_DIR`),
`managed-repos.ts:12` (`LASTLIGHT_MANAGED_REPOS`), `workspace.ts` (`LASTLIGHT_WORKSPACES_DIR`,
`LASTLIGHT_SANDBOX_TIMEOUT_MS`, `LASTLIGHT_SANDBOX_INHERIT_ENV`, full `process.env` allowlist,
`GITHUB_TOKEN`/`GH_TOKEN`), `engine/llm.ts` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`, `OPENCODE_MODELS`), `cli.ts:23` (`LASTLIGHT_URL`), `server.ts:63` (`PORT`).

`*FromEnv` definition: `githubAppConfigFromEnv` (`packages/github/src/auth.ts:92`, injectable
default param). Call sites to replace with the injected token broker (Phases 7–8):
`chat.ts:34`, `github-webhook.ts:34`, `build.ts:251`, `pr-review.ts:55`.
