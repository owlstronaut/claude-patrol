import { realpath } from 'node:fs/promises';
import { execFile } from './utils.js';

function taggedError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function exactPattern(value) {
  return `exact:${JSON.stringify(value)}`;
}

function commitRevset(commitId) {
  return `commit_id(${JSON.stringify(commitId)})`;
}

function parseCommitId(stdout, label) {
  const value = String(stdout || '').trim();
  if (!/^[0-9a-f]{40,64}$/.test(value)) {
    throw taggedError('diff_resolution_failed', `Could not resolve exactly one ${label} commit`);
  }
  return value;
}

async function runJj(run, workspacePath, args, options = {}) {
  try {
    return await run('jj', [...args, '-R', workspacePath], {
      timeout: options.timeout ?? 30_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
    });
  } catch (error) {
    throw taggedError('diff_resolution_failed', 'Could not prepare the full workspace diff for review', error);
  }
}

/** Resolve an immutable fork-point-to-working-copy range after refreshing the PR base branch. */
export async function resolveReviewRange({ workspacePath, baseBranch, run = execFile }) {
  const resolvedPath = await realpath(workspacePath).catch((error) => {
    throw taggedError('workspace_unavailable', 'The workspace path is not available', error);
  });

  await runJj(
    run,
    resolvedPath,
    ['git', 'fetch', '--remote', exactPattern('origin'), '--branch', exactPattern(baseBranch)],
    { timeout: 2 * 60 * 1000 },
  );

  const baseResult = await runJj(run, resolvedPath, [
    'log',
    '--ignore-working-copy',
    '-r',
    `exactly(remote_bookmarks(${exactPattern(baseBranch)}, ${exactPattern('origin')}), 1)`,
    '--no-graph',
    '-T',
    'commit_id ++ "\\n"',
  ]);
  const headResult = await runJj(run, resolvedPath, [
    'log',
    '-r',
    'exactly(@, 1)',
    '--no-graph',
    '-T',
    'commit_id ++ "\\n"',
  ]);
  const base = parseCommitId(baseResult.stdout, 'base branch');
  const head = parseCommitId(headResult.stdout, 'workspace');
  const forkResult = await runJj(run, resolvedPath, [
    'log',
    '--ignore-working-copy',
    '-r',
    `exactly(fork_point(${commitRevset(base)} | ${commitRevset(head)}), 1)`,
    '--no-graph',
    '-T',
    'commit_id ++ "\\n"',
  ]);
  const fork = parseCommitId(forkResult.stdout, 'fork point');
  const summary = await runJj(run, resolvedPath, [
    'diff',
    '--ignore-working-copy',
    '--from',
    fork,
    '--to',
    head,
    '--summary',
  ]);

  return { workspacePath: resolvedPath, base, head, fork, summary: String(summary.stdout || '').trim() };
}
