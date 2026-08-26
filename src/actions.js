import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { appEvents } from './app-events.js';
import { getDb } from './db.js';
import { ensureSessionAndSend } from './dispatcher.js';
import { getSessionSnapshot, getSessionStates } from './pty-manager.js';

/**
 * Strip verbose fields from a PR for compact list responses.
 * Full details are available via get_pr.
 */
export function summarizePR(pr) {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    org: pr.org,
    repo: pr.repo,
    author: pr.author,
    branch: pr.branch,
    url: pr.url,
    draft: pr.draft,
    ci_status: pr.ci_status,
    review_status: pr.review_status,
    mergeable: pr.mergeable,
    checks_summary: {
      total: pr.checks?.length ?? 0,
      failed: pr.checks?.filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT'].includes(c.conclusion)).length ?? 0,
    },
    labels: (pr.labels || []).map((l) => l.name),
    updated_at: pr.updated_at,
  };
}

const NON_FINAL_STATUSES = new Set(['IN_PROGRESS', 'QUEUED', 'WAITING', 'PENDING', 'REQUESTED']);

/**
 * Inject a Fastify route call and return parsed JSON. Throws on non-2xx.
 * @param {import('fastify').FastifyInstance} app
 * @param {{method: string, path: string, body?: object}} req
 */
async function inject(app, { method, path, body }) {
  const res = await app.inject({
    method,
    url: path,
    payload: body !== undefined ? JSON.stringify(body) : undefined,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
  });
  if (res.statusCode >= 400) {
    throw new Error(`Patrol API ${res.statusCode}: ${res.body}`);
  }
  return res.json();
}

function buildQuery(args) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

function inverseProvider(provider) {
  return provider === 'claude' ? 'codex' : 'claude';
}

