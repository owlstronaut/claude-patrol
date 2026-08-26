import { realpath } from 'node:fs/promises';
import { execFile } from './utils.js';

function taggedError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function parseCommitId(stdout, label) {
  const value = String(stdout || '').trim();
  if (!/^[0-9a-f]{40,64}$/.test(value)) {
    throw taggedError('diff_resolution_failed', `Could not resolve exactly one ${label} commit`);
  }
  return value;
}

async function runGit(run, cwd, args, options = {}) {
  try {
    return await run('git', args, {
      cwd,
      timeout: options.timeout ?? 30_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
    });
  } catch (error) {
    throw taggedError('diff_resolution_failed', 'Could not prepare the full workspace diff for review', error);
  }
}

/**
 * Run `fn` with untracked-but-not-ignored files staged intent-to-add, then
 * restore the index. `git diff` omits untracked files entirely, so without this
 * a workspace whose only change is new files looks empty to both the
 * change-detection gate and the diff read.
 * @template T
 * @param {typeof execFile} run
 * @param {string} cwd
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withUntrackedIntentToAdd(run, cwd, fn) {
  let untracked = [];
  try {
    const { stdout } = await run('git', ['ls-files', '--others', '--exclude-standard'], { cwd });
    untracked = String(stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (untracked.length > 0) await run('git', ['add', '-N', '--', ...untracked], { cwd });
  } catch (error) {
    throw taggedError('diff_resolution_failed', 'Could not stage untracked workspace files for review', error);
  }
  try {
    return await fn();
  } finally {
    if (untracked.length > 0) {
      await run('git', ['reset', '--quiet', '--', ...untracked], { cwd }).catch(() => {});
    }
  }
}

/** Resolve an immutable fork-point-to-working-copy range after refreshing the PR base branch. */
export async function resolveReviewRange({ workspacePath, baseBranch, run = execFile }) {
  const resolvedPath = await realpath(workspacePath).catch((error) => {
    throw taggedError('workspace_unavailable', 'The workspace path is not available', error);
  });

  await runGit(run, resolvedPath, ['fetch', 'origin', baseBranch], { timeout: 2 * 60 * 1000 });

  const baseResult = await runGit(run, resolvedPath, ['rev-parse', '--verify', `refs/remotes/origin/${baseBranch}`]);
  const base = parseCommitId(baseResult.stdout, 'base branch');

  const forkResult = await runGit(run, resolvedPath, ['merge-base', base, 'HEAD']);
  const fork = parseCommitId(forkResult.stdout, 'fork point');

  // A single ref diffs against the live working tree (staged + unstaged).
  const summary = await runGit(run, resolvedPath, ['diff', '--name-status', fork]);

  return { workspacePath: resolvedPath, base, fork, summary: String(summary.stdout || '').trim() };
}
