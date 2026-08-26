import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { actionRegistry } from './actions.js';
import { createAppContext } from './app-context.js';
import { parseConfig } from './config.js';
import { migrateDb } from './migrations.js';
import { PeerReviewCoordinator } from './peer-review-coordinator.js';
import { createServer } from './server.js';

const MATRICES = [
  { presenter: 'claude', reviewer: 'codex', tool: 'review_with_codex' },
  { presenter: 'codex', reviewer: 'claude', tool: 'review_with_claude' },
];

for (const { presenter, reviewer, tool } of MATRICES) {
  test(`${presenter} presents a reserved ${reviewer} review`, async () => {
    const db = new DatabaseSync(':memory:');
    migrateDb(db);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO prs
        (id, number, title, repo, org, author, url, branch, base_branch, created_at, updated_at, synced_at)
       VALUES ('acme/app#1', 1, 'Review me', 'app', 'acme', 'octocat', 'https://example.test/1', 'feature', 'main', ?, ?, ?)`,
    ).run(now, now, now);
    db.prepare(
      `INSERT INTO workspaces
        (id, pr_id, name, path, bookmark, status, created_at, operation_state, operation_step, operation_updated_at)
       VALUES ('workspace-1', 'acme/app#1', 'review', '/tmp/review', 'feature', 'active', ?, 'ready', 'create:complete', ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO sessions (id, workspace_id, pid, provider, status, started_at)
       VALUES ('session-1', 'workspace-1', 123, ?, 'active', ?)`,
    ).run(presenter, now);

    const appEvents = new EventEmitter();
    const coordinator = new PeerReviewCoordinator({ events: appEvents });
    const dispatches = [];
    const idleWaits = [];
    const serviceCalls = [];
    const capability = {
      environment: { PATH: '/bin' },
      getSnapshot: () => ({ available: true, checking: false, reason: null, version: 'test', checkedAt: now }),
      refreshIfStale: async () => ({
        available: true,
        checking: false,
        reason: null,
        version: 'test',
        checkedAt: now,
      }),
    };
    const reviewService = {
      run: async (input) => {
        serviceCalls.push(input);
        return {
          result: `Finding from ${reviewer}.`,
          noChanges: false,
          range: { fork: '1'.repeat(40), head: '2'.repeat(40) },
        };
      },
    };
    const config = parseConfig({ poll: { interval_seconds: 30, orgs: [], repos: [] } });
    const context = createAppContext({
      getConfig: () => config,
      getDb: () => db,
      appEvents,
      pollerEvents: new EventEmitter(),
      getSessionStates: () => [],
      getGhRateLimitState: () => ({ limited: false }),
      providerCapabilities: { claude: capability, codex: capability },
      peerReviewCoordinator: coordinator,
      getSessionPeerReviewReadiness: () => ({ ready: true, reason: null }),
      waitForFirstIdle: async (sessionId) => idleWaits.push(sessionId),
      dispatchToSession: async (sessionId, prompt) => {
        dispatches.push({ sessionId, prompt });
        return 1234;
      },
      reviewServices: { claude: reviewService, codex: reviewService },
    });
    const server = await createServer({ context, config });

    try {
      const nullBody = await server.inject({
        method: 'POST',
        url: '/api/workspaces/workspace-1/peer-review',
        payload: 'null',
        headers: { 'content-type': 'application/json' },
      });
      assert.equal(nullBody.statusCode, 400);

      const requested = await server.inject({
        method: 'POST',
        url: '/api/workspaces/workspace-1/peer-review',
        payload: {},
      });
      assert.equal(requested.statusCode, 202);
      assert.equal(requested.json().review.status, 'requested');
      assert.equal(requested.json().review.presenterProvider, presenter);
      assert.equal(requested.json().review.reviewerProvider, reviewer);
      assert.deepEqual(idleWaits, ['session-1']);
      assert.equal(dispatches.length, 1);
      assert.equal(dispatches[0].sessionId, 'session-1');
      assert.match(dispatches[0].prompt, new RegExp(tool));

      const wrongSession = await actionRegistry[tool].mcpHandler(server, {}, { callerSessionId: 'other' });
      assert.equal(wrongSession.error, 'review_not_ready');

      const result = await actionRegistry[tool].mcpHandler(server, {}, { callerSessionId: 'session-1' });
      assert.deepEqual(result, {
        ok: true,
        review: `Finding from ${reviewer}.`,
        no_changes: false,
        range: { fork: '1'.repeat(40), head: '2'.repeat(40) },
      });
      assert.equal(serviceCalls.length, 1);
      assert.equal(serviceCalls[0].workspace.id, 'workspace-1');
      assert.equal(coordinator.getByWorkspace('workspace-1').status, 'delivering');

      appEvents.emit('session-state', { sessionId: 'session-1', workspaceId: 'workspace-1', state: 'idle' });
      const status = await server.inject({ method: 'GET', url: '/api/workspaces/workspace-1/peer-review' });
      assert.equal(status.json().review.status, 'complete');
      assert.equal(status.json().reviewerProvider, reviewer);
      assert.equal(status.json().ready, true);
    } finally {
      await server.close();
      db.close();
    }
  });
}