function providerName(provider) {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

function createPeerReviewAction(reviewerProvider) {
  const presenterProvider = inverseProvider(reviewerProvider);
  return {
    description: `Run the user-requested ${providerName(reviewerProvider)} review for this ${providerName(presenterProvider)} session's full effective PR diff. This tool is reservation-gated and works only after the user clicks Review with ${providerName(reviewerProvider)} in Patrol. It waits for ${providerName(reviewerProvider)} and returns the complete review. Do not edit files while handling this request.`,
    schema: z.object({}),
    ruleFireable: false,
    mcpHandler: async (app, _args, ctx) => {
      const callerSessionId = ctx?.callerSessionId;
      if (!callerSessionId) {
        return { ok: false, error: 'unknown_session', message: 'The calling agent session is unknown' };
      }

      const { getDb, peerReviewCoordinator, reviewServices } = app.appContext;
      const row = getDb()
        .prepare(
          `SELECT s.id AS session_id,
                  s.provider AS presenter_provider,
                  w.id AS workspace_id,
                  w.path AS workspace_path,
                  w.pr_id AS pr_id,
                  p.number,
                  p.org,
                  p.repo,
                  p.base_branch
             FROM sessions s
             JOIN workspaces w ON w.id = s.workspace_id
             JOIN prs p ON p.id = w.pr_id
            WHERE s.id = ?
              AND s.status = 'active'
              AND w.status = 'active'
              AND w.operation_state = 'ready'`,
        )
        .get(callerSessionId);
      if (!row) {
        return {
          ok: false,
          error: 'review_not_ready',
          message: 'A ready PR workspace with an attached agent session is required',
        };
      }
      if (row.presenter_provider !== presenterProvider) {
        return {
          ok: false,
          error: 'review_provider_mismatch',
          message: `${providerName(reviewerProvider)} review must be presented by ${providerName(presenterProvider)}`,
        };
      }

      let review;
      try {
        review = peerReviewCoordinator.claim({
          workspaceId: row.workspace_id,
          sessionId: row.session_id,
          reviewerProvider,
        });
        const response = await reviewServices[reviewerProvider].run({
          reviewId: review.id,
          workspace: { id: row.workspace_id, path: row.workspace_path },
          pr: {
            id: row.pr_id,
            number: row.number,
            org: row.org,
            repo: row.repo,
            base_branch: row.base_branch,
          },
          signal: ctx?.signal,
        });
        peerReviewCoordinator.markDelivering(review.id);
        return {
          ok: true,
          review: response.result,
          no_changes: response.noChanges,
          range: { fork: response.range.fork, head: response.range.head },
        };
      } catch (error) {
        if (review) peerReviewCoordinator.fail(review.id, error);
        return {
          ok: false,
          error: error.code || `${reviewerProvider}_review_failed`,
          message: error.message,
        };
      }
    },
  };
}

/**
 * Per-tool metadata. Two ways to handle a call:
 *  1. `dispatch(args) -> { method, path, body? }` - the simple, rules-callable case.
 *     The MCP server applies optional `transform(result)` after the call. Rules
 *     engine bypasses transform; it wants raw data.
 *  2. `mcpHandler(app, args) -> McpToolResult` - for tools that need pre-call
 *     validation, multi-call composition, or filesystem access. Always run
 *     in MCP context; rules cannot fire these (set `ruleFireable: false`).
 *
 * A tool with `dispatch + mcpHandler` (e.g. retrigger_checks) gets the simple
 * dispatch in rules context and the rich behavior in MCP context.
 *
 * @typedef {object} ActionEntry
 * @property {string} description
 * @property {z.ZodObject<any>} schema
 * @property {boolean} ruleFireable
 * @property {(args: object) => { method: string, path: string, body?: object }} [dispatch]
 * @property {(result: any) => any} [transform]
 * @property {(app: import('fastify').FastifyInstance, args: object, ctx?: {callerSessionId?: string | null, signal?: AbortSignal}) => Promise<any>} [mcpHandler]
 */

/** @type {Record<string, ActionEntry>} */
export const actionRegistry = {
  start_work_item: {
    description:
      'Start a reference-based work item and wait for Patrol to prepare its repository workspaces. Returns the ready work item, or its structured error state when preparation fails.',
    schema: z.object({
      reference: z.string().min(1).max(512).describe('Issue or task reference understood by the configured resolver'),
      work_provider: z.enum(['claude', 'codex']).describe('Agent provider to use for the work item'),
    }),
    ruleFireable: false,
    dispatch: ({ reference, work_provider }) => ({
      method: 'POST',
      path: '/api/work-items',
      body: { reference, work_provider },
    }),
    transform: (result) => result.work_item,
    mcpHandler: async (app, { reference, work_provider }) => {
      const result = await inject(app, {
        method: 'POST',
        path: '/api/work-items',
        body: { reference, work_provider },
      });
      await app.appContext.workItemService.waitForIdle(result.work_item.id);
      return app.appContext.workItemService.detail(result.work_item.id);
    },
  },

  add_repo_workspace: {
    description:
      "Add a configured repository workspace to a ready work item. Omit work_item_id when calling from that work item's own session; provide it when calling from another Patrol session. Repositories without a configured defaultRevision require revision. Waits for workspace creation and returns the updated work item. Re-adding an existing repository is a no-op.",
    schema: z.object({
      repo: z.string().min(3).describe('Configured repository in owner/repo format'),
      revision: z
        .string()
        .min(1)
        .max(512)
        .optional()
        .describe('Starting git ref/branch/SHA; required when the repository has no configured defaultRevision'),
      work_item_id: z.string().min(1).optional().describe('Target work-item ID; inferred from a work-item caller'),
    }),
    ruleFireable: false,
    mcpHandler: async (app, { repo, revision, work_item_id }, ctx) => {
      let targetId = work_item_id;
      if (!targetId && ctx?.callerSessionId) {
        targetId = app.appContext
          .getDb()
          .prepare('SELECT work_item_id FROM sessions WHERE id = ?')
          .get(ctx.callerSessionId)?.work_item_id;
      }
      if (!targetId) {
        return {
          ok: false,
          error: 'work_item_id_required',
          message: 'work_item_id is required outside a work-item session',
        };
      }
      return inject(app, {
        method: 'POST',
        path: `/api/work-items/${encodeURIComponent(targetId)}/repositories`,
        body: { repository: repo, ...(revision === undefined ? {} : { revision }) },
      });
    },
  },

  link_pull_request: {
    description:
      "Link a pull request to its originating work item immediately after creating it. Pass the owner/repo#number identifier or the https://github.com/.../pull/... URL printed by gh pr create. Omit work_item_id when calling from that work item's own session. The operation is idempotent and rejects repositories outside the work item.",
    schema: z.object({
      pr: z.string().min(1).max(1024).describe('Pull request ID or GitHub URL'),
      work_item_id: z.string().min(1).optional().describe('Target work-item ID; inferred from a work-item caller'),
    }),
    ruleFireable: false,
    mcpHandler: async (app, { pr, work_item_id }, ctx) => {
      const targetId =
        work_item_id ??
        (ctx?.callerSessionId
          ? app.appContext.getDb().prepare('SELECT work_item_id FROM sessions WHERE id = ?').get(ctx.callerSessionId)
              ?.work_item_id
          : null);
      if (!targetId) {
        return {
          ok: false,
          error: 'work_item_id_required',
          message: 'work_item_id is required outside a work-item session',
        };
      }
      const result = await inject(app, {
        method: 'POST',
        path: `/api/work-items/${encodeURIComponent(targetId)}/pull-requests`,
        body: { pr },
      });
      return result.pull_request;
    },
  },

  unlink_pull_request: {
    description:
      "Remove an incorrect pull-request association from a work item without changing GitHub or deleting either object. Omit work_item_id when calling from that work item's own session.",
    schema: z.object({
      pr: z.string().min(1).max(1024).describe('Pull request ID or GitHub URL'),
      work_item_id: z.string().min(1).optional().describe('Target work-item ID; inferred from a work-item caller'),
    }),
    ruleFireable: false,
    mcpHandler: async (app, { pr, work_item_id }, ctx) => {
      const targetId =
        work_item_id ??
        (ctx?.callerSessionId
          ? app.appContext.getDb().prepare('SELECT work_item_id FROM sessions WHERE id = ?').get(ctx.callerSessionId)
              ?.work_item_id
          : null);
      if (!targetId) {
        return {
          ok: false,
          error: 'work_item_id_required',
          message: 'work_item_id is required outside a work-item session',
        };
      }
      return inject(app, {
        method: 'DELETE',
        path: `/api/work-items/${encodeURIComponent(targetId)}/pull-requests`,
        body: { pr },
      });
    },
  },

  list_prs: {
    description:
      'List all tracked pull requests. Optional filters: org, repo, draft, ci status, review status, merge status.',
    schema: z.object({
      org: z.string().optional().describe('Filter by GitHub org'),
      repo: z.string().optional().describe('Filter by repo name'),
      draft: z.boolean().optional().describe('Filter by draft status'),
      ci: z.enum(['pass', 'fail', 'pending']).optional().describe('Filter by CI status'),
      review: z.enum(['approved', 'changes_requested', 'pending']).optional().describe('Filter by review status'),
      mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']).optional().describe('Filter by merge status'),
    }),
    ruleFireable: false,
    dispatch: (args) => ({ method: 'GET', path: `/api/prs${buildQuery(args)}` }),
    transform: (result) => ({ ...result, prs: (result.prs ?? []).map(summarizePR) }),
  },

  get_pr: {
    description: 'Get details for a single PR by its database ID.',
    schema: z.object({
      id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
    }),
    ruleFireable: false,
    dispatch: ({ id }) => ({ method: 'GET', path: `/api/prs/${encodeURIComponent(id)}` }),
  },

  refresh_pr: {
    description:
      'Force-refresh a single PR from GitHub right now, bypassing the incremental poll cadence. Use this when you need the freshest possible view of one PR (e.g. after pushing a commit, dismissing a review, retriggering checks) instead of waiting for the next poll cycle. Returns the updated PR row, OR `{removed: true, state: "MERGED" | "CLOSED"}` when the PR is no longer open - in that case the row and any active workspaces have been cleaned up.',
    schema: z.object({
      id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
    }),
    ruleFireable: true,
    dispatch: ({ id }) => ({ method: 'POST', path: `/api/prs/${encodeURIComponent(id)}/refresh` }),
  },

  create_workspace: {
    description: 'Create a git worktree for a PR. Returns the workspace path you should cd into.',
    schema: z.object({
      pr_id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
    }),
    ruleFireable: true,
    dispatch: ({ pr_id }) => ({ method: 'POST', path: '/api/workspaces', body: { pr_id } }),
  },

  create_scratch_workspace: {
    description:
      'Create a scratch workspace to start new work without an existing PR. Specify a repo and branch name. Returns the workspace path you should cd into.',
    schema: z.object({
      repo: z.string().describe('Repository in "org/repo" format (e.g. "myorg/myrepo")'),
      branch: z.string().describe('Branch name for the new work (e.g. "feat/dark-mode")'),
    }),
    ruleFireable: true,
    dispatch: ({ repo, branch }) => ({ method: 'POST', path: '/api/workspaces', body: { repo, branch } }),
  },

  list_workspaces: {
    description: 'List workspaces. Defaults to active only. Optionally filter by PR ID, status, or repo.',
    schema: z.object({
      pr_id: z.string().optional().describe('Filter by PR database ID (e.g. "org/repo#42")'),
      status: z.enum(['active', 'destroyed']).optional().describe('Filter by workspace status (defaults to active)'),
      repo: z.string().optional().describe('Filter by repo name'),
    }),
    ruleFireable: false,
    dispatch: (args) => ({ method: 'GET', path: `/api/workspaces${buildQuery(args)}` }),
  },

  destroy_workspace: {
    description: 'Destroy a workspace by its ID.',
    schema: z.object({
      id: z.string().describe('Workspace ID'),
    }),
    ruleFireable: true,
    dispatch: ({ id }) => ({ method: 'DELETE', path: `/api/workspaces/${id}` }),
  },

  cleanup_workspaces: {
    description:
      'Destroy active workspaces whose PRs match the given conditions. For example: ci="pass" and mergeable="MERGEABLE" destroys workspaces for PRs that are passing CI and have no conflicts.',
    schema: z.object({
      ci: z.enum(['pass', 'fail', 'pending']).optional().describe('Only destroy workspaces where PR CI status matches'),
      review: z
        .enum(['approved', 'changes_requested', 'pending'])
        .optional()
        .describe('Only destroy workspaces where PR review status matches'),
      mergeable: z
        .enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN'])
        .optional()
        .describe('Only destroy workspaces where PR merge status matches'),
      repo: z.string().optional().describe('Only destroy workspaces for this repo'),
    }),
    ruleFireable: true,
    dispatch: (args) => {
      const body = {};
      for (const [k, v] of Object.entries(args)) if (v !== undefined) body[k] = v;
      return { method: 'POST', path: '/api/workspaces/cleanup', body };
    },
  },

  trigger_sync: {
    description: 'Trigger an immediate sync of PR data from GitHub.',
    schema: z.object({}),
    ruleFireable: true,
    dispatch: () => ({ method: 'POST', path: '/api/sync/trigger' }),
  },

  run_rule_for_all_matching_prs: {
    description:
      'Fire a rule against every PR matching its `where` clause at once. Returns the list of PRs the rule was fired on (`fired`) and those it was skipped for (`skipped`, with reasons). Fires happen in parallel in the background. Use this for bulk catch-up like "auto-rebase every conflicted PR right now". `subscribe: true` auto-subscribes matching PRs first when the rule has `requires_subscription: true` (one-shot rules will also consume those subscriptions on success). `force: true` bypasses cooldown and subscription gates entirely - use sparingly.',
    schema: z.object({
      rule_id: z.string().describe('Rule id from list_rules'),
      subscribe: z
        .boolean()
        .optional()
        .describe('Auto-subscribe matching PRs before firing (relevant when the rule has requires_subscription)'),
      force: z.boolean().optional().describe('Bypass cooldown and subscription gates'),
    }),
    ruleFireable: false,
    dispatch: ({ rule_id, subscribe, force }) => ({
      method: 'POST',
      path: `/api/rules/${encodeURIComponent(rule_id)}/run-all`,
      body: { subscribe, force },
    }),
  },

  subscribe_rule_for_all_matching_prs: {
    description:
      "Subscribe every PR matching a rule's `where` clause to that rule. Only valid for rules with `requires_subscription: true`. Returns `subscribed` (newly opted in), `already_subscribed` (no-op), and `skipped` (with reasons). Does not fire the rule - subscriptions take effect on the next matching trigger event for each PR.",
    schema: z.object({
      rule_id: z.string().describe('Rule id from list_rules; must have requires_subscription: true'),
    }),
    ruleFireable: false,
    dispatch: ({ rule_id }) => ({
      method: 'POST',
      path: `/api/rules/${encodeURIComponent(rule_id)}/subscribe-all`,
    }),
  },

  retrigger_checks: {
    description:
      'Re-run failed CI checks for a PR. Optionally filter to specific checks by name pattern. Use require_all_final=true to only retrigger when no checks are still running or queued. If check_name matches nothing, the response includes available_failed_checks so you can retry with a valid substring.',
    schema: z.object({
      pr_id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
      check_name: z
        .string()
        .optional()
        .describe(
          'Only retrigger checks whose name contains this substring (case-insensitive). Matched against both the workflow-prefixed name shown in get_pr/wait_for_checks (e.g. "smith-bench / @adobe/css-tools@4.4.4") and the bare matrix variant name from GitHub\'s REST API (e.g. "@adobe/css-tools@4.4.4"). If nothing matches, the response returns available_failed_checks listing every failed check name so you can pick a working pattern.',
        ),
      require_all_final: z
        .boolean()
        .optional()
        .describe(
          'If true, refuse to retrigger unless all checks are in a final state (no running/queued checks). Prevents retriggering while CI is still in progress.',
        ),
    }),
    ruleFireable: true,
    dispatch: ({ pr_id, check_name }) => {
      const body = { pr_id };
      if (check_name) body.check_name = check_name;
      return { method: 'POST', path: '/api/checks/retrigger', body };
    },
    mcpHandler: async (app, { pr_id, check_name, require_all_final }) => {
      if (require_all_final) {
        const pr = await inject(app, { method: 'GET', path: `/api/prs/${encodeURIComponent(pr_id)}` });
        const stillRunning = (pr.checks || []).filter(
          (c) => c.status && NON_FINAL_STATUSES.has(c.status) && !c.conclusion,
        );
        if (stillRunning.length > 0) {
          const names = stillRunning.map((c) => c.name).join(', ');
          return {
            ok: false,
            error: 'checks_still_running',
            message: `${stillRunning.length} check(s) are not yet in a final state: ${names}`,
            still_running: stillRunning.map((c) => ({ name: c.name, status: c.status })),
          };
        }
      }
      const body = { pr_id };
      if (check_name) body.check_name = check_name;
      return inject(app, { method: 'POST', path: '/api/checks/retrigger', body });
    },
  },

  get_pr_diff: {
    description:
      'Get the diff for a PR. Use name_only=true for a quick file list (triage), omit for the full diff. Works without creating a workspace.',
    schema: z.object({
      id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
      name_only: z.boolean().optional().describe('If true, return only changed file names instead of the full diff'),
    }),
    ruleFireable: false,
    dispatch: ({ id, name_only }) => ({
      method: 'GET',
      path: `/api/prs/${encodeURIComponent(id)}/diff${name_only ? '?name_only=true' : ''}`,
    }),
  },

  get_check_logs: {
    description:
      'Get the actual output of failed CI checks for a PR. Extracts only the relevant error sections, not the full job log. Optionally filter by run_id.',
    schema: z.object({
      id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
      run_id: z.string().optional().describe('Optional: filter to a specific GitHub Actions run ID'),
    }),
    ruleFireable: false,
    dispatch: ({ id, run_id }) => ({
      method: 'GET',
      path: `/api/prs/${encodeURIComponent(id)}/check-logs${run_id ? `?run_id=${encodeURIComponent(run_id)}` : ''}`,
    }),
  },

  get_pr_comments: {
    description:
      'Get review comments and conversation for a PR. Includes inline code review comments with file paths and diff positions, review summaries with state, and general PR conversation.',
    schema: z.object({
      id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
    }),
    ruleFireable: false,
    dispatch: ({ id }) => ({ method: 'GET', path: `/api/prs/${encodeURIComponent(id)}/comments` }),
  },

  get_session_history: {
    description:
      'List previous Claude and Codex sessions for a PR or workspace. Returns providers, session IDs, timestamps, and status. Claude transcripts can be read with get_session_transcript; Codex transcript ingestion is not supported.',
    schema: z.object({
      pr_id: z
        .string()
        .optional()
        .describe('PR database ID (e.g. "org/repo#42"). Finds all workspaces for this PR and returns their sessions.'),
      workspace_id: z.string().optional().describe('Workspace ID to list sessions for directly'),
    }),
    ruleFireable: false,
    mcpHandler: async (app, { pr_id, workspace_id }) => {
      if (!pr_id && !workspace_id) {
        return { error: 'Either pr_id or workspace_id is required.' };
      }
      if (pr_id && !workspace_id) {
        const workspaces = await inject(app, {
          method: 'GET',
          path: `/api/workspaces?pr_id=${encodeURIComponent(pr_id)}`,
        });
        const allSessions = [];
        for (const ws of workspaces) {
          const sessions = await inject(app, {
            method: 'GET',
            path: `/api/sessions/history?workspace_id=${encodeURIComponent(ws.id)}`,
          });
          for (const s of sessions) s.workspace_name = ws.name;
          allSessions.push(...sessions);
        }
        allSessions.sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
        return allSessions;
      }
      return inject(app, {
        method: 'GET',
        path: `/api/sessions/history?workspace_id=${encodeURIComponent(workspace_id)}`,
      });
    },
  },

  get_session_transcript: {
    description:
      'Get a summary of a previous Claude session. Returns human messages and assistant text responses (no tool use, tool results, or thinking blocks). Also returns the full transcript path if you need raw details. Use get_session_history first to find session IDs.',
    schema: z.object({
      session_id: z.string().describe('Session ID from get_session_history'),
    }),
    ruleFireable: false,
    mcpHandler: async (app, { session_id }) => {
      const data = await inject(app, {
        method: 'GET',
        path: `/api/sessions/${encodeURIComponent(session_id)}/transcript?path_only=true&summary=true`,
      });
      let summary;
      try {
        summary = readFileSync(data.summary_path, 'utf8');
      } catch {
        summary = '(Could not read summary file)';
      }
      return { __text: `${summary}\n\n---\nFull transcript (JSONL): ${data.transcript_path}` };
    },
  },

  wait_for_checks: {
    description:
      'Wait until all CI checks on a PR reach a final state (no more running/queued checks). Polls the PR data at a configurable interval. Returns the final check summary. Useful before retriggering specific checks.',
    schema: z.object({
      pr_id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
      poll_seconds: z.number().optional().describe('Seconds between polls (default: 30, min: 10, max: 300)'),
      timeout_minutes: z.number().optional().describe('Give up after this many minutes (default: 30, max: 120)'),
    }),
    ruleFireable: false,
    mcpHandler: async (app, { pr_id, poll_seconds, timeout_minutes }) => {
      const interval = Math.max(10, Math.min(300, poll_seconds || 30)) * 1000;
      const timeout = Math.max(1, Math.min(120, timeout_minutes || 30)) * 60 * 1000;
      const deadline = Date.now() + timeout;

      await inject(app, { method: 'POST', path: '/api/sync/trigger' }).catch(() => {});

      while (Date.now() < deadline) {
        const pr = await inject(app, { method: 'GET', path: `/api/prs/${encodeURIComponent(pr_id)}` });
        const checks = pr.checks || [];
        const stillRunning = checks.filter((c) => c.status && NON_FINAL_STATUSES.has(c.status) && !c.conclusion);

        if (stillRunning.length === 0) {
          const failed = checks.filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT'].includes(c.conclusion));
          const passed = checks.filter((c) => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion));
          return {
            ok: true,
            all_final: true,
            ci_status: pr.ci_status,
            total: checks.length,
            passed: passed.length,
            failed: failed.length,
            failed_checks: failed.map((c) => c.name),
          };
        }

        await new Promise((r) => setTimeout(r, interval));
        await inject(app, { method: 'POST', path: '/api/sync/trigger' }).catch(() => {});
      }

      const pr = await inject(app, { method: 'GET', path: `/api/prs/${encodeURIComponent(pr_id)}` });
      const checks = pr.checks || [];
      const stillRunning = checks.filter((c) => c.status && NON_FINAL_STATUSES.has(c.status) && !c.conclusion);
      return {
        ok: false,
        error: 'timeout',
        message: `Timed out after ${timeout_minutes || 30} minutes. ${stillRunning.length} check(s) still running.`,
        still_running: stillRunning.map((c) => ({ name: c.name, status: c.status })),
      };
    },
  },

  wait_for_idle: {
    description:
      'Wait until a Claude or Codex session reaches idle. After send_prompt_to_session, pass the dispatched_at you received as `since` to anchor on that specific dispatch. Resolves when the session has gone through working then idle after `since` and is currently idle. Default timeout 30 minutes, max 120. This waits for the current TUI turn to quiesce, not for any background work the dispatched prompt may have spawned.',
    schema: z.object({
      session_id: z.string().describe('Session id to watch'),
      since: z
        .number()
        .optional()
        .describe('ms epoch anchor; resolves only after a working->idle cycle that lands after `since`. Default: now.'),
      timeout_minutes: z.number().optional().describe('Give up after this many minutes (default 30, min 1, max 120)'),
    }),
    ruleFireable: false,
    mcpHandler: async (_app, args) => {
      const sessionId = args.session_id;
      const since = typeof args.since === 'number' ? args.since : Date.now();
      const timeoutMs = Math.max(1, Math.min(120, args.timeout_minutes ?? 30)) * 60 * 1000;

      const row = getDb().prepare('SELECT id, status FROM sessions WHERE id = ?').get(sessionId);
      if (!row || row.status === 'killed') {
        return { ok: false, error: 'no_session', message: `session ${sessionId} not found` };
      }
      if (row.status === 'detached') {
        return { ok: false, error: 'session_detached', message: `session ${sessionId} is detached` };
      }

      // Predicate: a working->idle cycle has landed after `since`, and the
      // session is currently idle. Null timestamps coerce to 0 in numeric
      // comparison; for any plausible `since` (Date.now()-ish), `0 >= since`
      // and `0 > number` are both false, so explicit null guards aren't
      // needed beyond the snap-null check.
      const satisfied = (snap) =>
        snap !== null &&
        snap.activityState === 'idle' &&
        snap.lastWorkingAt >= since &&
        snap.lastIdleAt > snap.lastWorkingAt;

      const initial = getSessionSnapshot(sessionId);
      if (initial === null) {
        return { ok: false, error: 'no_session', message: `session ${sessionId} not in memory` };
      }
      if (satisfied(initial)) {
        return {
          ok: true,
          idle_at: new Date(initial.lastIdleAt).toISOString(),
          working_duration_ms: initial.lastIdleAt - initial.lastWorkingAt,
        };
      }

      return new Promise((resolve) => {
        const handler = (data) => {
          if (data.sessionId !== sessionId) return;
          if (data.state === 'exited') {
            cleanup();
            resolve({ ok: false, error: 'session_exited', message: `session ${sessionId} exited` });
            return;
          }
          if (data.state !== 'idle') return;
          const snap = getSessionSnapshot(sessionId);
          if (satisfied(snap)) {
            cleanup();
            resolve({
              ok: true,
              idle_at: new Date(snap.lastIdleAt).toISOString(),
              working_duration_ms: snap.lastIdleAt - snap.lastWorkingAt,
            });
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve({
            ok: false,
            error: 'timeout',
            message: `did not reach idle within ${args.timeout_minutes ?? 30} minute(s)`,
          });
        }, timeoutMs);
        function cleanup() {
          appEvents.removeListener('session-state', handler);
          clearTimeout(timer);
        }
        appEvents.on('session-state', handler);
      });
    },
  },

  send_prompt_to_session: {
    description:
      'Send a prompt to another Claude or Codex session. Target with exactly one of: session_id (direct), pr_id (the owning work-item session when linked, otherwise the PR workspace session), workspace_id (workspace session), or global: true (the global terminal session). When multiple global sessions exist, use list_sessions and target the chosen session_id. Auto-creates the appropriate target when create_if_missing is true. Set provider when creating a target; an existing target keeps its provider. Returns dispatched_at; pass it to wait_for_idle to wait for the response. Cannot target your own session (errors with self_target). Errors with session_busy if the target is currently working. Single-line prompts only: newlines in prompt are stripped at write time.',
    schema: z.object({
      session_id: z.string().optional().describe('Direct session id from list_sessions'),
      pr_id: z.string().optional().describe('PR database id (e.g. "org/repo#42")'),
      workspace_id: z.string().optional().describe('Workspace id'),
      global: z
        .boolean()
        .optional()
        .describe('Target the only global terminal session; use session_id when multiple exist'),
      provider: z.enum(['claude', 'codex']).optional().describe('Provider to use when creating a missing session'),
      prompt: z.string().min(1).describe('Prompt text. Single-line; newlines are stripped.'),
      create_if_missing: z
        .boolean()
        .optional()
        .describe('If the target has no active session (or pr_id has no workspace), create one. Default true.'),
    }),
    ruleFireable: false,
    mcpHandler: async (_app, args, ctx) => {
      try {
        const result = await ensureSessionAndSend({
          session_id: args.session_id,
          pr_id: args.pr_id,
          workspace_id: args.workspace_id,
          global: args.global,
          provider: args.provider,
          prompt: args.prompt,
          autoCreate: args.create_if_missing ?? true,
          callerSessionId: ctx?.callerSessionId ?? null,
        });
        return { ok: true, ...result };
      } catch (e) {
        if (e.code) return { ok: false, error: e.code, message: e.message };
        throw e;
      }
    },
  },

  review_with_codex: createPeerReviewAction('codex'),

  review_with_claude: createPeerReviewAction('claude'),

  list_sessions: {
    description:
      'List active Claude and Codex sessions known to Patrol. Returns each provider, session id, global session name, workspace context (PR id, repo, branch, workspace path), activity state (working, idle, or null when untracked), and started_at. Use this before send_prompt_to_session to pick a target. Detached sessions are not listed because send_prompt_to_session cannot target them.',
    schema: z.object({}),
    ruleFireable: false,
    mcpHandler: async () => {
      const db = getDb();
      const rows = db
        .prepare(
          `SELECT s.id            AS session_id,
                  s.workspace_id  AS workspace_id,
                  s.name          AS name,
                  s.provider      AS provider,
                  s.started_at    AS started_at,
                  w.pr_id         AS pr_id,
                  w.repo          AS repo,
                  w.branch        AS branch,
                  w.path          AS workspace_path
             FROM sessions s
             LEFT JOIN workspaces w ON w.id = s.workspace_id
            WHERE s.status = 'active'
              AND s.work_item_id IS NULL
              AND (s.workspace_id IS NULL OR w.work_item_id IS NULL)
            ORDER BY s.started_at DESC`,
        )
        .all();
      const states = new Map(getSessionStates().map((s) => [s.sessionId, s.state]));
      return rows.map((r) => ({
        session_id: r.session_id,
        name: r.name,
        provider: r.provider,
        workspace_id: r.workspace_id,
        pr_id: r.pr_id,
        repo: r.repo,
        branch: r.branch,
        workspace_path: r.workspace_path,
        activity_state: states.get(r.session_id) ?? null,
        started_at: r.started_at,
        is_global: r.workspace_id === null,
      }));
    },
  },
};

/**
 * Validate args, dispatch, and return parsed JSON. For rules-engine consumers.
 * Tools without `dispatch` (mcpHandler-only) cannot be invoked here - those
 * are not rule-callable by design.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {string} tool
 * @param {object} args
 */
export async function invokeAction(app, tool, args) {
  const entry = actionRegistry[tool];
  if (!entry) throw new Error(`Unknown action: ${tool}`);
  if (!entry.dispatch) throw new Error(`Action not invocable from rules: ${tool} (mcp-only)`);
  if (!entry.ruleFireable) throw new Error(`Action not rule-fireable: ${tool}`);
  const validated = entry.schema.parse(args);
  return inject(app, entry.dispatch(validated));
}
