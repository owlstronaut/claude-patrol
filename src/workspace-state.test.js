import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { closeDb, getDb, initDb } from './db.js';
import { createScratchWorkspace, createWorkspace, destroyWorkspace, inspectWorkspaceState } from './workspace.js';

const temporaryDirectories = [];

afterEach(() => {
  closeDb();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function initGitRepo(path) {
  const run = (...args) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
  run('init', '--initial-branch=main');
  run('config', 'user.email', 'patrol@example.test');
  run('config', 'user.name', 'Patrol Test');
  // A signing key in the developer's global config would block this commit.
  run('config', 'commit.gpgsign', 'false');
  run('commit', '--allow-empty', '-m', 'initial');
  // Configured revisions are remote-tracking refs; fake one so the fixture
  // does not need a real remote.
  run('update-ref', 'refs/remotes/origin/main', 'HEAD');
}

function createScratchConfig() {
  const root = mkdtempSync(join(tmpdir(), 'patrol-workspace-state-'));
  temporaryDirectories.push(root);
  const source = join(root, 'sources', 'example', 'project');
  mkdirSync(source, { recursive: true });
  initGitRepo(source);
  return {
    source,
    config: {
      work_dir: join(root, 'sources'),
      workspace_base_path: join(root, 'workspaces'),
      symlink_memory: false,
      repos: { 'example/project': {} },
    },
  };
}

function insertWorkspace(overrides = {}) {
  const now = new Date().toISOString();
  const workspace = {
    id: overrides.id ?? 'workspace-1',
    pr_id: overrides.pr_id ?? null,
    name: overrides.name ?? 'test-workspace',
    path: overrides.path ?? '/path/that/does/not/exist',
    branch: 'feature',
    repo: overrides.repo ?? null,
    status: overrides.status ?? 'active',
    operation_state: overrides.operation_state ?? 'ready',
    operation_step: overrides.operation_step ?? 'create:complete',
    operation_error: overrides.operation_error ?? null,
    created_at: now,
    destroyed_at: overrides.destroyed_at ?? null,
    operation_updated_at: now,
  };
  getDb()
    .prepare(
      `INSERT INTO workspaces
        (id, pr_id, name, path, branch, repo, status, operation_state, operation_step,
         operation_error, created_at, destroyed_at, operation_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      workspace.id,
      workspace.pr_id,
      workspace.name,
      workspace.path,
      workspace.branch,
      workspace.repo,
      workspace.status,
      workspace.operation_state,
      workspace.operation_step,
      workspace.operation_error,
      workspace.created_at,
      workspace.destroyed_at,
      workspace.operation_updated_at,
    );
  return workspace;
}

test('workspace inspection reports interrupted and missing states without changing rows', () => {
  initDb(':memory:');
  insertWorkspace();
  insertWorkspace({ id: 'workspace-2', operation_state: 'destroying', operation_step: 'destroy:directory' });

  const before = getDb().prepare('SELECT * FROM workspaces ORDER BY id').all();
  const issues = inspectWorkspaceState();
  const after = getDb().prepare('SELECT * FROM workspaces ORDER BY id').all();

  assert.deepEqual(after, before);
  assert.deepEqual(
    issues.map((issue) => [issue.workspace_id, issue.state]),
    [
      ['workspace-1', 'inconsistent'],
      ['workspace-2', 'destroying'],
    ],
  );
});

test('destroying an already-complete workspace is idempotent', async () => {
  initDb(':memory:');
  getDb()
    .prepare(
      `INSERT INTO prs
        (id, number, title, repo, org, author, url, branch, created_at, updated_at, synced_at)
       VALUES ('example/project#1', 1, 'Test', 'project', 'example', 'octocat',
               'https://example.test/pr/1', 'feature', ?, ?, ?)`,
    )
    .run(...Array(3).fill(new Date().toISOString()));
  insertWorkspace({
    pr_id: 'example/project#1',
    status: 'destroyed',
    operation_state: 'destroyed',
    operation_step: 'destroy:complete',
    destroyed_at: new Date().toISOString(),
  });

  assert.deepEqual(await destroyWorkspace('workspace-1', { work_dir: '/tmp' }), { ok: true, warnings: [] });
  assert.deepEqual(
    { ...getDb().prepare('SELECT pr_id, repo FROM workspaces WHERE id = ?').get('workspace-1') },
    {
      pr_id: null,
      repo: 'example/project',
    },
  );
});

test('concurrent scratch creation rejects a duplicate repo and branch claim', async () => {
  initDb(':memory:');
  const { config } = createScratchConfig();

  const results = await Promise.allSettled([
    createScratchWorkspace('example/project', 'feature-race', config, { startRevision: 'refs/remotes/origin/main' }),
    createScratchWorkspace('example/project', 'feature-race', config, { startRevision: 'refs/remotes/origin/main' }),
  ]);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'workspace_conflict');
  assert.deepEqual(getDb().prepare('SELECT * FROM workspace_claims').all(), []);

  await destroyWorkspace(fulfilled[0].value.id, config);
});

test('destroy waits for an in-flight create of the same workspace', async () => {
  initDb(':memory:');
  const { source, config } = createScratchConfig();

  const creation = createScratchWorkspace('example/project', 'feature-create-destroy', config, {
    startRevision: 'refs/remotes/origin/main',
  });
  const reserved = getDb()
    .prepare("SELECT id FROM workspaces WHERE repo = ? AND branch = ? AND operation_state = 'creating'")
    .get('example/project', 'feature-create-destroy');
  assert.ok(reserved);

  const destruction = destroyWorkspace(reserved.id, config);
  const [created, destroyed] = await Promise.all([creation, destruction]);

  assert.equal(created.id, reserved.id);
  assert.deepEqual(destroyed, { ok: true, warnings: [] });
  assert.deepEqual(
    {
      ...getDb()
        .prepare('SELECT status, operation_state, operation_step FROM workspaces WHERE id = ?')
        .get(reserved.id),
    },
    { status: 'destroyed', operation_state: 'destroyed', operation_step: 'destroy:complete' },
  );
  assert.deepEqual(getDb().prepare('SELECT * FROM workspace_claims').all(), []);
  assert.doesNotMatch(
    execFileSync('git', ['worktree', 'list'], { cwd: source, encoding: 'utf8' }),
    /scratch-feature-create-destroy/,
  );
});

test('a PR workspace fetches from the remote hosting the PR repo, not always origin', async () => {
  initDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'patrol-fork-remote-'));
  temporaryDirectories.push(root);
  const source = join(root, 'sources', 'acme', 'widgets');
  mkdirSync(source, { recursive: true });
  initGitRepo(source);
  const git = (args, cwd = source) => execFileSync('git', args, { cwd, stdio: 'ignore' });

  // Two bare remotes. Only the canonical one's URL ends in the PR's org/repo.
  const canonical = join(root, 'remotes', 'acme', 'widgets.git');
  const forkRemote = join(root, 'remotes', 'myfork', 'widgets.git');
  mkdirSync(dirname(canonical), { recursive: true });
  mkdirSync(dirname(forkRemote), { recursive: true });
  git(['clone', '--bare', '-q', source, canonical], root);
  git(['clone', '--bare', '-q', source, forkRemote], root);

  // The PR branch exists only on the canonical remote.
  git(['branch', 'feature/pr-branch']);
  git(['push', '-q', canonical, 'feature/pr-branch']);
  git(['branch', '-D', 'feature/pr-branch']);
  git(['remote', 'add', 'origin', forkRemote]);
  git(['remote', 'add', 'upstream', canonical]);

  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO prs
        (id, number, title, repo, org, author, url, branch, created_at, updated_at, synced_at)
       VALUES ('acme/widgets#7', 7, 'Fork PR', 'widgets', 'acme', 'octocat',
               'https://example.test/pr/7', 'feature/pr-branch', ?, ?, ?)`,
    )
    .run(now, now, now);

  const config = {
    work_dir: join(root, 'sources'),
    workspace_base_path: join(root, 'workspaces'),
    symlink_memory: false,
    repos: { 'acme/widgets': {} },
  };

  // Fetching from `origin` would fail: the branch is not on the fork.
  const workspace = await createWorkspace('acme/widgets#7', config);
  assert.equal(workspace.operation_state, 'ready');
  assert.equal(workspace.branch, 'feature/pr-branch');
  assert.match(execFileSync('git', ['worktree', 'list'], { cwd: source, encoding: 'utf8' }), /widgets\/7/);

  await destroyWorkspace(workspace.id, config);
});
