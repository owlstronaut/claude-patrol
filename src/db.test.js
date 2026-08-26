import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import { parseConfig, updateConfig } from './config.js';
import { closeDb, initDb } from './db.js';
import { CURRENT_SCHEMA_VERSION } from './migrations.js';

const temporaryDirectories = [];

afterEach(() => {
  closeDb();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'claude-patrol-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

test('a new database is migrated to the current schema', () => {
  const db = initDb(':memory:');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  assert.equal(version, CURRENT_SCHEMA_VERSION);

  const workspaceColumns = new Set(
    db
      .prepare("PRAGMA table_info('workspaces')")
      .all()
      .map((column) => column.name),
  );
  assert.ok(workspaceColumns.has('operation_state'));
  assert.ok(workspaceColumns.has('operation_error'));
  const sessionColumns = new Set(
    db
      .prepare("PRAGMA table_info('sessions')")
      .all()
      .map((column) => column.name),
  );
  assert.ok(sessionColumns.has('provider'));
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automation_jobs'").get());
  assert.ok(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_item_repository_additions'").get(),
  );
  assert.ok(
    db
      .prepare("PRAGMA table_info('work_item_repository_additions')")
      .all()
      .some((column) => column.name === 'start_revision'),
  );
  assert.ok(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_item_pull_requests'").get(),
  );
  assert.ok(
    db
      .prepare("PRAGMA table_info('prs')")
      .all()
      .some((column) => column.name === 'head_oid'),
  );
});

test('the v7 to current migration preserves workspaces and sessions', () => {
  const path = join(temporaryDirectory(), 'v7.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE prs (
      id TEXT PRIMARY KEY,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',
      repo TEXT NOT NULL,
      org TEXT NOT NULL,
      author TEXT NOT NULL,
      url TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_branch TEXT NOT NULL DEFAULT 'main',
      is_fork INTEGER NOT NULL DEFAULT 0,
      draft INTEGER NOT NULL DEFAULT 0,
      mergeable TEXT NOT NULL DEFAULT 'UNKNOWN',
      checks JSON NOT NULL DEFAULT '[]',
      reviews JSON NOT NULL DEFAULT '[]',
      labels JSON NOT NULL DEFAULT '[]',
      comments JSON NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );
    INSERT INTO prs (
      id, number, title, repo, org, author, url, branch, created_at, updated_at, synced_at
    ) VALUES (
      'acme/widgets#1', 1, 'Preserved PR', 'widgets', 'acme', 'octocat',
      'https://example.test/1', 'feature', '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      pr_id TEXT REFERENCES prs(id),
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      bookmark TEXT NOT NULL,
      repo TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      destroyed_at TEXT,
      operation_state TEXT NOT NULL DEFAULT 'ready',
      operation_step TEXT,
      operation_error TEXT,
      operation_updated_at TEXT
    );
    INSERT INTO workspaces (
      id, pr_id, name, path, bookmark, repo, created_at, operation_updated_at
    ) VALUES (
      'workspace-1', 'acme/widgets#1', 'acme-widgets-1', '/tmp/workspace-1',
      'feature', 'acme/widgets', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      claude_project_dir TEXT,
      transcript_path TEXT
    );
    INSERT INTO sessions (id, workspace_id, status, started_at)
    VALUES ('session-1', 'workspace-1', 'active', '2026-01-01T00:00:00.000Z');
    PRAGMA user_version = 7;
  `);
  legacy.close();

  const db = initDb(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(
    { ...db.prepare('SELECT id, workspace_id, work_item_id, provider FROM sessions').get() },
    {
      id: 'session-1',
      workspace_id: 'workspace-1',
      work_item_id: null,
      provider: 'claude',
    },
  );
  assert.deepEqual(
    { ...db.prepare('SELECT id, pr_id, work_item_id, repo FROM workspaces').get() },
    { id: 'workspace-1', pr_id: 'acme/widgets#1', work_item_id: null, repo: 'acme/widgets' },
  );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('a pre-v7 database is backed up and reset to the clean schema', () => {
  const path = join(temporaryDirectory(), 'legacy.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE prs (
      id TEXT PRIMARY KEY, number INTEGER NOT NULL, title TEXT NOT NULL,
      repo TEXT NOT NULL, org TEXT NOT NULL, author TEXT NOT NULL,
      url TEXT NOT NULL, branch TEXT NOT NULL, draft INTEGER NOT NULL DEFAULT 0,
      checks JSON NOT NULL DEFAULT '[]', reviews JSON NOT NULL DEFAULT '[]',
      labels JSON NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, synced_at TEXT NOT NULL
    );
    INSERT INTO prs VALUES (
      'acme/widgets#1', 1, 'Legacy PR', 'widgets', 'acme', 'octocat',
      'https://example.test/1', 'feature', 0, '[]', '[]', '[]',
      '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      pr_id TEXT NOT NULL REFERENCES prs(id),
      name TEXT NOT NULL, path TEXT NOT NULL, bookmark TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'destroyed')),
      created_at TEXT NOT NULL, destroyed_at TEXT
    );
    INSERT INTO workspaces VALUES (
      'workspace-1', 'acme/widgets#1', 'legacy', '/tmp/legacy', 'feature',
      'active', '2025-01-01T00:00:00.000Z', NULL
    );
  `);
  legacy.close();

  const db = initDb(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM prs').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get().count, 0);
  assert.equal(readFileSync(`${path}.backup-v0-to-v${CURRENT_SCHEMA_VERSION}`).length > 0, true);
});

test('the v10 migration preserves live global sessions and adds names', () => {
  const path = join(temporaryDirectory(), 'v10.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE work_items (id TEXT PRIMARY KEY);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT REFERENCES workspaces(id),
      work_item_id TEXT REFERENCES work_items(id),
      pid INTEGER,
      provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex')),
      status TEXT NOT NULL CHECK(status IN ('active', 'detached', 'killed')),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      claude_project_dir TEXT,
      transcript_path TEXT
    );
    INSERT INTO sessions (
      id, pid, provider, status, started_at, claude_project_dir, transcript_path
    ) VALUES
      ('global-claude', 101, 'claude', 'active', '2026-08-20T10:00:00.000Z', '/tmp/claude', '/tmp/claude.jsonl'),
      ('global-codex', 202, 'codex', 'detached', '2026-08-20T11:00:00.000Z', NULL, NULL);
    PRAGMA user_version = 10;
  `);
  legacy.close();

  const db = initDb(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(
    db
      .prepare(
        `SELECT id, name, pid, provider, status, started_at, claude_project_dir, transcript_path
           FROM sessions ORDER BY id`,
      )
      .all()
      .map((row) => ({ ...row })),
    [
      {
        id: 'global-claude',
        name: 'Claude',
        pid: 101,
        provider: 'claude',
        status: 'active',
        started_at: '2026-08-20T10:00:00.000Z',
        claude_project_dir: '/tmp/claude',
        transcript_path: '/tmp/claude.jsonl',
      },
      {
        id: 'global-codex',
        name: 'Codex',
        pid: 202,
        provider: 'codex',
        status: 'detached',
        started_at: '2026-08-20T11:00:00.000Z',
        claude_project_dir: null,
        transcript_path: null,
      },
    ],
  );
  assert.equal(readFileSync(`${path}.backup-v10-to-v${CURRENT_SCHEMA_VERSION}`).length > 0, true);
});

test('configuration defaults to loopback and authored polling cadence', () => {
  const config = parseConfig({ poll: { orgs: [], repos: [] } });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.poll.interval_seconds, 30);
});

test('configuration updates are validated before replacing the file', () => {
  const path = join(temporaryDirectory(), 'config.json');
  const original = {
    workspace_base_path: '~/portable-workspaces',
    poll: { interval_seconds: 30, orgs: ['acme'], repos: [] },
  };
  writeFileSync(path, `${JSON.stringify(original, null, 2)}\n`);

  const updated = updateConfig({ poll: { interval_seconds: 45 } }, path);
  assert.equal(updated.poll.interval_seconds, 45);
  assert.equal(updated.workspace_base_path.endsWith('/portable-workspaces'), true);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).workspace_base_path, '~/portable-workspaces');

  const beforeInvalidUpdate = readFileSync(path, 'utf8');
  assert.throws(() => updateConfig({ poll: { interval_seconds: 1 } }, path), /Invalid config/);
  assert.equal(readFileSync(path, 'utf8'), beforeInvalidUpdate);
  assert.throws(() => updateConfig({ poll: null }, path), /Invalid config/);
  assert.equal(readFileSync(path, 'utf8'), beforeInvalidUpdate);
});

test('the current schema enforces work-item progress and exclusive workspace and session targets', () => {
  const db = initDb(':memory:');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO work_items (
      id, reference, path, work_provider, resolver_provider, state, stage,
      progress_current, progress_total, created_at, updated_at
    ) VALUES ('item-1', 'PROJECT-1', '/tmp/item-1', 'claude', 'claude',
      'ready', 'complete', 0, 0, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO workspaces (
      id, work_item_id, name, path, bookmark, repo, status, created_at,
      operation_state, operation_updated_at
    ) VALUES ('child-1', 'item-1', 'child-1', '/tmp/child-1', 'patrol/work-item-1',
      'acme/widgets', 'active', ?, 'ready', ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO prs (
      id, number, title, repo, org, author, url, branch, created_at, updated_at, synced_at
    ) VALUES ('acme/widgets#1', 1, 'PR', 'widgets', 'acme', 'octocat',
      'https://example.test/1', 'feature', ?, ?, ?)`,
  ).run(now, now, now);
  assert.throws(() => db.prepare("UPDATE workspaces SET pr_id = 'acme/widgets#1' WHERE id = 'child-1'").run());

  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO sessions (id, workspace_id, work_item_id, provider, status, started_at)
       VALUES ('invalid-target', 'child-1', 'item-1', 'claude', 'active', ?)`,
      )
      .run(now),
  );
  db.prepare(
    `INSERT INTO sessions (id, work_item_id, provider, status, started_at)
     VALUES ('session-1', 'item-1', 'claude', 'active', ?)`,
  ).run(now);
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO sessions (id, work_item_id, provider, status, started_at)
       VALUES ('session-2', 'item-1', 'claude', 'detached', ?)`,
      )
      .run(now),
  );
  db.prepare("UPDATE sessions SET status = 'killed' WHERE id = 'session-1'").run();
  db.prepare(
    `INSERT INTO sessions (id, work_item_id, provider, status, started_at)
     VALUES ('session-2', 'item-1', 'claude', 'active', ?)`,
  ).run(now);
  assert.throws(() =>
    db.prepare('UPDATE work_items SET progress_current = 2, progress_total = 1 WHERE id = ?').run('item-1'),
  );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('the current schema allows one active child per work-item repository', () => {
  const db = initDb(':memory:');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO work_items (
      id, reference, path, work_provider, resolver_provider, state, stage,
      progress_current, progress_total, created_at, updated_at
    ) VALUES ('item-1', 'PROJECT-1', '/tmp/item-1', 'codex', 'codex',
      'preparing', 'child_creation', 0, 1, ?, ?)`,
  ).run(now, now);
  const insert = db.prepare(
    `INSERT INTO workspaces (
      id, work_item_id, name, path, bookmark, repo, status, created_at,
      operation_state, operation_updated_at
    ) VALUES (?, 'item-1', ?, ?, 'patrol/work-item-1', 'acme/widgets', ?, ?, 'ready', ?)`,
  );
  insert.run('child-1', 'child-1', '/tmp/child-1', 'active', now, now);
  assert.throws(() => insert.run('child-2', 'child-2', '/tmp/child-2', 'active', now, now));
  insert.run('child-2', 'child-2', '/tmp/child-2', 'destroyed', now, now);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
