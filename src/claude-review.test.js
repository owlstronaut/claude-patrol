import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildClaudeReviewArgs, createClaudeReviewService } from './claude-review.js';

const BASE = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const FORK = '3'.repeat(40);

function fakeJj() {
  return async (_command, args) => {
    if (args.includes('fetch')) return { stdout: '' };
    if (args.includes('exactly(@, 1)')) return { stdout: `${HEAD}\n` };
    if (args.some((arg) => typeof arg === 'string' && arg.includes('remote_bookmarks'))) {
      return { stdout: `${BASE}\n` };
    }
    if (args.some((arg) => typeof arg === 'string' && arg.includes('fork_point'))) {
      return { stdout: `${FORK}\n` };
    }
    if (args.includes('--summary')) return { stdout: 'M src/app.js' };
    if (args[0] === 'diff') return { stdout: 'diff --git a/src/app.js b/src/app.js\n+bug\n' };
    throw new Error(`Unexpected jj call: ${args.join(' ')}`);
  };
}

test('Claude review receives the complete diff over stdin with a read-only CLI contract', async () => {
  const path = await mkdtemp(join(tmpdir(), 'patrol-claude-review-'));
  const calls = [];
  const service = createClaudeReviewService({
    capability: { environment: { PATH: '/bin' } },
    run: fakeJj(),
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
    assert.match(calls[0].prompt, new RegExp(`${FORK}\\.\\.${HEAD}`));
    assert.deepEqual(calls[0].environment, { PATH: '/bin' });

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
