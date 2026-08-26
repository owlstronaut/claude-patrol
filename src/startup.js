import { isPollConfigured } from './config.js';
import { execFile } from './utils.js';

/**
 * Check that a command is available and runs successfully.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function checkCommand(cmd, args) {
  try {
    await execFile(cmd, args, { timeout: 10_000 });
  } catch (err) {
    throw new Error(`Required command "${cmd} ${args.join(' ')}" failed: ${err.message}`);
  }
}

/**
 * Validate that all required tools are available before starting.
 * Throws with a clear message if anything is missing.
 */
export async function validateStartup(config = {}) {
  const checks = [
    { cmd: 'jj', args: ['--version'], label: 'Jujutsu (jj)' },
    { cmd: 'tmux', args: ['-V'], label: 'tmux' },
  ];
  if (isPollConfigured(config)) checks.unshift({ cmd: 'gh', args: ['--version'], label: 'GitHub CLI (gh)' });

  const errors = [];
  for (const { cmd, args, label } of checks) {
    try {
      await checkCommand(cmd, args);
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
