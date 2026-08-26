import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { emitLocalChange } from './app-events.js';
import { getDb } from './db.js';
import { killSessionAndWait } from './pty-manager.js';
import { sanitizePublicText, sanitizeWorkspaceWarnings } from './public-errors.js';
import { runTask } from './tasks.js';
import { archiveTranscript } from './transcripts.js';
import { execFile, expandPath, toClaudeProjectKey } from './utils.js';
import { getPullRequestOwner } from './work-item-prs.js';

/**
 * Ensure a git repo has jj initialized. If .jj/ doesn't exist, runs
 * `jj git init --colocate` to set it up. No-op if already initialized.
 * @param {string} repoPath
 */
async function ensureJjInit(repoPath) {
  if (!existsSync(repoPath)) {
    throw new Error(`Repo directory does not exist: ${repoPath}`);
  }
  const jjDir = resolve(repoPath, '.jj');
  if (!existsSync(jjDir)) {
    console.log(`[workspace] Initializing jj in ${repoPath}`);
    await execFile('jj', ['git', 'init', '--colocate'], { cwd: repoPath });
    return;
  }

  // Update stale working copy - jj refuses operations on stale repos
  try {
    await execFile('jj', ['workspace', 'update-stale', '-R', repoPath]);
  } catch {
    // Non-fatal: update-stale fails if workspace isn't stale (exit code 1)
  }
}

/** @type {Map<string, Promise<unknown>>} */
const workspaceLocks = new Map();

function workspaceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function reserveWorkspaceRow(workspace) {
  const db = getDb();
  inTransaction(db, () => {
    const conflict = db
      .prepare(
        `SELECT id FROM workspaces
         WHERE repo = ? AND bookmark = ? AND status = 'active'
         LIMIT 1`,
      )
      .get(workspace.repo, workspace.bookmark);
    if (conflict) {
      throw workspaceError(
        'workspace_conflict',
        `Active workspace ${conflict.id} already owns ${workspace.repo} bookmark ${workspace.bookmark}`,
      );
    }
    const claim = db
      .prepare('SELECT workspace_id FROM workspace_claims WHERE repo = ? AND bookmark = ?')
      .get(workspace.repo, workspace.bookmark);
    if (claim) {
      throw workspaceError(
        'workspace_busy',
        `Workspace operation ${claim.workspace_id} already owns ${workspace.repo} bookmark ${workspace.bookmark}`,
      );
    }
    db.prepare(
      `INSERT INTO workspaces (
        id, pr_id, work_item_id, name, path, bookmark, repo, status, created_at,
        operation_state, operation_step, operation_updated_at, start_revision, base_commit,
        setup_warnings_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, 'creating', 'create:reserved', ?, ?, ?, ?)`,
    ).run(
      workspace.id,
      workspace.prId ?? null,
      workspace.workItemId ?? null,
      workspace.name,
      workspace.path,
      workspace.bookmark,
      workspace.repo,
      workspace.now,
      workspace.now,
      workspace.startRevision ?? null,
      workspace.baseCommit ?? null,
      JSON.stringify([]),
    );
    db.prepare(
      `INSERT INTO workspace_claims (repo, bookmark, workspace_id, operation, created_at)
       VALUES (?, ?, ?, 'create', ?)`,
    ).run(workspace.repo, workspace.bookmark, workspace.id, workspace.now);
  });
}

function finishWorkspaceOperation(id, state, step, error, extra = {}) {
  const db = getDb();
  inTransaction(db, () => {
    updateWorkspaceOperation(id, state, step, error, extra);
    db.prepare('DELETE FROM workspace_claims WHERE workspace_id = ?').run(id);
  });
}

function claimWorkspaceForDestroy(workspace) {
  const db = getDb();
  inTransaction(db, () => {
    const current = db
      .prepare('SELECT workspace_id FROM workspace_claims WHERE repo = ? AND bookmark = ?')
      .get(workspace.repo, workspace.bookmark);
    if (current && current.workspace_id !== workspace.id) {
      throw workspaceError(
        'workspace_busy',
        `Another workspace operation owns ${workspace.repo} ${workspace.bookmark}`,
      );
    }
    if (!current) {
      db.prepare(
        `INSERT INTO workspace_claims (repo, bookmark, workspace_id, operation, created_at)
         VALUES (?, ?, ?, 'destroy', ?)`,
      ).run(workspace.repo, workspace.bookmark, workspace.id, new Date().toISOString());
    } else {
      db.prepare("UPDATE workspace_claims SET operation = 'destroy' WHERE workspace_id = ?").run(workspace.id);
    }
    updateWorkspaceOperation(workspace.id, 'destroying', 'destroy:reserved');
  });
}

