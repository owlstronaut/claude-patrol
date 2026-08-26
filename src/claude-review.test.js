import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildClaudeReviewArgs, createClaudeReviewService } from './claude-review.js';

const BASE = '1'.repeat(40);
const FORK = '3'.repeat(40);

function fakeGit() {
  const calls = [];
  const run = async (_command, args, options) => {
    calls.push({ args, options });
    if (args[0] === 'fetch') return { stdout: '' };
    if (args[0] === 'rev-parse') return { stdout: `${BASE}\n` };
    if (args[0] === 'merge-base') return { stdout: `${FORK}\n` };
    if (args[0] === 'ls-files') return { stdout: '' };
    if (args[0] === 'add') return { stdout: '' };
    if (args[0] === 'reset') return { stdout: '' };
    if (args[0] === 'diff') return { stdout: 'diff --git a/src/app.js b/src/app.js\n+bug\n' };
    throw new Error(`Unexpected git call: ${args.join(' ')}`);
  };
  return { run, calls };
}

test('Claude review receives the complete diff over stdin with a read-only CLI contract', async () => {
  const path = await mkdtemp(join(tmpdir(), 'patrol-claude-review-'));
  const calls = [];
  const git = fakeGit();
  const service = createClaudeReviewService({
    capability: { environment: { PATH: '/bin' } },
    run: git.run,
    runClaude: async (input) => {
      calls.push(input);
      return { stdout: JSON.stringify({ is_error: false, result: 'Finding: src/app.js has a bug.' }) };
    },
  });

  try {
    const result = await service.run({
      reviewId: 'review-1',
      workspace: { id: 'workspace-1', path },
      pr: { id: 'acme/app#1', number: 1, org: 'acme', repo: 'app', base_branch: 'main' },
    });
    assert.equal(result.result, 'Finding: src/app.js has a bug.');
    assert.match(calls[0].diff, /diff --git/);
    assert.match(calls[0].prompt, new RegExp(`fork point ${FORK}`));
    assert.deepEqual(calls[0].environment, { PATH: '/bin' });
    assert.ok(git.calls.some((call) => call.args[0] === 'ls-files'));
    assert.ok(git.calls.some((call) => call.args[0] === 'diff' && call.args.includes(FORK)));

    const args = buildClaudeReviewArgs('review prompt');
    assert.ok(args.includes('--safe-mode'));
    assert.ok(args.includes('--no-session-persistence'));
    assert.deepEqual(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2), [
      '--permission-mode',
      'dontAsk',
    ]);
    assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', 'Read,Glob,Grep']);
  } finally {
    await rm(path, { recursive: true });
  }
});

test('Claude review stages untracked files with intent-to-add and unstages them afterward', async () => {
  const path = await mkdtemp(join(tmpdir(), 'patrol-claude-review-'));
  const git = fakeGit();
  const originalRun = git.run;
  const run = async (command, args, options) => {
    if (args[0] === 'ls-files') return { stdout: 'new-file.js\n' };
    return originalRun(command, args, options);
  };
  const service = createClaudeReviewService({
    capability: { environment: { PATH: '/bin' } },
    run: (command, args, options) => {
      git.calls.push({ args, options });
      return run(command, args, options);
    },
    runClaude: async () => ({ stdout: JSON.stringify({ is_error: false, result: 'No findings.' }) }),
  });

  try {
    await service.run({
      reviewId: 'review-1',
      workspace: { id: 'workspace-1', path },
      pr: { id: 'acme/app#1', number: 1, org: 'acme', repo: 'app', base_branch: 'main' },
    });
    const addCall = git.calls.find((call) => call.args[0] === 'add');
    const resetCall = git.calls.find((call) => call.args[0] === 'reset');
    assert.ok(addCall, 'expected git add -N for untracked files');
    assert.deepEqual(addCall.args, ['add', '-N', '--', 'new-file.js']);
    assert.ok(resetCall, 'expected git reset to undo the intent-to-add staging');
    assert.deepEqual(resetCall.args, ['reset', '--quiet', '--', 'new-file.js']);
    const diffCalls = git.calls.filter((call) => call.args[0] === 'diff');
    assert.ok(git.calls.indexOf(addCall) < git.calls.indexOf(diffCalls[0]));
    assert.ok(git.calls.indexOf(resetCall) > git.calls.indexOf(diffCalls.at(-1)));
  } finally {
    await rm(path, { recursive: true });
  }
});

test('a workspace whose only change is a new file is still reviewed', async () => {
  const path = await mkdtemp(join(tmpdir(), 'patrol-claude-review-'));
  let staged = false;
  const run = async (_command, args) => {
    if (args[0] === 'fetch') return { stdout: '' };
    if (args[0] === 'rev-parse') return { stdout: `${BASE}\n` };
    if (args[0] === 'merge-base') return { stdout: `${FORK}\n` };
    if (args[0] === 'ls-files') return { stdout: 'new-file.js\n' };
    if (args[0] === 'add') {
      staged = true;
      return { stdout: '' };
    }
    if (args[0] === 'reset') {
      staged = false;
      return { stdout: '' };
    }
    // Untracked files are invisible to git diff until they are staged, which is
    // what makes the intent-to-add pass load-bearing for the no-changes gate.
    if (args[0] === 'diff') {
      if (!staged) return { stdout: '' };
      return args.includes('--name-status')
        ? { stdout: 'A\tnew-file.js\n' }
        : { stdout: 'diff --git a/new-file.js b/new-file.js\n+added\n' };
    }
    throw new Error(`Unexpected git call: ${args.join(' ')}`);
  };
  const service = createClaudeReviewService({
    capability: { environment: { PATH: '/bin' } },
    run,
    runClaude: async ({ diff }) => ({
      stdout: JSON.stringify({ is_error: false, result: `Reviewed ${diff.length} bytes.` }),
    }),
  });

  try {
    const result = await service.run({
      reviewId: 'review-1',
      workspace: { id: 'workspace-1', path },
      pr: { id: 'acme/app#1', number: 1, org: 'acme', repo: 'app', base_branch: 'main' },
    });
    assert.equal(result.noChanges, false);
    assert.match(result.result, /^Reviewed \d+ bytes\.$/);
  } finally {
    await rm(path, { recursive: true });
  }
});
