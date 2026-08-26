import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { closeDb, getDb, initDb } from './db.js';
import { execFile } from './utils.js';
import { createWorkItemChild, destroyWorkItemChild } from './workspace.js';

const temporaryDirectories = [];

afterEach(() => {
  closeDb();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createSource(path) {
  mkdirSync(path, { recursive: true });
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

function worktreeList(source) {
  return execFileSync('git', ['worktree', 'list'], { cwd: source, encoding: 'utf8' });
}

function branchList(source) {
  return execFileSync('git', ['branch', '--list'], { cwd: source, encoding: 'utf8' });
}

test('work-item children are independent git worktrees under one non-repository parent', async () => {
  initDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'patrol-work-item-workspaces-'));
  temporaryDirectories.push(root);
  const workDir = join(root, 'sources');
  const parent = join(root, 'work-items', 'item-1');
  const alphaSource = join(workDir, 'acme', 'alpha');
  const betaSource = join(workDir, 'acme', 'beta');
  createSource(alphaSource);
  createSource(betaSource);
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO work_items (
        id, reference, path, work_provider, resolver_provider, state, stage,
        progress_current, progress_total, created_at, updated_at
      ) VALUES ('item-1', 'PROJECT-1', ?, 'codex', 'codex', 'preparing',
        'child_creation', 0, 2, ?, ?)`,
    )
    .run(parent, now, now);
  const config = {
    work_dir: workDir,
    workspace_base_path: join(root, 'workspaces'),
    symlink_memory: false,
    repos: {
      'acme/alpha': { defaultRevision: 'refs/remotes/origin/main' },
      'acme/beta': { defaultRevision: 'refs/remotes/origin/main' },
    },
  };
  const branch = 'patrol/work-item-item1';
  const children = [
    { id: 'child-alpha', repo: 'acme/alpha', name: 'item-alpha', path: join(parent, 'repos', 'alpha') },
    { id: 'child-beta', repo: 'acme/beta', name: 'item-beta', path: join(parent, 'repos', 'beta') },
  ];

  for (const child of children) {
    await createWorkItemChild({
      id: child.id,
      workItemId: 'item-1',
      repo: child.repo,
      name: child.name,
      workspacePath: child.path,
      branch,
      config,
    });
  }

  // A linked worktree carries a .git file pointing back at its source repo, so
  // each child is a repository root while the parent stays a plain directory.
  assert.equal(existsSync(join(parent, '.git')), false);
  assert.equal(existsSync(join(children[0].path, '.git')), true);
  assert.equal(existsSync(join(children[1].path, '.git')), true);
  assert.match(worktreeList(alphaSource), /repos\/alpha/);
  assert.match(worktreeList(betaSource), /repos\/beta/);
  assert.match(branchList(alphaSource), /patrol\/work-item-item1/);
  assert.match(branchList(betaSource), /patrol\/work-item-item1/);
  assert.deepEqual(
    getDb()
      .prepare('SELECT repo, operation_state FROM workspaces ORDER BY repo')
      .all()
      .map((row) => ({ ...row })),
    [
      { repo: 'acme/alpha', operation_state: 'ready' },
      { repo: 'acme/beta', operation_state: 'ready' },
    ],
  );
  assert.deepEqual(getDb().prepare('SELECT * FROM workspace_claims').all(), []);

  await assert.rejects(
    destroyWorkItemChild(children[0].id, config, {
      deleteBranch: false,
      runExec: async (command, args, options) => {
        if (command === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
          const error = new Error('injected worktree remove failure');
          error.code = 'injected_failure';
          throw error;
        }
        return execFile(command, args, options);
      },
    }),
    (error) => error.code === 'workspace_remove_failed',
  );
  assert.equal(existsSync(children[0].path), true);
  assert.match(worktreeList(alphaSource), /repos\/alpha/);
  assert.deepEqual(
    {
      ...getDb().prepare('SELECT operation_state, operation_step FROM workspaces WHERE id = ?').get(children[0].id),
    },
    { operation_state: 'error', operation_step: 'destroy:remove_worktree' },
  );

  await destroyWorkItemChild(children[0].id, config, { deleteBranch: true });
  await destroyWorkItemChild(children[1].id, config, { deleteBranch: false });
  assert.equal(existsSync(children[0].path), false);
  assert.equal(existsSync(children[1].path), false);
  assert.doesNotMatch(worktreeList(alphaSource), /repos\/alpha/);
  assert.doesNotMatch(worktreeList(betaSource), /repos\/beta/);
  assert.doesNotMatch(branchList(alphaSource), /patrol\/work-item-item1/);
  assert.match(branchList(betaSource), /patrol\/work-item-item1/);
});
