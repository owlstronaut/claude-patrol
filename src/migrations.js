/** Schema v7 intentionally resets every pre-v7 database. */

export const CURRENT_SCHEMA_VERSION = 13;

function createWorkItemTables(db) {
  db.exec(`
    CREATE TABLE work_items (
      id TEXT PRIMARY KEY,
      reference TEXT NOT NULL,
      title TEXT,
      summary TEXT,
      resolved_repositories_json JSON,
      path TEXT NOT NULL UNIQUE,
      work_provider TEXT NOT NULL CHECK(work_provider IN ('claude', 'codex')),
      resolver_provider TEXT NOT NULL CHECK(resolver_provider IN ('claude', 'codex')),
      state TEXT NOT NULL CHECK(state IN ('resolving', 'preparing', 'ready', 'error', 'destroying', 'destroyed')),
      stage TEXT NOT NULL CHECK(stage IN (
        'provider_check', 'reference_resolution', 'root_generation', 'child_creation',
        'child_compensation', 'session_launch', 'session_stop', 'transcript_archive',
        'child_destruction', 'root_destruction', 'complete'
      )),
      progress_current INTEGER NOT NULL DEFAULT 0 CHECK(progress_current >= 0),
      progress_total INTEGER NOT NULL DEFAULT 0 CHECK(progress_total >= 0 AND progress_current <= progress_total),
      error_code TEXT,
      error_detail TEXT,
      error_provider TEXT CHECK(error_provider IN ('claude', 'codex')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      destroyed_at TEXT
    );

    CREATE INDEX idx_work_items_state ON work_items(state);
  `);
}

function createSessionsTable(db) {
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT REFERENCES workspaces(id),
      work_item_id TEXT REFERENCES work_items(id),
      name TEXT,
      pid INTEGER,
      provider TEXT NOT NULL DEFAULT 'claude' CHECK(provider IN ('claude', 'codex')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'detached', 'killed')),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      claude_project_dir TEXT,
      transcript_path TEXT,
      CHECK(NOT (workspace_id IS NOT NULL AND work_item_id IS NOT NULL))
    );

    CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
    CREATE INDEX idx_sessions_work_item ON sessions(work_item_id);
    CREATE UNIQUE INDEX idx_sessions_live_work_item
      ON sessions(work_item_id)
      WHERE work_item_id IS NOT NULL AND status IN ('active', 'detached');
  `);
}

function createWorkspaceTablesV9(db) {
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      pr_id TEXT REFERENCES prs(id),
      work_item_id TEXT REFERENCES work_items(id),
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      bookmark TEXT NOT NULL,
      repo TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'destroyed')),
      created_at TEXT NOT NULL,
      destroyed_at TEXT,
      operation_state TEXT NOT NULL DEFAULT 'ready',
      operation_step TEXT,
      operation_error TEXT,
      operation_updated_at TEXT,
      start_revision TEXT,
      base_commit TEXT,
      setup_warnings_json JSON,
      CHECK(NOT (pr_id IS NOT NULL AND work_item_id IS NOT NULL))
    );

    CREATE INDEX idx_workspaces_pr ON workspaces(pr_id);
    CREATE INDEX idx_workspaces_work_item ON workspaces(work_item_id);
    CREATE INDEX idx_workspaces_operation_state ON workspaces(operation_state);
    CREATE UNIQUE INDEX idx_workspaces_active_pr
      ON workspaces(pr_id) WHERE status = 'active';
    CREATE UNIQUE INDEX idx_workspaces_active_work_item_repo
      ON workspaces(work_item_id, repo)
      WHERE work_item_id IS NOT NULL AND status = 'active';

    CREATE TABLE workspace_claims (
      repo TEXT NOT NULL,
      bookmark TEXT NOT NULL,
      workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id),
      operation TEXT NOT NULL CHECK(operation IN ('create', 'destroy')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (repo, bookmark)
    );
  `);
  createSessionsTable(db);
}

