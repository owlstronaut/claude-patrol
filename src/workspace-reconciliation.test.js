import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { afterEach, test } from 'node:test';
import { closeDb, getDb, initDb } from './db.js';
import { createScratchWorkspace } from './workspace.js';
import { PATROL_WORKSPACE_MARKER } from './workspace-ownership.js';
import { discoverPatrolWorkspaceDirectories, reconcilePatrolWorkspacesOnStartup } from './workspace-reconciliation.js';

const temporaryDirectories = [];

afterEach(() => {
  closeDb();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'patrol-workspace-reconciliation-'));
  temporaryDirectories.push(root);
  const source = join(root, 'sources', 'example', 'project');
  mkdirSync(source, { recursive: true });
  execFileSync('jj', ['git', 'init', '--colocate', source], { stdio: 'ignore' });
  const config = {
    work_dir: join(root, 'sources'),
    workspace_base_path: join(root, 'workspaces'),
    symlink_memory: false,
    repos: { 'example/project': {} },
  };
  initDb(':memory:');
  return { root, source, config };
}

function cleanupRuntime(root, overrides = {}) {
  const canonicalRoot = realpathSync(root);
  return {
    isPatrolAvailable: () => true,
    dockerDown: async () => null,
    removeDirectory: async (path) => {
      const relationToFixture = relative(canonicalRoot, path);
      if (relationToFixture !== '..' && !relationToFixture.startsWith(`..${sep}`)) {
        await rm(path, { recursive: true, force: true });
      }
    },
    ...overrides,
  };
}

async function orphanScratchWorkspace(config, branch) {
  const workspace = await createScratchWorkspace('example/project', branch, config, { startRevision: '@' });
  getDb().prepare('DELETE FROM workspaces WHERE id = ?').run(workspace.id);
  return workspace;
}

test('startup reconciliation deletes an empty orphan with a Patrol ownership marker', async () => {
  const { root, config } = createFixture();
  const workspace = await orphanScratchWorkspace(config, 'stale-empty');
  const canonicalPath = realpathSync(workspace.path);

  const result = await reconcilePatrolWorkspacesOnStartup(config, cleanupRuntime(root));

  assert.deepEqual(result.deleted, [canonicalPath]);
  assert.equal(existsSync(workspace.path), false);
  assert.deepEqual(getDb().prepare('SELECT * FROM workspace_orphans').all(), []);
});

test('an unmarked workspace is not deleted based on the legacy Patrol naming convention', async () => {
  const { root, source, config } = createFixture();
  const workspacePath = join(config.workspace_base_path, 'example', 'project', '23');
  mkdirSync(dirname(workspacePath), { recursive: true });
  execFileSync('jj', ['workspace', 'add', workspacePath, '--name', 'example-project-23', '-r', '@', '-R', source], {
    stdio: 'ignore',
  });

  const result = await reconcilePatrolWorkspacesOnStartup(config, cleanupRuntime(root));

  assert.deepEqual(result.deleted, []);
  assert.equal(existsSync(workspacePath), true);
});

test('a general jj workspace inside the workspace root is not Patrol-owned', async () => {
  const { root, source, config } = createFixture();
  const workspacePath = join(config.workspace_base_path, 'example', 'project', '24');
  mkdirSync(dirname(workspacePath), { recursive: true });
  execFileSync('jj', ['workspace', 'add', workspacePath, '--name', 'personal-24', '-r', '@', '-R', source], {
    stdio: 'ignore',
  });

  const result = await reconcilePatrolWorkspacesOnStartup(config, cleanupRuntime(root));

  assert.deepEqual(result.deleted, []);
  assert.equal(existsSync(workspacePath), true);
});

