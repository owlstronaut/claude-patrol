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
  execFileSync('jj', ['git', 'init', '--colocate', path], { stdio: 'ignore' });
}

test('work-item children are independent jj workspaces under one non-repository parent', async () => {
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
      'acme/alpha': { defaultRevision: '@' },
      'acme/beta': { defaultRevision: '@' },
    },
  };
  const bookmark = 'patrol/work-item-item1';
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
      bookmark,
      config,
    });
  }

  assert.equal(existsSync(join(parent, '.jj')), false);
  assert.equal(existsSync(join(children[0].path, '.jj')), true);
  assert.equal(existsSync(join(children[1].path, '.jj')), true);
  assert.match(execFileSync('jj', ['workspace', 'list', '-R', alphaSource], { encoding: 'utf8' }), /item-alpha/);
  assert.match(execFileSync('jj', ['workspace', 'list', '-R', betaSource], { encoding: 'utf8' }), /item-beta/);
  assert.match(
    execFileSync('jj', ['bookmark', 'list', bookmark, '-R', alphaSource], { encoding: 'utf8' }),
    /patrol\/work-item-item1/,
  );
  assert.match(
    execFileSync('jj', ['bookmark', 'list', bookmark, '-R', betaSource], { encoding: 'utf8' }),
    /patrol\/work-item-item1/,
  );
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
      deleteBookmark: false,
      runExec: async (command, args, options) => {
        if (command === 'jj' && args[0] === 'workspace' && args[1] === 'forget') {
          const error = new Error('injected forget failure');
          error.code = 'injected_failure';
          throw error;
        }
        return execFile(command, args, options);
      },
    }),
    (error) => error.code === 'workspace_forget_failed',
  );
  assert.equal(existsSync(children[0].path), true);
  assert.match(execFileSync('jj', ['workspace', 'list', '-R', alphaSource], { encoding: 'utf8' }), /item-alpha/);
  assert.deepEqual(
    {
      ...getDb().prepare('SELECT operation_state, operation_step FROM workspaces WHERE id = ?').get(children[0].id),
    },
    { operation_state: 'error', operation_step: 'destroy:forget_workspace' },
  );

  execFileSync('jj', ['bookmark', 'delete', bookmark, '-R', alphaSource]);
  await destroyWorkItemChild(children[0].id, config, { deleteBookmark: true });
  await destroyWorkItemChild(children[1].id, config, { deleteBookmark: false });
  assert.equal(existsSync(children[0].path), false);
  assert.equal(existsSync(children[1].path), false);
  assert.doesNotMatch(execFileSync('jj', ['workspace', 'list', '-R', alphaSource], { encoding: 'utf8' }), /item-alpha/);
  assert.doesNotMatch(execFileSync('jj', ['workspace', 'list', '-R', betaSource], { encoding: 'utf8' }), /item-beta/);
  assert.doesNotMatch(
    execFileSync('jj', ['bookmark', 'list', bookmark, '-R', alphaSource], { encoding: 'utf8' }),
    /patrol\/work-item-item1/,
  );
  assert.match(
    execFileSync('jj', ['bookmark', 'list', bookmark, '-R', betaSource], { encoding: 'utf8' }),
    /patrol\/work-item-item1/,
  );
});
