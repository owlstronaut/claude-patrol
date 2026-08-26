import { isPollConfigured } from './config.js';
import { execFile } from './utils.js';

/**
 * Check that a command is available and runs successfully.
 * @param {string} cmd
 * @param {string[]} args
 * @param {(stdout: string) => boolean} [validate] optionally require the output to satisfy a predicate
 * @returns {Promise<void>}
 */
async function checkCommand(cmd, args, validate) {
  let stdout;
  try {
    ({ stdout } = await execFile(cmd, args, { timeout: 10_000 }));
  } catch (err) {
    throw new Error(`Required command "${cmd} ${args.join(' ')}" failed: ${err.message}`);
  }
  if (validate && !validate(stdout)) {
    throw new Error(`Command "${cmd} ${args.join(' ')}" did not report the expected result`);
  }
}

/** @returns {Promise<boolean>} whether `cmd --version` succeeds */
async function commandExists(cmd) {
  try {
    await execFile(cmd, ['--version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate that all required tools are available before starting.
 * Throws with a clear message if anything is missing.
 */
export async function validateStartup(config = {}) {
  const checks = [{ cmd: 'tmux', args: ['-V'], label: 'tmux' }];
  const ghConfigured = isPollConfigured(config);
  if (ghConfigured) checks.unshift({ cmd: 'gh', args: ['--version'], label: 'GitHub CLI (gh)' });

  // gh-stack backs the rebase/stacking workflow for any repo workspace, not just
  // polling, so check it whenever gh is present (or already being checked here).
  if (ghConfigured || (await commandExists('gh'))) {
    checks.push({
      cmd: 'gh',
      args: ['extension', 'list'],
      label: 'gh-stack extension',
      validate: (stdout) => stdout.includes('github/gh-stack'),
    });
  }

  const errors = [];
  for (const { cmd, args, label, validate } of checks) {
    try {
      await checkCommand(cmd, args, validate);
    } catch {
      errors.push(`  - ${label}: "${cmd}" not found or not working`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Startup validation failed. Missing required tools:\n${errors.join('\n')}`);
  }

  if (isPollConfigured(config)) {
    try {
      await checkCommand('gh', ['auth', 'status']);
    } catch {
      throw new Error('GitHub CLI is not authenticated. Run "gh auth login" first.');
    }
  }
}