test('database provenance can clean a pre-marker workspace after a schema reset', async () => {
  const { root, source, config } = createFixture();
  const workspacePath = join(config.workspace_base_path, 'example', 'project', 'old-patrol');
  mkdirSync(dirname(workspacePath), { recursive: true });
  execFileSync('jj', ['workspace', 'add', workspacePath, '--name', 'old-patrol-name', '-r', '@', '-R', source], {
    stdio: 'ignore',
  });
  const canonicalPath = realpathSync(workspacePath);
  const now = '2026-08-01T00:00:00.000Z';
  getDb()
    .prepare(
      `INSERT INTO workspace_orphans (
        path, repo, workspace_name, ownership_source, first_seen, last_seen,
        operation_state, operation_step, operation_updated_at
      ) VALUES (?, 'example/project', 'old-patrol-name', 'database', ?, ?,
        'detected', 'destroy:detected', ?)`,
    )
    .run(canonicalPath, now, now, now);

  const result = await reconcilePatrolWorkspacesOnStartup(config, cleanupRuntime(root));

  assert.deepEqual(result.deleted, [canonicalPath]);
  assert.equal(existsSync(workspacePath), false);
});

test('startup adds an ownership marker to an existing database workspace', async () => {
  const { root, config } = createFixture();
  const workspace = await createScratchWorkspace('example/project', 'existing-unmarked', config, {
    startRevision: '@',
  });
  const markerPath = join(workspace.path, '.jj', PATROL_WORKSPACE_MARKER);
  rmSync(markerPath);

  const result = await reconcilePatrolWorkspacesOnStartup(config, cleanupRuntime(root));

  assert.deepEqual(result.deleted, []);
  assert.equal(existsSync(markerPath), true);
  assert.equal(existsSync(workspace.path), true);
});

test('startup retries a stale database workspace through the existing destroy stages', async () => {
  const { root, config } = createFixture();
  const workspace = await createScratchWorkspace('example/project', 'interrupted-cleanup', config, {
    startRevision: '@',
  });
  getDb()
    .prepare(
      `UPDATE workspaces
          SET operation_state = 'error', operation_step = 'destroy:docker',
              operation_error = 'interrupted'
        WHERE id = ?`,
    )
    .run(workspace.id);

  const result = await reconcilePatrolWorkspacesOnStartup(config, cleanupRuntime(root));
  const cleaned = getDb()
    .prepare('SELECT status, operation_state, operation_step FROM workspaces WHERE id = ?')
    .get(workspace.id);

  assert.deepEqual(result.cleanedWorkspaces, [workspace.id]);
  assert.deepEqual(
    { ...cleaned },
    { status: 'destroyed', operation_state: 'destroyed', operation_step: 'destroy:complete' },
  );
  assert.equal(existsSync(workspace.path), false);
});

test('unpublished changes block deletion and retain the original first-seen timestamp', async () => {
  const { root, config } = createFixture();
  const workspace = await orphanScratchWorkspace(config, 'stale-dirty');
  const canonicalPath = realpathSync(workspace.path);
  writeFileSync(join(workspace.path, 'unpublished.txt'), 'keep me\n');
  let current = '2026-08-01T00:00:00.000Z';

  const first = await reconcilePatrolWorkspacesOnStartup(config, cleanupRuntime(root, { now: () => current }));
  const firstRow = getDb().prepare('SELECT * FROM workspace_orphans WHERE path = ?').get(canonicalPath);
  current = '2026-08-02T00:00:00.000Z';
  const second = await reconcilePatrolWorkspacesOnStartup(config, cleanupRuntime(root, { now: () => current }));
  const secondRow = getDb().prepare('SELECT * FROM workspace_orphans WHERE path = ?').get(canonicalPath);

  assert.equal(first.blocked[0].code, 'jj_fetch_failed');
  assert.equal(second.blocked[0].code, 'jj_fetch_failed');
  assert.equal(firstRow.first_seen, '2026-08-01T00:00:00.000Z');
  assert.equal(secondRow.first_seen, firstRow.first_seen);
  assert.equal(secondRow.last_seen, '2026-08-02T00:00:00.000Z');
  assert.equal(existsSync(workspace.path), true);
});