function createWorkspaceTablesV13(db) {
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      pr_id TEXT REFERENCES prs(id),
      work_item_id TEXT REFERENCES work_items(id),
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      branch TEXT NOT NULL,
      repo TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'destroyed')),
      created_at TEXT NOT NULL,
      destroyed_at TEXT,
      operation_state TEXT NOT NULL DEFAULT 'ready',
      operation_step TEXT,
      operation_error TEXT,
      operation_updated_at TEXT,
      start_revision TEXT,
      base_commit TEXT,
      setup_warnings_json JSON,
      CHECK(NOT (pr_id IS NOT NULL AND work_item_id IS NOT NULL))
    );

    CREATE INDEX idx_workspaces_pr ON workspaces(pr_id);
    CREATE INDEX idx_workspaces_work_item ON workspaces(work_item_id);
    CREATE INDEX idx_workspaces_operation_state ON workspaces(operation_state);
    CREATE UNIQUE INDEX idx_workspaces_active_pr
      ON workspaces(pr_id) WHERE status = 'active';
    CREATE UNIQUE INDEX idx_workspaces_active_work_item_repo
      ON workspaces(work_item_id, repo)
      WHERE work_item_id IS NOT NULL AND status = 'active';

    CREATE TABLE workspace_claims (
      repo TEXT NOT NULL,
      branch TEXT NOT NULL,
      workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id),
      operation TEXT NOT NULL CHECK(operation IN ('create', 'destroy')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (repo, branch)
    );
  `);
}

/**
 * Rename the `bookmark` column to `branch` on workspaces and workspace_claims.
 * A table rebuild would repoint sessions.workspace_id at the temporary table
 * and break the foreign key, so rename the column in place instead. No-op if
 * already renamed.
 */
function migrateV12ToV13(db) {
  const hasBookmark = db
    .prepare("PRAGMA table_info('workspaces')")
    .all()
    .some((column) => column.name === 'bookmark');
  if (!hasBookmark) return;

  db.exec(`
    ALTER TABLE workspaces RENAME COLUMN bookmark TO branch;
    ALTER TABLE workspace_claims RENAME COLUMN bookmark TO branch;
  `);
}

function addSessionNames(db) {
  const hasName = db
    .prepare("PRAGMA table_info('sessions')")
    .all()
    .some((column) => column.name === 'name');
  if (!hasName) db.exec('ALTER TABLE sessions ADD COLUMN name TEXT');

  db.exec(`
    UPDATE sessions
       SET name = CASE provider WHEN 'codex' THEN 'Codex' ELSE 'Claude' END
     WHERE workspace_id IS NULL
       AND work_item_id IS NULL
       AND (name IS NULL OR trim(name) = '')
  `);
}

function createWorkItemRepositoryAdditionTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_item_repository_additions (
      work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
      repository TEXT NOT NULL,
      start_revision TEXT NOT NULL,
      workspace_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
  `);
}

function createWorkItemPullRequestTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_item_pull_requests (
      pr_id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      source TEXT NOT NULL CHECK(source IN ('explicit', 'provenance')),
      linked_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_item_pull_requests_work_item
      ON work_item_pull_requests(work_item_id, linked_at DESC);
  `);
}

function addPrHeadOid(db) {
  const hasPrs = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'prs'").get();
  if (!hasPrs) return;
  const hasHeadOid = db
    .prepare("PRAGMA table_info('prs')")
    .all()
    .some((column) => column.name === 'head_oid');
  if (!hasHeadOid) db.exec('ALTER TABLE prs ADD COLUMN head_oid TEXT');
}

function resetSchema(db) {
  db.exec(`
    DROP TABLE IF EXISTS automation_jobs;
    DROP TABLE IF EXISTS rule_subscriptions;
    DROP TABLE IF EXISTS rule_runs;
    DROP TABLE IF EXISTS work_item_pull_requests;
    DROP TABLE IF EXISTS work_item_repository_additions;
    DROP TABLE IF EXISTS workspace_claims;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS workspaces;
    DROP TABLE IF EXISTS work_items;
    DROP TABLE IF EXISTS sync_state;
    DROP TABLE IF EXISTS prs;

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
      head_oid TEXT,
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

    CREATE INDEX idx_prs_org ON prs(org);
    CREATE INDEX idx_prs_repo ON prs(repo);

    CREATE TABLE rule_runs (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      pr_id TEXT,
      workspace_id TEXT,
      session_id TEXT,
      cooldown_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'success', 'error')),
      error TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );

    CREATE INDEX idx_rule_runs_cooldown
      ON rule_runs(rule_id, cooldown_key, started_at);
    CREATE INDEX idx_rule_runs_started ON rule_runs(started_at DESC);

    CREATE TABLE rule_subscriptions (
      rule_id TEXT NOT NULL,
      pr_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (rule_id, pr_id)
    );

    CREATE INDEX idx_rule_subscriptions_pr ON rule_subscriptions(pr_id);

    CREATE TABLE sync_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      synced_at TEXT,
      last_sweep_at TEXT,
      last_full_sweep_at TEXT
    );

    INSERT INTO sync_state (id) VALUES (1);

    CREATE TABLE automation_jobs (
      id TEXT PRIMARY KEY REFERENCES rule_runs(id) ON DELETE CASCADE,
      payload JSON NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'done', 'cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      dedupe_key TEXT
    );

    CREATE INDEX idx_automation_jobs_status
      ON automation_jobs(status, created_at);
    CREATE UNIQUE INDEX idx_automation_jobs_dedupe
      ON automation_jobs(dedupe_key) WHERE dedupe_key IS NOT NULL;
  `);
  createWorkItemTables(db);
  createWorkspaceTablesV13(db);
  createSessionsTable(db);
  createWorkItemRepositoryAdditionTable(db);
  createWorkItemPullRequestTable(db);
}

function v8InvalidReferences(db) {
  const invalidWorkspacePrs = db
    .prepare(
      `SELECT w.id FROM workspaces w
       LEFT JOIN prs p ON p.id = w.pr_id
       WHERE w.pr_id IS NOT NULL AND p.id IS NULL
       ORDER BY w.id`,
    )
    .all()
    .map((row) => row.id);
  const invalidSessionWorkspaces = db
    .prepare(
      `SELECT s.id FROM sessions s
       LEFT JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.workspace_id IS NOT NULL AND w.id IS NULL
       ORDER BY s.id`,
    )
    .all()
    .map((row) => row.id);
  return { invalidWorkspacePrs, invalidSessionWorkspaces };
}

function migrateV8ToV9(db) {
  const invalid = v8InvalidReferences(db);
  if (invalid.invalidWorkspacePrs.length || invalid.invalidSessionWorkspaces.length) {
    throw new Error(
      `Cannot migrate v8 database: invalid workspace PR rows [${invalid.invalidWorkspacePrs.join(', ')}]; ` +
        `invalid session workspace rows [${invalid.invalidSessionWorkspaces.join(', ')}]`,
    );
  }

  db.exec(`
    DROP INDEX IF EXISTS idx_workspaces_pr;
    DROP INDEX IF EXISTS idx_workspaces_operation_state;
    DROP INDEX IF EXISTS idx_workspaces_active_pr;
    DROP INDEX IF EXISTS idx_sessions_workspace;
    ALTER TABLE sessions RENAME TO sessions_v8;
    ALTER TABLE workspaces RENAME TO workspaces_v8;
  `);

  createWorkItemTables(db);
  createWorkspaceTablesV9(db);

  db.exec(`
    INSERT INTO workspaces (
      id, pr_id, work_item_id, name, path, bookmark, repo, status, created_at,
      destroyed_at, operation_state, operation_step, operation_error,
      operation_updated_at, start_revision, base_commit, setup_warnings_json
    )
    SELECT
      id, pr_id, NULL, name, path, bookmark, repo, status, created_at,
      destroyed_at, operation_state, operation_step, operation_error,
      operation_updated_at, NULL, NULL, NULL
    FROM workspaces_v8;

    INSERT INTO sessions (
      id, workspace_id, work_item_id, pid, provider, status, started_at, ended_at,
      claude_project_dir, transcript_path
    )
    SELECT
      id, workspace_id, NULL, pid, provider, status, started_at, ended_at,
      claude_project_dir, transcript_path
    FROM sessions_v8;

    DROP TABLE sessions_v8;
    DROP TABLE workspaces_v8;
  `);
}

/**
 * Upgrade a database to the current schema. Databases older than v7 still
 * take the intentional clean reset. Later migrations preserve authored rows.
 */
export function migrateDb(db) {
  const row = db.prepare('PRAGMA user_version').get();
  const version = Number(row?.user_version ?? 0);
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Database schema ${version} is newer than supported schema ${CURRENT_SCHEMA_VERSION}`);
  }
  if (version === CURRENT_SCHEMA_VERSION) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (version < 7) {
      resetSchema(db);
    } else if (version === 7) {
      db.exec(
        "ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude' CHECK(provider IN ('claude', 'codex'))",
      );
      migrateV8ToV9(db);
    } else if (version === 8) {
      migrateV8ToV9(db);
    }
    createWorkItemRepositoryAdditionTable(db);
    addSessionNames(db);
    addPrHeadOid(db);
    createWorkItemPullRequestTable(db);
    migrateV12ToV13(db);
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
    db.exec('COMMIT');
    const kind = version < 7 ? 'Destructive schema reset' : 'Schema migration';
    console.log(`[db] ${kind} to version ${CURRENT_SCHEMA_VERSION} complete`);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