function isAlreadyForgotten(error) {
  if (error?.code === 'ENOENT') return false;
  return /no such workspace|no workspace named|workspace.*(?:not found|does not exist|unknown)/i.test(
    error?.message ?? '',
  );
}

function updateWorkspaceOperation(id, state, step, error = null, extra = {}) {
  const db = getDb();
  const assignments = ['operation_state = ?', 'operation_step = ?', 'operation_error = ?', 'operation_updated_at = ?'];
  const values = [state, step, error, new Date().toISOString()];
  for (const [column, value] of Object.entries(extra)) {
    assignments.push(`${column} = ?`);
    values.push(value);
  }
  values.push(id);
  db.prepare(`UPDATE workspaces SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Report interrupted or inconsistent workspace operations without modifying
 * external state. Startup uses this in report-only mode.
 */
export function inspectWorkspaceState() {
  const rows = getDb().prepare('SELECT * FROM workspaces').all();
  const issues = [];
  for (const workspace of rows) {
    if (!['ready', 'destroyed'].includes(workspace.operation_state)) {
      issues.push({
        workspace_id: workspace.id,
        state: workspace.operation_state,
        step: workspace.operation_step,
        error: workspace.operation_error,
      });
      continue;
    }
    if (workspace.status === 'active' && workspace.operation_state === 'ready' && !existsSync(workspace.path)) {
      issues.push({
        workspace_id: workspace.id,
        state: 'inconsistent',
        step: 'health:missing_path',
        error: `Workspace directory is missing: ${workspace.path}`,
      });
    }
  }
  return issues;
}

/** Convert abandoned process-owned operations into explicit retryable errors. */
export function recoverInterruptedWorkspaceOperations() {
  const db = getDb();
  const interrupted = db
    .prepare(
      "SELECT id, operation_state, operation_step FROM workspaces WHERE operation_state IN ('creating', 'destroying')",
    )
    .all();
  if (interrupted.length === 0) return [];
  inTransaction(db, () => {
    const now = new Date().toISOString();
    const update = db.prepare(
      `UPDATE workspaces
       SET operation_state = 'error', operation_error = ?, operation_updated_at = ?
       WHERE id = ?`,
    );
    const release = db.prepare('DELETE FROM workspace_claims WHERE workspace_id = ?');
    for (const workspace of interrupted) {
      update.run(
        sanitizePublicText(`Interrupted during ${workspace.operation_step ?? workspace.operation_state}`),
        now,
        workspace.id,
      );
      release.run(workspace.id);
    }
  });
  return interrupted;
}

/**
 * Serialize operations on a single workspace id. Without this, a destroy can
 * fire against a create that is still mid-flight: it marks the DB row
 * destroyed and runs `jj workspace forget` before `jj workspace add` has
 * finished, so jj ends up owning an orphan workspace the DB no longer
 * tracks. Subsequent creates then fail with `Workspace named ... already
 * exists`.
 * @template T
 * @param {string} id
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withWorkspaceLock(id, fn) {
  const prev = workspaceLocks.get(id);
  const current = (async () => {
    if (prev) {
      try {
        await prev;
      } catch {
        /* prior holder's failure is its own to report */
      }
    }
    return fn();
  })();
  workspaceLocks.set(id, current);
  try {
    return await current;
  } finally {
    if (workspaceLocks.get(id) === current) {
      workspaceLocks.delete(id);
    }
  }
}

/**
 * Create a jj workspace for a PR.
 * Uses a transaction with unique constraint to prevent concurrent creation.
 * @param {string} prId - e.g. 'org/repo#42'
 * @param {object} config - app config
 * @returns {Promise<object>} workspace record
 */
export async function createWorkspace(prId, config) {
  const db = getDb();
  const owner = getPullRequestOwner(prId);
  if (owner) {
    throw workspaceError(
      'pr_owned_by_work_item',
      `PR ${prId} belongs to work item ${owner.reference}; use its shared workspace and session`,
    );
  }

  // Get PR data for branch name
  const pr = db.prepare('SELECT * FROM prs WHERE id = ?').get(prId);
  if (!pr) {
    throw new Error(`PR not found: ${prId}`);
  }

  const id = randomUUID();
  const name = `${pr.org}-${pr.repo}-${pr.number}`;
  const basePath = expandPath(config.workspace_base_path);
  const workspacePath = resolve(basePath, pr.org, pr.repo, String(pr.number));
  const mainRepoPath = resolve(expandPath(config.work_dir), pr.org, pr.repo);
  const now = new Date().toISOString();

  try {
    reserveWorkspaceRow({
      id,
      prId,
      name,
      path: workspacePath,
      bookmark: pr.branch,
      repo: `${pr.org}/${pr.repo}`,
      now,
      startRevision: pr.branch,
    });
  } catch (error) {
    if (error.message.includes('UNIQUE'))
      throw workspaceError('workspace_conflict', `Active workspace already exists for ${prId}`);
    throw error;
  }

  return withWorkspaceLock(id, async () => {
    try {
      await runTask(
        {
          kind: 'workspace.create',
          label: `Create ${name}`,
          context: { workspaceId: id, prId, repo: `${pr.org}/${pr.repo}` },
        },
        async () => {
          updateWorkspaceOperation(id, 'creating', 'create:initialize_repository');
          await ensureJjInit(mainRepoPath);
          mkdirSync(dirname(workspacePath), { recursive: true });
          updateWorkspaceOperation(id, 'creating', 'create:add_workspace');
          await execFile('jj', [
            'workspace',
            'add',
            workspacePath,
            '--name',
            name,
            '-r',
            pr.branch,
            '-R',
            mainRepoPath,
          ]);
          updateWorkspaceOperation(id, 'creating', 'create:post_setup');
          const warnings = await runPostCreateSetup(workspacePath, mainRepoPath, name, config, `${pr.org}/${pr.repo}`);
          const safeWarnings = sanitizeWorkspaceWarnings(warnings);
          db.prepare('UPDATE workspaces SET setup_warnings_json = ? WHERE id = ?').run(
            JSON.stringify(safeWarnings),
            id,
          );
          return { warnings: safeWarnings };
        },
      );
    } catch (err) {
      await compensateWorkspaceCreation({
        id,
        name,
        workspacePath,
        mainRepoPath,
        repo: `${pr.org}/${pr.repo}`,
        error: err,
        deleteBookmark: false,
      });
      emitLocalChange();
      throw workspaceError('workspace_create_failed', `Workspace creation failed: ${sanitizePublicText(err.message)}`);
    }

    finishWorkspaceOperation(id, 'ready', 'create:complete', null);
    return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
  });
}

/**
 * Create a scratch workspace for starting new work (no PR yet).
 * @param {string} repo - "org/repo" format
 * @param {string} branch - desired branch name
 * @param {object} config - app config
 * @returns {Promise<object>} workspace record
 */
export async function createScratchWorkspace(repo, branch, config, { startRevision = 'main@origin' } = {}) {
  const db = getDb();
  const [org, repoName] = repo.split('/');
  if (!org || !repoName) {
    throw new Error(`Invalid repo format: ${repo} (expected "org/repo")`);
  }

  const id = randomUUID();
  const slug = branch.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const name = `scratch-${slug}`;
  const basePath = expandPath(config.workspace_base_path);
  const workspacePath = resolve(basePath, org, repoName, `scratch-${slug}`);
  const mainRepoPath = resolve(expandPath(config.work_dir), org, repoName);
  const now = new Date().toISOString();

  if (!existsSync(mainRepoPath)) {
    throw new Error(`Main repo does not exist: ${mainRepoPath}`);
  }

  reserveWorkspaceRow({ id, name, path: workspacePath, bookmark: branch, repo, now, startRevision });

  return withWorkspaceLock(id, async () => {
    try {
      await runTask(
        {
          kind: 'workspace.create',
          label: `Create ${name}`,
          context: { workspaceId: id, repo, branch },
        },
        async () => {
          updateWorkspaceOperation(id, 'creating', 'create:initialize_repository');
          await ensureJjInit(mainRepoPath);
          mkdirSync(dirname(workspacePath), { recursive: true });
          updateWorkspaceOperation(id, 'creating', 'create:add_workspace');
          await execFile('jj', [
            'workspace',
            'add',
            workspacePath,
            '--name',
            name,
            '-r',
            startRevision,
            '-R',
            mainRepoPath,
          ]);

          // Create bookmark for the branch (non-fatal - may already exist)
          const warnings = [];
          try {
            await execFile('jj', ['bookmark', 'create', branch, '-R', workspacePath]);
          } catch (err) {
            warnings.push(`Bookmark create failed: ${err.message}`);
          }

          updateWorkspaceOperation(id, 'creating', 'create:post_setup');
          warnings.push(...(await runPostCreateSetup(workspacePath, mainRepoPath, name, config, repo)));
          const safeWarnings = sanitizeWorkspaceWarnings(warnings);
          db.prepare('UPDATE workspaces SET setup_warnings_json = ? WHERE id = ?').run(
            JSON.stringify(safeWarnings),
            id,
          );
          return { warnings: safeWarnings };
        },
      );
    } catch (err) {
      await compensateWorkspaceCreation({
        id,
        name,
        workspacePath,
        mainRepoPath,
        repo,
        error: err,
        deleteBookmark: false,
      });
      emitLocalChange();
      throw workspaceError('workspace_create_failed', `Workspace creation failed: ${sanitizePublicText(err.message)}`);
    }

    finishWorkspaceOperation(id, 'ready', 'create:complete', null);
    return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
  });
}

export function sourceRepositoryPath(repo, config) {
  const [owner, name, extra] = String(repo).split('/');
  if (!owner || !name || extra) throw workspaceError('invalid_repository', `Invalid repository identifier: ${repo}`);
  let workDir;
  let source;
  try {
    workDir = realpathSync(expandPath(config.work_dir));
    source = realpathSync(resolve(workDir, owner, name));
  } catch {
    throw workspaceError('repository_unavailable', `Configured source repository is unavailable: ${repo}`);
  }
  const relation = relative(workDir, source);
  if (
    relation === '..' ||
    relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(relation)
  ) {
    throw workspaceError('unsafe_repository_path', `Configured source repository escapes work_dir: ${repo}`);
  }
  if (!existsSync(resolve(source, '.jj'))) {
    throw workspaceError('jj_required', `Configured source repository is not a jj repository: ${repo}`);
  }
  return source;
}

export async function resolveWorkspaceRevision(repo, revision, config) {
  const sourcePath = sourceRepositoryPath(repo, config);
  let stdout;
  try {
    ({ stdout } = await execFile(
      'jj',
      ['log', '--no-graph', '-r', revision, '-T', 'commit_id ++ "\\n"', '-R', sourcePath],
      {
        encoding: 'utf8',
      },
    ));
  } catch (error) {
    throw workspaceError(
      'revision_unresolved',
      sanitizePublicText(`Could not resolve configured revision for ${repo}: ${error.message}`),
    );
  }
  const commits = String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (commits.length !== 1 || !/^[0-9a-f]{40,64}$/i.test(commits[0])) {
    throw workspaceError('revision_ambiguous', `Configured revision for ${repo} did not resolve to exactly one commit`);
  }
  return { sourcePath, commitId: commits[0] };
}

export async function createWorkItemChild({
  id,
  workItemId,
  repo,
  name,
  workspacePath,
  bookmark,
  config,
  startRevision = config.repos[repo].defaultRevision,
}) {
  const { sourcePath, commitId } = await resolveWorkspaceRevision(repo, startRevision, config);
  const now = new Date().toISOString();
  reserveWorkspaceRow({
    id,
    workItemId,
    name,
    path: workspacePath,
    bookmark,
    repo,
    now,
    startRevision,
    baseCommit: commitId,
  });

  return withWorkspaceLock(id, async () => {
    let bookmarkCreated = false;
    try {
      updateWorkspaceOperation(id, 'creating', 'create:check_bookmark');
      const { stdout } = await execFile('jj', ['bookmark', 'list', bookmark, '-T', 'name ++ "\\n"', '-R', sourcePath], {
        encoding: 'utf8',
      });
      if (String(stdout).trim()) {
        throw workspaceError('bookmark_exists', `Bookmark already exists in ${repo}: ${bookmark}`);
      }

      mkdirSync(dirname(workspacePath), { recursive: true });
      updateWorkspaceOperation(id, 'creating', 'create:add_workspace');
      await execFile('jj', ['workspace', 'add', workspacePath, '--name', name, '-r', commitId, '-R', sourcePath]);
      updateWorkspaceOperation(id, 'creating', 'create:bookmark');
      await execFile('jj', ['bookmark', 'create', bookmark, '-r', '@', '-R', workspacePath]);
      bookmarkCreated = true;
      updateWorkspaceOperation(id, 'creating', 'create:post_setup');
      const warnings = sanitizeWorkspaceWarnings(
        await runPostCreateSetup(workspacePath, sourcePath, name, config, repo),
      );
      getDb().prepare('UPDATE workspaces SET setup_warnings_json = ? WHERE id = ?').run(JSON.stringify(warnings), id);
      finishWorkspaceOperation(id, 'ready', 'create:complete', null);
      return getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    } catch (error) {
      await compensateWorkspaceCreation({
        id,
        name,
        workspacePath,
        mainRepoPath: sourcePath,
        repo,
        error,
        deleteBookmark: bookmarkCreated ? bookmark : false,
      });
      throw workspaceError(error.code ?? 'setup_failed', sanitizePublicText(error.message));
    }
  });
}

const COMPOSE_FILENAMES = new Set(['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']);
const COMPOSE_SKIP_DIRS = new Set(['node_modules', '.git', '.jj', '.next', 'dist', 'build']);

/**
 * Recursively find docker compose files under a workspace, skipping heavy or
 * irrelevant directories. Returns absolute paths.
 * @param {string} root
 * @returns {string[]}
 */
function findComposeFiles(root) {
  const found = [];
  /** @param {string} dir */
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!COMPOSE_SKIP_DIRS.has(entry.name)) {
          walk(resolve(dir, entry.name));
        }
      } else if (entry.isFile() && COMPOSE_FILENAMES.has(entry.name)) {
        found.push(resolve(dir, entry.name));
      }
    }
  }
  walk(root);
  return found;
}

/**
 * Tear down docker compose stacks associated with a workspace. Walks the
 * workspace tree so it catches stacks nested under e.g. `infra/local/` and
 * with either `.yml` or `.yaml`. Stacks whose compose file is already gone
 * are handled by pruneStaleComposeStacks at server startup, so we don't
 * fall back to guessing project names from path components.
 * @param {string} workspacePath
 * @returns {Promise<string|null>} warning message if cleanup failed, null if ok or no stack found
 */
async function dockerComposeDown(workspacePath) {
  const composeFiles = findComposeFiles(workspacePath);
  if (composeFiles.length === 0) return null;
  const warnings = [];
  for (const composeFile of composeFiles) {
    try {
      await execFile('docker', ['compose', 'down', '-v', '--remove-orphans'], {
        cwd: dirname(composeFile),
        timeout: 60_000,
      });
    } catch (err) {
      warnings.push(`${composeFile}: ${err.message}`);
    }
  }
  return warnings.length > 0 ? `Docker compose down failed for: ${warnings.join('; ')}` : null;
}

/**
 * Find docker compose stacks whose config file lives under the patrol workspace
 * base path but no longer exists on disk. These are orphans left behind when a
 * workspace was destroyed before its compose stack was torn down.
 * @param {string} workspaceBasePath
 * @returns {Promise<Array<{name: string, configFile: string}>>}
 */
export async function detectStaleComposeStacks(workspaceBasePath) {
  let stdout;
  try {
    ({ stdout } = await execFile('docker', ['compose', 'ls', '-a', '--format', 'json']));
  } catch {
    return [];
  }
  let stacks;
  try {
    stacks = JSON.parse(stdout);
  } catch {
    return [];
  }
  const base = resolve(expandPath(workspaceBasePath));
  const prefix = base.endsWith('/') ? base : `${base}/`;
  const stale = [];
  for (const stack of stacks) {
    const configFiles = String(stack.ConfigFiles || '')
      .split(',')
      .filter(Boolean);
    if (configFiles.length === 0) continue;
    const first = configFiles[0];
    if (!first.startsWith(prefix)) continue;
    if (existsSync(first)) continue;
    stale.push({ name: stack.Name, configFile: first });
  }
  return stale;
}

/**
 * Tear down stale compose stacks identified by detectStaleComposeStacks.
 * Uses `docker compose -p <name> down -v --remove-orphans` which finds
 * containers, networks, and volumes via compose project labels, so it works
 * even when the original compose file is gone.
 * @param {string} workspaceBasePath
 * @returns {Promise<{torn: string[], warnings: string[]}>}
 */
export async function pruneStaleComposeStacks(workspaceBasePath) {
  const stale = await detectStaleComposeStacks(workspaceBasePath);
  const torn = [];
  const warnings = [];
  for (const { name } of stale) {
    try {
      await execFile('docker', ['compose', '-p', name, 'down', '-v', '--remove-orphans'], {
        timeout: 60_000,
      });
      torn.push(name);
    } catch (err) {
      warnings.push(`Stale compose tear-down failed for ${name}: ${err.message}`);
    }
  }
  return { torn, warnings };
}

/**
 * Clean up all artifacts from a failed workspace creation.
 * Best-effort: logs warnings but does not throw.
 * @param {object} opts
 * @param {string} opts.id - workspace DB id
 * @param {string} opts.name - jj workspace name
 * @param {string} opts.workspacePath
 * @param {string} opts.mainRepoPath
 * @param {string} opts.repo
 */
async function compensateWorkspaceCreation({ id, name, workspacePath, mainRepoPath, repo, error, deleteBookmark }) {
  const originalError = sanitizePublicText(error?.message ?? String(error));
  updateWorkspaceOperation(id, 'creating', 'create:compensation_docker', originalError);

  try {
    const dockerWarning = await dockerComposeDown(workspacePath);
    if (dockerWarning) throw new Error(dockerWarning);
  } catch (caught) {
    finishWorkspaceOperation(
      id,
      'error',
      'create:compensation_docker',
      sanitizePublicText(`${originalError}; ${caught.message}`),
    );
    return false;
  }

  updateWorkspaceOperation(id, 'creating', 'create:compensation_forget');
  try {
    await execFile('jj', ['workspace', 'forget', name, '-R', mainRepoPath]);
  } catch (caught) {
    if (!isAlreadyForgotten(caught)) {
      finishWorkspaceOperation(
        id,
        'error',
        'create:compensation_forget',
        sanitizePublicText(`${originalError}; ${caught.message}`),
      );
      return false;
    }
  }

  updateWorkspaceOperation(id, 'creating', 'create:compensation_directory');
  try {
    await rm(workspacePath, { recursive: true, force: true });
  } catch (caught) {
    finishWorkspaceOperation(
      id,
      'error',
      'create:compensation_directory',
      sanitizePublicText(`${originalError}; ${caught.message}`),
    );
    return false;
  }

  updateWorkspaceOperation(id, 'creating', 'create:compensation_claude_project');
  try {
    const claudeProjects = expandPath('~/.claude/projects');
    const workspaceKey = toClaudeProjectKey(workspacePath);
    await rm(resolve(claudeProjects, workspaceKey), { recursive: true, force: true });
  } catch (caught) {
    finishWorkspaceOperation(
      id,
      'error',
      'create:compensation_claude_project',
      sanitizePublicText(`${originalError}; ${caught.message}`),
    );
    return false;
  }

  if (deleteBookmark) {
    updateWorkspaceOperation(id, 'creating', 'create:compensation_bookmark');
    try {
      await execFile('jj', ['bookmark', 'delete', deleteBookmark, '-R', mainRepoPath]);
    } catch (caught) {
      finishWorkspaceOperation(
        id,
        'error',
        'create:compensation_bookmark',
        sanitizePublicText(`${originalError}; ${caught.message}`),
      );
      return false;
    }
  }

  finishWorkspaceOperation(id, 'destroyed', 'create:compensated', originalError, {
    status: 'destroyed',
    destroyed_at: new Date().toISOString(),
    pr_id: null,
    repo,
  });
  return true;
}

/**
 * Run post-create setup: symlinks, memory linking, and init commands.
 * On failure, caller is responsible for rollback.
 * @param {string} workspacePath
 * @param {string} mainRepoPath
 * @param {string} name - jj workspace name (for log messages)
 * @param {object} config
 * @param {string} repoKey - "org/repo" for config lookup
 */
async function runPostCreateSetup(workspacePath, mainRepoPath, name, config, repoKey) {
  const repoConfig = config.repos?.[repoKey] || {};
  const warnings = [];

  if (config.symlink_memory) {
    symlinkMemory(workspacePath, mainRepoPath);
  }
  if (repoConfig.symlinks) {
    setupRepoSymlinks(workspacePath, mainRepoPath, repoConfig.symlinks);
  }

  // Init commands are non-fatal - workspace is usable even if these fail
  if (repoConfig.initCommands) {
    for (const cmd of repoConfig.initCommands) {
      try {
        await execFile('/bin/sh', ['-c', cmd], { cwd: workspacePath, timeout: 120_000 });
      } catch (err) {
        warnings.push(`Init command failed in ${name}: ${err.message}`);
      }
    }
  }
  return warnings;
}

/**
 * Symlink files from the primary repo into the workspace.
 * Each entry is a relative path (e.g. "./dev/cvg/skill/scripts/.jsgr_signing_token").
 * The same relative path in the workspace points to the file in the main repo.
 * @param {string} workspacePath
 * @param {string} mainRepoPath
 * @param {string[]} symlinks - relative paths to symlink
 */
function setupRepoSymlinks(workspacePath, mainRepoPath, symlinks) {
  for (const relPath of symlinks) {
    const source = resolve(mainRepoPath, relPath);
    if (!existsSync(source)) {
      throw new Error(`Symlink source does not exist: ${source}`);
    }
    const target = resolve(workspacePath, relPath);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target);
  }
}

/**
 * Symlink Claude project memory so the workspace shares memory with the main repo.
 * Source: ~/.claude/projects/<main-repo-key>/memory/
 * Target: ~/.claude/projects/<workspace-key>/memory/ (symlink)
 * @param {string} workspacePath - absolute path to the new workspace
 * @param {string} mainRepoPath - absolute path to the main repo
 */
function symlinkMemory(workspacePath, mainRepoPath) {
  const claudeProjects = expandPath('~/.claude/projects');
  const sourceKey = toClaudeProjectKey(mainRepoPath);
  const source = resolve(claudeProjects, sourceKey, 'memory');

  if (!existsSync(source)) {
    // Create the source memory dir if it doesn't exist yet
    mkdirSync(source, { recursive: true });
  }

  const targetKey = toClaudeProjectKey(workspacePath);
  const targetProjectDir = resolve(claudeProjects, targetKey);
  const target = resolve(targetProjectDir, 'memory');

  mkdirSync(targetProjectDir, { recursive: true });

  // Remove existing memory dir/symlink if present
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }

  symlinkSync(source, target);
}

/**
 * Destroy a workspace - kill sessions, docker down, jj forget, rm.
 * @param {string} workspaceId
 * @param {object} config
 * @returns {Promise<{ok: boolean, warnings: string[]}>}
 */
export async function destroyWorkspace(workspaceId, config) {
  const workspace = getDb().prepare('SELECT work_item_id FROM workspaces WHERE id = ?').get(workspaceId);
  if (workspace?.work_item_id) {
    throw workspaceError(
      'work_item_child_managed',
      'Work-item child workspaces can only be removed through their work item',
    );
  }
  return destroyWorkspaceInternal(workspaceId, config, { deleteBookmark: false });
}

export async function destroyWorkItemChild(workspaceId, config, { deleteBookmark = false, runExec = execFile } = {}) {
  return destroyWorkspaceInternal(workspaceId, config, { deleteBookmark, runExec });
}

async function destroyWorkspaceInternal(workspaceId, config, { deleteBookmark, runExec = execFile }) {
  return withWorkspaceLock(workspaceId, () => destroyWorkspaceLocked(workspaceId, config, { deleteBookmark, runExec }));
}

async function destroyWorkspaceLocked(workspaceId, config, { deleteBookmark, runExec }) {
  const db = getDb();
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  if (workspace.status === 'destroyed' && workspace.operation_state === 'destroyed') {
    const pr = workspace.pr_id ? db.prepare('SELECT org, repo FROM prs WHERE id = ?').get(workspace.pr_id) : null;
    const repo = workspace.repo ?? (pr ? `${pr.org}/${pr.repo}` : null);
    db.prepare('UPDATE workspaces SET pr_id = NULL, repo = ? WHERE id = ?').run(repo, workspaceId);
    return { ok: true, warnings: [] };
  }

  let mainRepoPath;
  let workspaceRepo = workspace.repo;
  if (workspace.pr_id) {
    const pr = db.prepare('SELECT org, repo FROM prs WHERE id = ?').get(workspace.pr_id);
    if (pr) workspaceRepo = `${pr.org}/${pr.repo}`;
    mainRepoPath = pr ? resolve(expandPath(config.work_dir), pr.org, pr.repo) : expandPath(config.work_dir);
  } else if (workspace.repo) {
    mainRepoPath = sourceRepositoryPath(workspace.repo, config);
  } else {
    throw workspaceError('workspace_repository_missing', `Workspace ${workspaceId} has no repository identifier`);
  }
  workspace.repo = workspaceRepo;
  db.prepare('UPDATE workspaces SET repo = ? WHERE id = ?').run(workspaceRepo, workspaceId);

  claimWorkspaceForDestroy(workspace);

  // Notify clients now so the UI removes the workspace from active lists
  // immediately, instead of waiting for filesystem cleanup (which can take
  // seconds for workspaces with node_modules / build artifacts).
  emitLocalChange();

  // Track the rest as an observable task so the UI can show progress.
  try {
    return await runTask(
      {
        kind: 'workspace.destroy',
        label: `Destroy ${workspace.name}`,
        context: { workspaceId, prId: workspace.pr_id, repo: workspaceRepo },
      },
      async () => {
        // Step 1: Kill active sessions for this workspace
        updateWorkspaceOperation(workspaceId, 'destroying', 'destroy:sessions');
        const sessions = db
          .prepare("SELECT * FROM sessions WHERE workspace_id = ? AND status IN ('active', 'detached')")
          .all(workspaceId);
        for (const session of sessions) {
          await killSessionAndWait(session.id);
        }

        // Step 2: Docker compose down if applicable
        updateWorkspaceOperation(workspaceId, 'destroying', 'destroy:docker');
        const dockerWarning = await dockerComposeDown(workspace.path);
        if (dockerWarning) throw workspaceError('docker_cleanup_failed', dockerWarning);

        // Step 3: jj workspace forget
        updateWorkspaceOperation(workspaceId, 'destroying', 'destroy:forget_workspace');
        try {
          await runExec('jj', ['workspace', 'forget', workspace.name, '-R', mainRepoPath]);
        } catch (err) {
          if (!isAlreadyForgotten(err)) {
            throw workspaceError('workspace_forget_failed', `jj workspace forget failed: ${err.message}`);
          }
        }

        // Step 4: Archive session transcripts before removing provider state.
        updateWorkspaceOperation(workspaceId, 'destroying', 'destroy:transcripts');
        const allSessions = db.prepare('SELECT * FROM sessions WHERE workspace_id = ?').all(workspaceId);
        for (const sess of allSessions) {
          if (sess.claude_project_dir && !sess.transcript_path) {
            try {
              archiveTranscript(sess.id, sess.claude_project_dir, sess.started_at, sess.ended_at);
            } catch (err) {
              throw workspaceError(
                'transcript_archive_failed',
                `Transcript archive failed for ${sess.id}: ${err.message}`,
              );
            }
          }
        }

        // Step 5: Remove the directory only after jj forget succeeded.
        updateWorkspaceOperation(workspaceId, 'destroying', 'destroy:directory');
        try {
          await rm(workspace.path, { recursive: true, force: true });
        } catch (err) {
          throw workspaceError('directory_cleanup_failed', `Directory cleanup failed: ${err.message}`);
        }

        // Step 6: Clean up Claude project memory symlink.
        updateWorkspaceOperation(workspaceId, 'destroying', 'destroy:claude_project');
        try {
          const claudeProjects = expandPath('~/.claude/projects');
          const wsKey = toClaudeProjectKey(workspace.path);
          const wsProjectDir = resolve(claudeProjects, wsKey);
          await rm(wsProjectDir, { recursive: true, force: true });
        } catch (err) {
          throw workspaceError('provider_state_cleanup_failed', `Claude memory cleanup failed: ${err.message}`);
        }

        if (deleteBookmark) {
          updateWorkspaceOperation(workspaceId, 'destroying', 'destroy:bookmark');
          try {
            const { stdout } = await runExec(
              'jj',
              ['bookmark', 'list', workspace.bookmark, '-T', 'name ++ "\\n"', '-R', mainRepoPath],
              { encoding: 'utf8' },
            );
            if (String(stdout).trim()) {
              await runExec('jj', ['bookmark', 'delete', workspace.bookmark, '-R', mainRepoPath]);
            }
          } catch (error) {
            throw workspaceError('bookmark_cleanup_failed', `Bookmark cleanup failed: ${error.message}`);
          }
        }

        finishWorkspaceOperation(workspaceId, 'destroyed', 'destroy:complete', null, {
          status: 'destroyed',
          destroyed_at: new Date().toISOString(),
          pr_id: null,
          repo: workspaceRepo,
        });
        emitLocalChange();
        return { ok: true, warnings: [] };
      },
    );
  } catch (error) {
    const current = db.prepare('SELECT operation_step FROM workspaces WHERE id = ?').get(workspaceId);
    finishWorkspaceOperation(
      workspaceId,
      'error',
      current?.operation_step ?? 'destroy:failed',
      sanitizePublicText(error.message),
    );
    emitLocalChange();
    throw workspaceError(error.code ?? 'workspace_cleanup_failed', sanitizePublicText(error.message));
  }
}
