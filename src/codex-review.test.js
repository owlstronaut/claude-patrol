import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCodexReviewService } from './codex-review.js';
import { resolveReviewRange } from './review-range.js';

const BASE = '1'.repeat(40);
const FORK = '3'.repeat(40);

function fakeGit(summary = 'M\tsrc/app.js') {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'fetch') return { stdout: '', stderr: '' };
    if (args[0] === 'rev-parse') return { stdout: `${BASE}\n`, stderr: '' };
    if (args[0] === 'merge-base') return { stdout: `${FORK}\n`, stderr: '' };
    if (args[0] === 'ls-files') return { stdout: '', stderr: '' };
    if (args[0] === 'add') return { stdout: '', stderr: '' };
    if (args[0] === 'reset') return { stdout: '', stderr: '' };
    if (args[0] === 'diff') return { stdout: summary, stderr: '' };
    throw new Error(`Unexpected git call: ${args.join(' ')}`);
  };
  return { run, calls };
}

test('review range refreshes the exact base and snapshots the current workspace', async () => {
  const path = await mkdtemp(join(tmpdir(), 'patrol-codex-range-'));
  const git = fakeGit();
  try {
    const resolvedPath = await realpath(path);
    const range = await resolveReviewRange({ workspacePath: path, baseBranch: 'release/v1', run: git.run });
    assert.deepEqual(range, {
      workspacePath: resolvedPath,
      base: BASE,
      fork: FORK,
      summary: 'M\tsrc/app.js',
    });
    assert.deepEqual(git.calls[0].args, ['fetch', 'origin', 'release/v1']);
    assert.ok(
      git.calls.some((call) => call.args[0] === 'rev-parse' && call.args.includes('refs/remotes/origin/release/v1')),
    );
    assert.ok(git.calls.some((call) => call.args[0] === 'merge-base' && call.args.includes('HEAD')));
    assert.ok(git.calls.some((call) => call.args[0] === 'diff' && call.args.includes('--name-status')));
  } finally {
    await rm(path, { recursive: true });
  }
});

test('review service calls the first-party Codex tool with a fixed read-only contract', async () => {
  const path = await mkdtemp(join(tmpdir(), 'patrol-codex-service-'));
  const git = fakeGit();
  const calls = [];
  let closed = false;
  const client = {
    async connect() {},
    async listTools() {
      return { tools: [{ name: 'codex' }] };
    },
    async callTool(params, _schema, options) {
      calls.push({ params, options });
      return { structuredContent: { threadId: 'thread-1', content: 'Finding: src/app.js has a bug.' } };
    },
    async close() {
      closed = true;
    },
  };
  const transport = { stderr: new EventEmitter() };
  const capability = { environment: { PATH: '/bin' } };
  const service = createCodexReviewService({ capability, run: git.run, connect: () => ({ client, transport }) });

  try {
    const resolvedPath = await realpath(path);
    const result = await service.run({
      reviewId: 'review-1',
      workspace: { id: 'workspace-1', path },
      pr: { id: 'acme/app#1', number: 1, org: 'acme', repo: 'app', base_branch: 'main' },
    });
    assert.equal(result.result, 'Finding: src/app.js has a bug.');
    assert.equal(result.noChanges, false);
    assert.equal(calls[0].params.name, 'codex');
    assert.equal(calls[0].params.arguments.cwd, resolvedPath);
    assert.equal(calls[0].params.arguments.sandbox, 'read-only');
    assert.equal(calls[0].params.arguments['approval-policy'], 'never');
    assert.match(calls[0].params.arguments.prompt, new RegExp(`git diff ${FORK}`));
    assert.doesNotMatch(calls[0].params.arguments.prompt, /M\tsrc\/app\.js/);
    assert.equal(closed, true);
  } finally {
    await rm(path, { recursive: true });
  }
});
