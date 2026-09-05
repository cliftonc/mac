import { Harness } from "@mastra/core/harness";
import type { MastraDBMessage } from "@mastra/core/harness";
import { createTool } from "@mastra/core/tools";
import type { Agent } from "@mastra/core/agent";
import type { Workflow } from "@mastra/core/workflows";
import type { MastraCompositeStore } from "@mastra/core/storage";
import type { Memory } from "@mastra/memory";
import type { InteractiveDispatch, WorkspaceFactory } from "@nearform/mac/core";
import { z } from "zod";

/**
 * The INTERACTIVE/conversational lane, built on Mastra's `Harness`.
 *
 * This is deliberately separate from the deterministic `build`/`pr-review`
 * workflows (which stay `createWorkflow` DAGs triggered by webhook/CLI and keep
 * their own `suspend`/`resume` + HMAC approval gate). A Harness mode is an
 * `Agent`, NOT a workflow (`HarnessMode.agent: Agent | ((state) => Agent)`), so
 * the two lanes never merge — instead the deterministic workflows are surfaced
 * INTO the Harness as tools (`run_build` / `run_pr_review`) that an interactive
 * session can trigger.
 *
 * The Harness reuses the app's existing `MastraCompositeStore` (threads/messages)
 * and chat `Memory`, and the SAME `WorkspaceFactory` as the workflows — so an
 * interactive session gets the pluggable sandbox (MAC_SANDBOX) too.
 *
 * EXPERIMENTAL: `@mastra/core`'s Harness is alpha-era; this surface is opt-in
 * (gated behind MAC_INTERACTIVE_HARNESS in index.ts) until runtime-verified.
 */

export interface MacHarnessDeps {
  storage: MastraCompositeStore;
  memory: Memory;
  workspaceFactory: WorkspaceFactory;
  /** The chat agent instance, registered as the default "chat" mode. */
  chatAgent: Agent;
  /**
   * Lazy getter for the OUTER Mastra's workflows. The Harness builds its OWN
   * internal Mastra, so workflow tools must reach the outer instance — and the
   * outer `mastra` is constructed AFTER this factory runs, hence a getter.
   */
  getWorkflow: (id: string) => Workflow | undefined;
}

/** Build the MAC interactive Harness (one default `chat` mode + workflow tools). */
export function createMacHarness(deps: MacHarnessDeps): Harness {
  const runBuild = createTool({
    id: "run_build",
    description:
      "Start the deterministic build workflow for a GitHub issue (fire-and-forget). " +
      "Returns the workflow runId. Use when the user asks to implement/fix an issue.",
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      issueNumber: z.number(),
      issueTitle: z.string().optional(),
      issueBody: z.string().optional(),
      baseBranch: z.string().optional(),
    }),
    outputSchema: z.object({ runId: z.string().nullable(), started: z.boolean() }),
    execute: async ({ owner, repo, issueNumber, issueTitle, issueBody, baseBranch }) => {
      const wf = deps.getWorkflow("build");
      if (!wf) return { runId: null, started: false };
      const run = await wf.createRun();
      void Promise.resolve(
        run.start({
          inputData: {
            owner,
            repo,
            issueNumber,
            issueTitle: issueTitle ?? "",
            issueBody: issueBody ?? "",
            baseBranch: baseBranch ?? "main",
          },
        }),
      ).catch((err: unknown) => console.error(`[harness] build run ${run.runId} failed:`, err));
      return { runId: run.runId, started: true };
    },
  });

  const runPrReview = createTool({
    id: "run_pr_review",
    description:
      "Start the deterministic PR-review workflow for a pull request (fire-and-forget). " +
      "Returns the workflow runId. Use when the user asks to review a PR.",
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number(),
    }),
    outputSchema: z.object({ runId: z.string().nullable(), started: z.boolean() }),
    execute: async ({ owner, repo, number }) => {
      const wf = deps.getWorkflow("pr-review");
      if (!wf) return { runId: null, started: false };
      const run = await wf.createRun();
      void Promise.resolve(run.start({ inputData: { owner, repo, number } })).catch(
        (err: unknown) => console.error(`[harness] pr-review run ${run.runId} failed:`, err),
      );
      return { runId: run.runId, started: true };
    },
  });

  return new Harness({
    id: "mac-interactive",
    storage: deps.storage,
    memory: deps.memory,
    // Minimal harness state: the repo/issue context an interactive session may
    // carry. Extend as modes need more.
    stateSchema: z.object({
      owner: z.string().optional(),
      repo: z.string().optional(),
      issueNumber: z.number().optional(),
    }),
    // Reuse the SAME pluggable workspace factory the workflows use.
    // TODO(harness): key the workspace per harness thread instead of a single
    // "interactive" dir, so concurrent sessions don't share a checkout.
    workspace: () => deps.workspaceFactory.create("interactive"),
    modes: [
      { id: "chat", name: "Chat", default: true, agent: deps.chatAgent },
      // TODO(harness): add an interactive `plan` mode here (agents only) once the
      // interactive UX needs plan/build mode switching.
    ],
    // Deterministic workflows surfaced as tools — the bridge between the lanes.
    tools: { run_build: runBuild, run_pr_review: runPrReview },
  });
}

/** Concatenate the text parts of an assistant message. */
function assistantText(message: MastraDBMessage): string {
  let out = "";
  for (const part of message.content.parts) {
    if (part.type === "text") out += part.text;
  }
  return out.trim();
}

/**
 * Adapt a {@link Harness} to the platform-neutral `InteractiveDispatch` the host
 * expects, so `@nearform/mac` never imports the harness. One external
 * conversation id (Slack thread / GitHub issue / CLI session) maps to one
 * Harness SESSION (keyed by `resourceId`); the assistant reply is accumulated
 * from `message_end` events (sendMessage itself returns void) and sent back via
 * `turn.reply`.
 *
 * Sessions replaced the harness-level thread juggling in `@mastra/core` 1.51+:
 * `createSession({ resourceId })` resolves to the same session for the same
 * resource, and each session owns its thread binding, run loop and state — so
 * concurrent conversations no longer share one current thread.
 */
export function createInteractiveDispatch(harness: Harness): InteractiveDispatch {
  let initialized = false;

  const ensureInit = async (): Promise<void> => {
    if (initialized) return;
    await harness.init();
    initialized = true;
  };

  return {
    async handle(turn): Promise<void> {
      await ensureInit();
      // Same external conversation id → same session (and therefore same thread).
      const session = await harness.createSession({ resourceId: turn.threadId });

      let text = "";
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          text = assistantText(event.message);
        }
        // TODO(harness): real approval transport (e.g. Slack interactive buttons).
        // Interim: auto-approve so a single interactive turn can complete.
        if (event.type === "tool_approval_required") {
          void session.respondToToolApproval({ decision: "approve" });
        }
        // TODO(harness): wire plan-approval response transport
        // (respondToPlanApproval) to the originating surface.
      });
      try {
        await session.sendMessage({ content: turn.message });
      } finally {
        unsubscribe();
      }
      await turn.reply(text || "…");
    },
  };
}
