import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createAppContext } from './app-context.js';
import { parseConfig } from './config.js';
import { migrateDb } from './migrations.js';
import { createServer } from './server.js';

function insertPr(db, { id, number, syncedAt }) {
  db.prepare(
    `INSERT INTO prs
      (id, number, title, repo, org, author, url, branch, created_at, updated_at,
       synced_at)
     VALUES (?, ?, ?, 'widgets', 'acme', 'octocat', ?, 'feature', ?, ?, ?)`,
  ).run(id, number, `PR ${number}`, `https://example.test/${number}`, syncedAt, syncedAt, syncedAt);
}

test('PR API uses injected dependencies and reports authored freshness', async () => {
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const current = new Date().toISOString();
  const old = '2020-01-01T00:00:00.000Z';
  insertPr(db, { id: 'acme/widgets#1', number: 1, syncedAt: current });
  insertPr(db, { id: 'acme/widgets#2', number: 2, syncedAt: old });
  db.prepare('UPDATE sync_state SET synced_at = ? WHERE id = 1').run(current);
  db.prepare(
    `INSERT INTO workspaces
      (id, pr_id, name, path, branch, status, created_at, operation_state, operation_step, operation_updated_at)
     VALUES ('ready-workspace', NULL, 'ready', '/tmp/ready', 'feature', 'active', ?, 'ready', 'create:complete', ?)`,
  ).run(current, current);
  db.prepare(
    `INSERT INTO workspaces
      (id, pr_id, name, path, branch, status, created_at, operation_state, operation_step, operation_error, operation_updated_at)
     VALUES ('failed-workspace', NULL, 'failed', '/tmp/failed', 'feature', 'active', ?, 'error', 'destroy:directory', 'failed', ?)`,
  ).run(current, current);
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, pid, status, started_at)
     VALUES ('session-1', 'ready-workspace', 123, 'active', ?)`,
  ).run(current);

  const config = parseConfig({ poll: { interval_seconds: 30, orgs: [], repos: [] } });
  const appEvents = new EventEmitter();
  const pollerEvents = new EventEmitter();
  const context = createAppContext({
    getConfig: () => config,
    getDb: () => db,
    appEvents,
    pollerEvents,
    getSessionStates: () => [],
    getGhRateLimitState: () => ({ limited: false }),
  });
  const server = await createServer({ context, config });
  assert.equal(appEvents.listenerCount('local-change'), 1);
  assert.equal(pollerEvents.listenerCount('sync'), 1);

  try {
    const authored = await server.inject({ method: 'GET', url: '/api/prs' });
    assert.equal(authored.statusCode, 200);
    assert.equal(authored.json().prs[0].id, 'acme/widgets#1');
    assert.equal(authored.json().synced_at, current);
    assert.equal(authored.json().freshness.stale, false);

    const workspaces = await server.inject({ method: 'GET', url: '/api/workspaces' });
    assert.deepEqual(
      workspaces.json().map((workspace) => workspace.id),
      ['ready-workspace'],
    );
    const operations = await server.inject({ method: 'GET', url: '/api/workspaces/operations' });
    assert.deepEqual(
      operations.json().map((workspace) => workspace.id),
      ['failed-workspace'],
    );
    const sessions = await server.inject({ method: 'GET', url: '/api/sessions' });
    assert.deepEqual(
      sessions.json().map((session) => session.id),
      ['session-1'],
    );

    const rejectedOrigin = await server.inject({
      method: 'GET',
      url: '/api/prs',
      headers: { host: 'patrol.test', origin: 'https://untrusted.example' },
    });
    assert.equal(rejectedOrigin.statusCode, 403);
  } finally {
    await server.close();
    assert.equal(appEvents.listenerCount('local-change'), 0);
    assert.equal(pollerEvents.listenerCount('sync'), 0);
    db.close();
  }
});