test('a process using an orphan tree blocks automatic deletion', async () => {
  const { root, config } = createFixture();
  const workspace = await orphanScratchWorkspace(config, 'stale-in-use');
  const child = spawn('sleep', ['30'], { cwd: workspace.path, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });

  try {
    const result = await reconcilePatrolWorkspacesOnStartup(config, cleanupRuntime(root));
    assert.equal(result.blocked[0].code, 'workspace_in_use');
    assert.equal(existsSync(workspace.path), true);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('Docker teardown failure preserves the tree and retries on the next startup', async () => {
  const { root, config } = createFixture();
  const workspace = await orphanScratchWorkspace(config, 'stale-docker');
  const canonicalPath = realpathSync(workspace.path);

  const first = await reconcilePatrolWorkspacesOnStartup(
    config,
    cleanupRuntime(root, { dockerDown: async () => 'compose down failed' }),
  );
  const failed = getDb().prepare('SELECT * FROM workspace_orphans WHERE path = ?').get(canonicalPath);
  const second = await reconcilePatrolWorkspacesOnStartup(config, cleanupRuntime(root));

  assert.equal(first.blocked[0].code, 'docker_cleanup_failed');
  assert.equal(failed.operation_state, 'error');
  assert.equal(failed.operation_step, 'destroy:docker');
  assert.deepEqual(second.deleted, [canonicalPath]);
  assert.equal(existsSync(workspace.path), false);
});

test('ignored build artifacts are expendable inside a proven Patrol workspace', async () => {
  const { root, source, config } = createFixture();
  writeFileSync(join(source, '.gitignore'), 'node_modules/\n');
  execFileSync('jj', ['status', '-R', source], { stdio: 'ignore' });
  const workspace = await orphanScratchWorkspace(config, 'stale-ignored');
  mkdirSync(join(workspace.path, 'node_modules'), { recursive: true });
  writeFileSync(join(workspace.path, 'node_modules', 'artifact.bin'), 'generated\n');

  const result = await reconcilePatrolWorkspacesOnStartup(config, cleanupRuntime(root));

  assert.equal(result.deleted.length, 1);
  assert.equal(existsSync(workspace.path), false);
});

test('a non-empty commit is deleted only after it is fetched from a remote bookmark', async () => {
  const { root, source, config } = createFixture();
  const remote = join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: source, stdio: 'ignore' });
  const workspace = await createScratchWorkspace('example/project', 'stale-published', config, {
    startRevision: '@',
  });
  writeFileSync(join(workspace.path, 'published.txt'), 'published\n');
  execFileSync('jj', ['bookmark', 'set', 'stale-published', '-r', '@', '-R', workspace.path], { stdio: 'ignore' });
  execFileSync(
    'jj',
    [
      'git',
      'push',
      '--bookmark',
      'stale-published',
      '--allow-empty-description',
      '--config',
      'git.sign-on-push=false',
      '-R',
      workspace.path,
    ],
    { stdio: 'ignore' },
  );
  getDb().prepare('DELETE FROM workspaces WHERE id = ?').run(workspace.id);

  const result = await reconcilePatrolWorkspacesOnStartup(config, cleanupRuntime(root));

  assert.equal(result.deleted.length, 1);
  assert.equal(existsSync(workspace.path), false);
});

test('reconciliation does not inspect or delete a workspace outside the configured root through a symlink', async () => {
  const { root, source, config } = createFixture();
  const external = join(root, 'external-workspace');
  execFileSync('jj', ['workspace', 'add', external, '--name', 'example-project-17', '-r', '@', '-R', source], {
    stdio: 'ignore',
  });
  const linkedPath = join(config.workspace_base_path, 'example', 'project', '17');
  mkdirSync(dirname(linkedPath), { recursive: true });
  symlinkSync(external, linkedPath);

  const discovery = await discoverPatrolWorkspaceDirectories(config);
  const result = await reconcilePatrolWorkspacesOnStartup(config, cleanupRuntime(root));

  assert.deepEqual(discovery.candidates, []);
  assert.deepEqual(result.deleted, []);
  assert.equal(existsSync(external), true);
});

test('cleanup is disabled when Patrol is unavailable', async () => {
  const { root, config } = createFixture();
  const workspace = await orphanScratchWorkspace(config, 'stale-unavailable');

  const result = await reconcilePatrolWorkspacesOnStartup(
    config,
    cleanupRuntime(root, { isPatrolAvailable: () => false }),
  );

  assert.deepEqual(result.deleted, []);
  assert.match(result.warnings[0], /unavailable/);
  assert.equal(existsSync(workspace.path), true);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM workspace_orphans').get().count, 0);
});
