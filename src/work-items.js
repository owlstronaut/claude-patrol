import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, unlink } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { emitLocalChange } from './app-events.js';
import { getDb } from './db.js';
import { providerSetup } from './provider-setup.js';
import { createSession, isSessionAlive, killSessionAndWait } from './pty-manager.js';
import { sanitizePublicText } from './public-errors.js';
import { runTask, updateTaskProgress } from './tasks.js';
import { archiveTranscript } from './transcripts.js';
import { execFile, expandPath, toClaudeProjectKey } from './utils.js';
import { generatedRootFileNames, publishRootFiles, writeTemporaryRootFiles } from './work-item-files.js';
import { listWorkItemPullRequests } from './work-item-prs.js';
import { createWorkItemResolver } from './work-item-resolver.js';
import { createWorkItemChild, destroyWorkItemChild } from './workspace.js';

const workItemLocks = new Map();
const WORK_ITEM_STATES = new Set(['resolving', 'preparing', 'ready', 'error', 'destroying', 'destroyed']);
const WORK_ITEM_STAGES = new Set([
  'provider_check',
  'reference_resolution',
  'root_generation',
  'child_creation',
  'child_compensation',
  'session_launch',
  'session_stop',
  'transcript_archive',
  'child_destruction',
  'root_destruction',
  'complete',
]);

function workItemError(code, message, failedProvider = null) {
  const error = new Error(sanitizePublicText(message));
  error.code = code;
  error.failedProvider = failedProvider;
  return error;
}

function transaction(db, fn) {
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

function mutateWorkItem(id, patch, expectedStates = null) {
  const db = getDb();
  const allowed = new Set([
    'title',
    'summary',
    'resolved_repositories_json',
    'state',
    'stage',
    'progress_current',
    'progress_total',
    'error_code',
    'error_detail',
    'error_provider',
    'destroyed_at',
  ]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new TypeError(`Unsupported work-item mutation: ${key}`);
  }
  if (patch.state && !WORK_ITEM_STATES.has(patch.state)) throw new TypeError(`Invalid work-item state: ${patch.state}`);
  if (patch.stage && !WORK_ITEM_STAGES.has(patch.stage)) throw new TypeError(`Invalid work-item stage: ${patch.stage}`);
  const now = new Date().toISOString();
  const assignments = [...Object.keys(patch).map((key) => `${key} = ?`), 'updated_at = ?'];
  const values = [...Object.values(patch), now, id];
  let stateClause = '';
  if (expectedStates?.length) {
    stateClause = ` AND state IN (${expectedStates.map(() => '?').join(', ')})`;
    values.push(...expectedStates);
  }
  const result = transaction(db, () =>
    db.prepare(`UPDATE work_items SET ${assignments.join(', ')} WHERE id = ?${stateClause}`).run(...values),
  );
  if (expectedStates?.length && result.changes !== 1) {
    throw workItemError('invalid_state', 'Work item state changed before this operation could start');
  }
  emitLocalChange();
  return db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
}

function clearErrorPatch() {
  return { error_code: null, error_detail: null, error_provider: null };
}

function retryAction(row) {
  if (!row || row.state !== 'error') return null;
  if (['child_creation', 'child_compensation'].includes(row.stage) && pendingRepositoryAddition(row)) {
    return 'repository_addition';
  }
  if (['provider_check', 'reference_resolution'].includes(row.stage)) return 'resolution';
  if (['root_generation', 'child_creation'].includes(row.stage)) return 'preparation';
  if (row.stage === 'child_compensation') return 'cleanup';
  if (row.stage === 'session_launch') return 'terminal';
  if (['session_stop', 'transcript_archive', 'child_destruction', 'root_destruction'].includes(row.stage)) {
    return 'cleanup';
  }
  return null;
}

function pendingRepositoryAddition(row) {
  return getDb()
    .prepare(
      `SELECT a.repository AS repo, a.workspace_id AS id,
              a.start_revision,
              w.id AS persisted_workspace_id, w.status, w.operation_state,
              w.operation_step, w.operation_error
       FROM work_item_repository_additions a
       LEFT JOIN workspaces w ON w.id = a.workspace_id
       WHERE a.work_item_id = ?`,
    )
    .get(row.id);
}

function repositoriesFor(row) {
  if (!row?.resolved_repositories_json) return [];
  try {
    const parsed = JSON.parse(row.resolved_repositories_json);
    return Array.isArray(parsed) ? parsed.filter((repo) => typeof repo === 'string').slice(0, 32) : [];
  } catch {
    return [];
  }
}

function validateRepository(value, config) {
  if (typeof value !== 'string') throw workItemError('invalid_repository', 'Repository must be a string');
  const repository = value.trim();
  if (!/^[^\s/\\\u0000-\u001f\u007f-\u009f]+\/[^\s/\\\u0000-\u001f\u007f-\u009f]+$/u.test(repository)) {
    throw workItemError('invalid_repository', 'Repository must use owner/repo format');
  }
  if (!config.repos?.[repository]) {
    throw workItemError('repository_not_configured', `Repository is not configured in repos: ${repository}`);
  }
  return repository;
}

function validateRevision(value, repository, config) {
  const rawRevision = value ?? config.repos?.[repository]?.defaultRevision;
  if (rawRevision === undefined) {
    throw workItemError('revision_required', `revision is required for ${repository}`);
  }
  if (typeof rawRevision !== 'string') throw workItemError('invalid_revision', 'Revision must be a string');
  const revision = rawRevision.trim();
  const bytes = Buffer.byteLength(revision, 'utf8');
  if (bytes < 1 || bytes > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(revision)) {
    throw workItemError('invalid_revision', 'Revision must contain 1 to 512 UTF-8 bytes and no control characters');
  }
  return revision;
}

export async function removeWorkItemRoot(rootPath, { runExec = execFile } = {}) {
  const warnings = [];
  const reposPath = resolve(rootPath, 'repos');
  let entries = [];
  try {
    entries = await readdir(reposPath, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childPath = resolve(reposPath, entry.name);
    let gitFile;
    try {
      gitFile = await readFile(resolve(childPath, '.git'), 'utf8');
    } catch {
      continue;
    }
    if (!/^gitdir:\s*\S+/mu.test(gitFile)) continue;
    try {
      await runExec('git', ['-C', childPath, 'worktree', 'remove', '--force', childPath]);
    } catch (error) {
      warnings.push(
        sanitizePublicText(`Git worktree deregistration failed for ${entry.name}: ${error.message}`, {
          maxBytes: 4096,
        }),
      );
    }
  }
  await rm(rootPath, { recursive: true, force: true });
  return warnings;
}

function latestSession(db, workItemId) {
  return db
    .prepare(
      `SELECT * FROM sessions
       WHERE work_item_id = ? AND status IN ('active', 'detached')
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(workItemId);
}

function hasSessionHistory(db, workItemId) {
  return Boolean(db.prepare('SELECT 1 FROM sessions WHERE work_item_id = ? LIMIT 1').get(workItemId));
}

function activityMap(getSessionStates) {
  return new Map(getSessionStates().map((entry) => [entry.sessionId, entry.state]));
}

export function workItemListItem(row, { getSessionStates = () => [] } = {}) {
  const db = getDb();
  const session = latestSession(db, row.id);
  const activities = activityMap(getSessionStates);
  const pullRequests = listWorkItemPullRequests(row.id);
  return {
    id: row.id,
    reference: row.reference,
    title: row.title,
    work_provider: row.work_provider,
    resolver_provider: row.resolver_provider,
    state: row.state,
    stage: row.stage,
    progress: { current: row.progress_current, total: row.progress_total },
    repositories: repositoriesFor(row),
    pull_request_count: pullRequests.length,
    pull_requests: pullRequests,
    updated_at: row.updated_at,
    has_session_history: hasSessionHistory(db, row.id),
    session: session
      ? { id: session.id, status: session.status, activity_state: activities.get(session.id) ?? null }
      : null,
    error: row.error_code
      ? {
          code: row.error_code,
          failed_provider: row.error_provider,
          retry_action: retryAction(row),
        }
      : null,
  };
}

function recoveryActions(row, config) {
  if (!row.error_code) return [];
  const actions = [];
  if (row.error_provider && ['provider_unavailable', 'authentication_required'].includes(row.error_code)) {
    const setup = providerSetup(config)[row.error_provider];
    actions.push({ kind: 'command', label: `Authenticate ${row.error_provider}`, command: setup.model_login_command });
    if (row.error_code === 'authentication_required') {
      for (const command of setup.resolver_mcp_commands) {
        actions.push({ kind: 'command', label: 'Configure reference resolver', command });
      }
    }
  }
  if (row.error_provider) {
    actions.push({ kind: 'settings', label: 'Open Work Items settings', href: '#/setup?section=work-items' });
  }
  return actions;
}

function repositoryState(workspace) {
  if (!workspace) return 'pending';
  if (workspace.status === 'destroyed' || workspace.operation_state === 'destroyed') return 'removed';
  if (workspace.operation_state === 'destroying') return 'removing';
  if (workspace.operation_state === 'error') return 'error';
  if (workspace.operation_state === 'ready') return 'ready';
  return 'pending';
}

function parseWarnings(value) {
  try {
    const warnings = JSON.parse(value ?? '[]');
    return Array.isArray(warnings)
      ? warnings
          .filter((item) => typeof item === 'string')
          .slice(0, 32)
          .map((warning) => sanitizePublicText(warning, { maxBytes: 4096 }))
      : [];
  } catch {
    return [];
  }
}

export function workItemDetail(row, { config, getSessionStates = () => [] }) {
  const list = workItemListItem(row, { getSessionStates });
  const children = getDb()
    .prepare('SELECT rowid, * FROM workspaces WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(row.id);
  const byRepo = new Map();
  for (const child of children) {
    if (!byRepo.has(child.repo)) byRepo.set(child.repo, child);
  }
  const bookmark = deterministicBookmark(row.id);
  return {
    ...list,
    summary: row.summary,
    root_path: row.path,
    created_at: row.created_at,
    destroyed_at: row.destroyed_at,
    error: row.error_code
      ? {
          code: row.error_code,
          detail: row.error_detail ? sanitizePublicText(row.error_detail, { maxBytes: 16 * 1024 }) : null,
          failed_provider: row.error_provider,
          retry_action: retryAction(row),
          recovery_actions: recoveryActions(row, config),
        }
      : null,
    repository_workspaces: repositoriesFor(row).map((identifier) => {
      const child = byRepo.get(identifier) ?? null;
      return {
        identifier,
        workspace_id: child?.id ?? null,
        state: repositoryState(child),
        path: child?.path ?? null,
        checkout_available: Boolean(
          child && child.status === 'active' && child.operation_state !== 'destroyed' && existsSync(child.path),
        ),
        bookmark: child?.bookmark ?? bookmark,
        start_revision: child?.start_revision ?? config.repos?.[identifier]?.defaultRevision ?? '',
        base_commit: child?.base_commit ?? null,
        warnings: parseWarnings(child?.setup_warnings_json),
      };
    }),
  };
}

export function deterministicBookmark(id) {
  return `patrol/work-item-${id.replaceAll('-', '').slice(0, 12)}`;
}

function childDescriptor(workItem, repo) {
  const id = randomUUID();
  const [owner, name] = repo.split('/');
  const short = id.replaceAll('-', '').slice(0, 8);
  const stable = createHash('sha256').update(`${workItem.id}\0${repo}`).digest('hex').slice(0, 8);
  return {
    id,
    repo,
    directory: `${owner}--${name}--${short}`,
    name: `work-item-${workItem.id.replaceAll('-', '').slice(0, 12)}-${stable}`,
  };
}

function mapLifecycleError(error) {
  const code = error?.code;
  const mappings = {
    resolver_call_limit: 'resolver_limit',
    resolver_output_limit: 'resolver_limit',
    resolver_tool_violation: 'resolver_limit',
    invalid_provider_output: 'resolver_output_invalid',
    resolution_failed: 'resolver_output_invalid',
    provider_unsupported: 'provider_unavailable',
    repository_unavailable: 'repo_not_local',
    unsafe_repository_path: 'repo_not_local',
    jj_required: 'repo_not_local',
    revision_unresolved: 'revision_not_found',
    bookmark_exists: 'bookmark_conflict',
    workspace_conflict: 'bookmark_conflict',
  };
  const stable = mappings[code] ?? code;
  const allowed = new Set([
    'provider_unavailable',
    'authentication_required',
    'resolver_timeout',
    'resolver_limit',
    'resolver_output_invalid',
    'repo_not_local',
    'revision_not_found',
    'revision_ambiguous',
    'bookmark_conflict',
    'setup_failed',
    'compensation_failed',
    'session_launch_failed',
    'interrupted',
    'cleanup_failed',
    'root_not_empty',
  ]);
  return allowed.has(stable) ? stable : 'setup_failed';
}

function recordFailure(id, error, { code = null, provider = null, stage = null } = {}) {
  return mutateWorkItem(id, {
    state: 'error',
    ...(stage ? { stage } : {}),
    error_code: code ?? mapLifecycleError(error),
    error_detail: sanitizePublicText(error?.message ?? String(error)),
    error_provider: provider ?? error?.failedProvider ?? null,
  });
}

async function withWorkItemLock(id, fn) {
  const previous = workItemLocks.get(id);
  const current = (async () => {
    if (previous) await previous.catch(() => {});
    return fn();
  })();
  workItemLocks.set(id, current);
  try {
    return await current;
  } finally {
    if (workItemLocks.get(id) === current) workItemLocks.delete(id);
  }
}

function validateReference(value) {
  if (typeof value !== 'string') throw workItemError('invalid_reference', 'Reference must be a string');
  const reference = value.trim();
  const bytes = Buffer.byteLength(reference, 'utf8');
  if (bytes < 1 || bytes > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(reference)) {
    throw workItemError('invalid_reference', 'Reference must contain 1 to 512 UTF-8 bytes and no control characters');
  }
  return reference;
}

function workItemLogId(id) {
  return id.replaceAll('-', '').slice(0, 8);
}

function workspaceCount(count) {
  return `${count} workspace${count === 1 ? '' : 's'}`;
}

function sanitizeLogText(value) {
  return sanitizePublicText(value, { maxBytes: 512 })
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

async function checkProvider(provider, capabilities) {
  const capability = await capabilities[provider].refresh();
  if (capability.available) return;
  const authentication = /auth|log\s*in/i.test(capability.reason ?? '');
  throw workItemError(
    authentication ? 'authentication_required' : 'provider_unavailable',
    capability.reason ?? `${provider} is unavailable`,
    provider,
  );
}

export function createWorkItemService({
  getConfig,
  providerCapabilities,
  getSessionStates,
  resolver = createWorkItemResolver(),
  schedule = (fn) => setImmediate(fn),
  createChild = createWorkItemChild,
  destroyChild = destroyWorkItemChild,
  launchSession = createSession,
  sessionAlive = isSessionAlive,
  stopSession = killSessionAndWait,
  startupDelay = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  logger = console,
} = {}) {
  const pending = new Map();

  const logStage = (id, stage, message) => {
    logger.log(`[work-items] ${workItemLogId(id)} ${stage}: ${sanitizeLogText(message)}`);
  };

  const warnStage = (id, stage, error) => {
    const message = sanitizeLogText(error?.message ?? String(error));
    logger.warn(`[work-items] ${workItemLogId(id)} ${stage} failed: ${message}`);
  };

  const rootFileChildren = (item, repositories = repositoriesFor(item)) => {
    const rows = getDb()
      .prepare(
        `SELECT rowid, * FROM workspaces
         WHERE work_item_id = ? AND status = 'active'
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(item.id);
    const byRepository = new Map();
    for (const row of rows) {
      if (!byRepository.has(row.repo)) byRepository.set(row.repo, row);
    }
    return repositories.map((repository) => {
      const row = byRepository.get(repository);
      if (!row) throw workItemError('setup_failed', `Repository workspace is missing: ${repository}`);
      return { repo: repository, directory: basename(row.path) };
    });
  };

  const publishCurrentRootFiles = (item, repositories) => {
    writeTemporaryRootFiles(item.path, rootFileChildren(item, repositories), {
      reference: item.reference,
      title: item.title,
      summary: item.summary,
    });
    publishRootFiles(item.path);
  };

  const clearTemporaryRootFiles = async (rootPath) => {
    for (const name of generatedRootFileNames().filter((fileName) => fileName.startsWith('.'))) {
      await unlink(resolve(rootPath, name)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  };

  const beginRepositoryAddition = (item, child, startRevision) => {
    const db = getDb();
    const now = new Date().toISOString();
    transaction(db, () => {
      db.prepare(
        `INSERT INTO work_item_repository_additions (
           work_item_id, repository, start_revision, workspace_id, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      ).run(item.id, child.repo, startRevision, child.id, now);
      const result = db
        .prepare(
          `UPDATE work_items
           SET state = 'preparing', stage = 'child_creation', progress_current = 0, progress_total = 1,
               error_code = NULL, error_detail = NULL, error_provider = NULL, updated_at = ?
           WHERE id = ? AND state = 'ready'`,
        )
        .run(now, item.id);
      if (result.changes !== 1) {
        throw workItemError('invalid_state', 'Work item state changed before repository creation could start');
      }
    });
    emitLocalChange();
  };

  const finishRepositoryAddition = (id, repositories = null) => {
    const db = getDb();
    const now = new Date().toISOString();
    transaction(db, () => {
      if (repositories) {
        db.prepare(
          `UPDATE work_items
           SET resolved_repositories_json = ?, state = 'ready', stage = 'complete',
               progress_current = 0, progress_total = 0,
               error_code = NULL, error_detail = NULL, error_provider = NULL, updated_at = ?
           WHERE id = ?`,
        ).run(JSON.stringify(repositories), now, id);
      } else {
        db.prepare(
          `UPDATE work_items
           SET state = 'ready', stage = 'complete', progress_current = 0, progress_total = 0,
               error_code = NULL, error_detail = NULL, error_provider = NULL, updated_at = ?
           WHERE id = ?`,
        ).run(now, id);
      }
      db.prepare('DELETE FROM work_item_repository_additions WHERE work_item_id = ?').run(id);
    });
    emitLocalChange();
  };

  const queue = (id, kind, operation) => {
    schedule(() => {
      const promise = withWorkItemLock(id, () =>
        runTask(
          {
            kind,
            label: kind === 'work-item.destroy' ? 'Destroy work item' : 'Prepare work item',
            context: { workItemId: id },
          },
          operation,
        ),
      )
        .catch((error) => {
          const row = getDb().prepare('SELECT stage FROM work_items WHERE id = ?').get(id);
          warnStage(id, row?.stage ?? kind, error);
        })
        .finally(() => pending.delete(id));
      pending.set(id, promise);
    });
  };

  const launchTerminal = async (id, { replaceExisting = false } = {}) => {
    let session = null;
    try {
      const item = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
      await checkProvider(item.work_provider, providerCapabilities);
      mutateWorkItem(id, {
        state: 'preparing',
        stage: 'session_launch',
        progress_current: 0,
        progress_total: 0,
        ...clearErrorPatch(),
      });
      const existing = latestSession(getDb(), id);
      if (existing) {
        if (!replaceExisting) throw workItemError('session_exists', 'A session is already running for this work item');
        await stopSession(existing.id);
      }
      session = launchSession({ type: 'work_item', id }, item.path, item.work_provider, {
        enablePatrolMcp: true,
      });
      await startupDelay(1000);
      if (!sessionAlive(session.id))
        throw workItemError('session_launch_failed', 'Work-item session exited during startup');
      mutateWorkItem(id, {
        state: 'ready',
        stage: 'complete',
        progress_current: 0,
        progress_total: 0,
        ...clearErrorPatch(),
      });
    } catch (error) {
      const live = getDb()
        .prepare("SELECT id FROM sessions WHERE work_item_id = ? AND status IN ('active', 'detached')")
        .all(id);
      let cleanupError = null;
      for (const row of live) {
        try {
          await stopSession(row.id);
        } catch (caught) {
          cleanupError = caught;
          break;
        }
      }
      const remaining = getDb()
        .prepare("SELECT COUNT(*) AS count FROM sessions WHERE work_item_id = ? AND status IN ('active', 'detached')")
        .get(id).count;
      const failure =
        cleanupError || remaining > 0
          ? workItemError('cleanup_failed', 'Failed to clean up the work-item session after startup failed')
          : error;
      recordFailure(id, failure, {
        code: ['authentication_required', 'provider_unavailable'].includes(failure.code)
          ? failure.code
          : failure.code === 'cleanup_failed'
            ? 'cleanup_failed'
            : 'session_launch_failed',
        provider: error.failedProvider ?? null,
        stage: 'session_launch',
      });
      throw failure;
    }
  };

  const compensateChildren = async (id, originalError, task) => {
    const rows = getDb()
      .prepare(
        "SELECT * FROM workspaces WHERE work_item_id = ? AND status != 'destroyed' ORDER BY created_at DESC, rowid DESC",
      )
      .all(id);
    mutateWorkItem(id, {
      state: 'preparing',
      stage: 'child_compensation',
      progress_current: 0,
      progress_total: rows.length,
      error_code: null,
      error_detail: null,
      error_provider: null,
    });
    logStage(id, 'child_compensation', `removing ${workspaceCount(rows.length)}`);
    updateTaskProgress(task.id, { current: 0, total: rows.length });
    let current = 0;
    try {
      for (const child of rows) {
        logStage(id, 'child_compensation', `removing ${current + 1}/${rows.length} ${child.repo}`);
        await destroyChild(child.id, getConfig(), { deleteBookmark: true });
        current += 1;
        mutateWorkItem(id, { progress_current: current, progress_total: rows.length });
        updateTaskProgress(task.id, { current, total: rows.length });
      }
    } catch (error) {
      recordFailure(id, error, { code: 'compensation_failed', stage: 'child_compensation' });
      throw error;
    }
    const repositories = repositoriesFor(getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id));
    recordFailure(id, originalError, { stage: 'child_creation' });
    mutateWorkItem(id, { progress_current: 0, progress_total: repositories.length });
  };

  const prepare = async (id, task) => {
    const item = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
    const repositories = repositoriesFor(item);
    const children = repositories.map((repo) => childDescriptor(item, repo));
    const rootPath = item.path;
    let childCreationStarted = false;
    try {
      mutateWorkItem(id, {
        state: 'preparing',
        stage: 'root_generation',
        progress_current: 0,
        progress_total: 0,
        ...clearErrorPatch(),
      });
      logStage(id, 'root_generation', `generating files for ${repositories.length} repos`);
      await mkdir(resolve(rootPath, 'repos'), { recursive: true });
      writeTemporaryRootFiles(rootPath, children, {
        reference: item.reference,
        title: item.title,
        summary: item.summary,
      });
      mutateWorkItem(id, {
        state: 'preparing',
        stage: 'child_creation',
        progress_current: 0,
        progress_total: repositories.length,
      });
      logStage(id, 'child_creation', `creating ${workspaceCount(repositories.length)}`);
      childCreationStarted = true;
      updateTaskProgress(task.id, { current: 0, total: repositories.length });
      let current = 0;
      for (const child of children) {
        logStage(id, 'child_creation', `creating ${current + 1}/${repositories.length} ${child.repo}`);
        await createChild({
          id: child.id,
          workItemId: id,
          repo: child.repo,
          name: child.name,
          workspacePath: resolve(rootPath, 'repos', child.directory),
          bookmark: deterministicBookmark(id),
          config: getConfig(),
        });
        current += 1;
        mutateWorkItem(id, { progress_current: current, progress_total: repositories.length });
        updateTaskProgress(task.id, { current, total: repositories.length });
      }
      publishRootFiles(rootPath);
      mutateWorkItem(id, {
        state: 'ready',
        stage: 'complete',
        progress_current: 0,
        progress_total: 0,
        ...clearErrorPatch(),
      });
      logStage(id, 'complete', `ready with ${workspaceCount(repositories.length)}`);
    } catch (error) {
      if (childCreationStarted) await compensateChildren(id, error, task);
      else recordFailure(id, error, { stage: 'root_generation' });
      throw error;
    }
  };

  const addRepositoryLifecycle = async (id, repository, startRevision, task) => {
    const item = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
    const repositories = repositoriesFor(item);
    const child = childDescriptor(item, repository);
    beginRepositoryAddition(item, child, startRevision);
    logStage(id, 'child_creation', `adding ${repository}`);
    updateTaskProgress(task.id, { current: 0, total: 1 });

    try {
      await createChild({
        id: child.id,
        workItemId: id,
        repo: repository,
        name: child.name,
        workspacePath: resolve(item.path, 'repos', child.directory),
        bookmark: deterministicBookmark(id),
        config: getConfig(),
        startRevision,
      });
      const updatedRepositories = [...repositories, repository];
      publishCurrentRootFiles(item, updatedRepositories);
      finishRepositoryAddition(id, updatedRepositories);
      updateTaskProgress(task.id, { current: 1, total: 1 });
      logStage(id, 'complete', `ready with ${workspaceCount(updatedRepositories.length)}`);
      const workItem = workItemDetail(getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id), {
        config: getConfig(),
        getSessionStates,
      });
      return {
        added: true,
        work_item: workItem,
        repository_workspace: workItem.repository_workspaces.find((workspace) => workspace.identifier === repository),
      };
    } catch (error) {
      let cleanupError = null;
      try {
        await clearTemporaryRootFiles(item.path);
        const workspace = getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(child.id);
        if (workspace && (workspace.status !== 'destroyed' || workspace.operation_state !== 'destroyed')) {
          await destroyChild(child.id, getConfig(), { deleteBookmark: true });
        }
        publishCurrentRootFiles(item, repositories);
      } catch (caught) {
        cleanupError = caught;
      }
      if (cleanupError) {
        const failure = workItemError(
          'compensation_failed',
          `Failed to clean up repository workspace ${repository}: ${cleanupError.message}`,
        );
        recordFailure(id, failure, { code: 'compensation_failed', stage: 'child_compensation' });
        throw failure;
      }
      finishRepositoryAddition(id);
      throw error;
    }
  };

  const recoverRepositoryAddition = async (id, repository, startRevision, task) => {
    const item = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
    const pendingWorkspace = pendingRepositoryAddition(item);
    try {
      if (pendingWorkspace?.persisted_workspace_id) {
        await destroyChild(pendingWorkspace.id, getConfig(), { deleteBookmark: true });
      }
      publishCurrentRootFiles(item, repositoriesFor(item));
      finishRepositoryAddition(id);
    } catch (error) {
      recordFailure(id, error, { code: 'compensation_failed', stage: 'child_compensation' });
      throw error;
    }
    return addRepositoryLifecycle(id, repository, startRevision, task);
  };

  const resolveAndPrepare = async (id, task) => {
    try {
      let item = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
      mutateWorkItem(id, {
        state: 'resolving',
        stage: 'provider_check',
        progress_current: 0,
        progress_total: 0,
        ...clearErrorPatch(),
      });
      logStage(id, 'provider_check', `${item.resolver_provider} availability`);
      await checkProvider(item.resolver_provider, providerCapabilities);
      mutateWorkItem(id, { state: 'resolving', stage: 'reference_resolution' });
      logStage(id, 'reference_resolution', `${item.reference} via ${item.resolver_provider}`);
      const result = await resolver.resolve({
        reference: item.reference,
        provider: item.resolver_provider,
        workProvider: item.work_provider,
        config: getConfig().work_items,
      });
      item = mutateWorkItem(id, {
        title: result.title,
        summary: result.summary,
        resolved_repositories_json: JSON.stringify(result.repositories),
        state: 'preparing',
        stage: 'root_generation',
        progress_current: 0,
        progress_total: 0,
        ...clearErrorPatch(),
      });
      await prepare(item.id, task);
    } catch (error) {
      const current = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
      if (current?.state !== 'error') {
        recordFailure(id, error, {
          provider:
            error.failedProvider ?? (current?.stage === 'reference_resolution' ? current.resolver_provider : null),
        });
      }
      throw error;
    }
  };

  const finishCompensation = async (id, task) => {
    const item = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
    const rows = getDb()
      .prepare(
        "SELECT * FROM workspaces WHERE work_item_id = ? AND status != 'destroyed' ORDER BY created_at DESC, rowid DESC",
      )
      .all(id);
    const total = item.progress_total || rows.length;
    let current = item.progress_current;
    logStage(id, 'child_compensation', `resuming ${workspaceCount(rows.length)}`);
    try {
      for (const child of rows) {
        logStage(id, 'child_compensation', `removing ${current + 1}/${total} ${child.repo}`);
        await destroyChild(child.id, getConfig(), { deleteBookmark: true });
        current += 1;
        mutateWorkItem(id, { progress_current: current, progress_total: total });
        updateTaskProgress(task.id, { current, total });
      }
      mutateWorkItem(id, {
        state: 'error',
        stage: 'child_creation',
        progress_current: 0,
        progress_total: repositoriesFor(item).length,
        error_code: 'setup_failed',
        error_detail: 'Failed preparation cleanup completed. Retry preparation.',
        error_provider: null,
      });
    } catch (error) {
      recordFailure(id, error, { code: 'compensation_failed', stage: 'child_compensation' });
      throw error;
    }
  };

  const archiveRootSessions = async (item) => {
    const sessions = getDb().prepare('SELECT * FROM sessions WHERE work_item_id = ? ORDER BY started_at').all(item.id);
    for (const session of sessions) {
      if (session.provider === 'claude' && session.claude_project_dir && !session.transcript_path) {
        archiveTranscript(session.id, session.claude_project_dir, session.started_at, session.ended_at);
      }
    }
    const claudeProject = resolve(expandPath('~/.claude/projects'), toClaudeProjectKey(item.path));
    if (existsSync(claudeProject)) {
      await rm(claudeProject, { recursive: true, force: true });
    }
  };

  const destroyLifecycle = async (id, task) => {
    try {
      let item = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
      const resumedStage = item.stage;
      const resumedCurrent = item.progress_current;
      const resumedTotal = item.progress_total;
      mutateWorkItem(id, { state: 'destroying', stage: 'session_stop', ...clearErrorPatch() });
      const sessions = getDb()
        .prepare("SELECT id FROM sessions WHERE work_item_id = ? AND status IN ('active', 'detached')")
        .all(id);
      for (const session of sessions) await stopSession(session.id);

      mutateWorkItem(id, { state: 'destroying', stage: 'transcript_archive' });
      await archiveRootSessions(item);

      item = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
      const children = getDb()
        .prepare(
          "SELECT * FROM workspaces WHERE work_item_id = ? AND status != 'destroyed' ORDER BY created_at DESC, rowid DESC",
        )
        .all(id);
      const resumingChildren = resumedStage === 'child_destruction';
      const total = resumingChildren ? resumedTotal : children.length;
      let current = resumingChildren ? resumedCurrent : 0;
      mutateWorkItem(id, {
        state: 'destroying',
        stage: 'child_destruction',
        progress_current: current,
        progress_total: total,
      });
      updateTaskProgress(task.id, { current, total });
      for (const child of children) {
        await destroyChild(child.id, getConfig(), { deleteBookmark: false });
        current += 1;
        mutateWorkItem(id, { progress_current: current, progress_total: total });
        updateTaskProgress(task.id, { current, total });
      }

      mutateWorkItem(id, {
        state: 'destroying',
        stage: 'root_destruction',
        progress_current: 0,
        progress_total: 0,
      });
      const warnings = await removeWorkItemRoot(item.path);
      mutateWorkItem(id, {
        state: 'destroyed',
        stage: 'complete',
        progress_current: 0,
        progress_total: 0,
        destroyed_at: new Date().toISOString(),
        ...clearErrorPatch(),
      });
      getDb().prepare('DELETE FROM work_item_repository_additions WHERE work_item_id = ?').run(id);
      return { warnings };
    } catch (error) {
      const row = getDb().prepare('SELECT stage FROM work_items WHERE id = ?').get(id);
      recordFailure(id, error, {
        code: 'cleanup_failed',
        stage: row?.stage,
      });
      throw error;
    }
  };

  return {
    create({ reference: rawReference, workProvider }) {
      const config = getConfig();
      if (!config.work_items) throw workItemError('work_items_not_configured', 'Work items are not configured');
      const reference = validateReference(rawReference);
      if (!['claude', 'codex'].includes(workProvider)) {
        throw workItemError('invalid_provider', 'work_provider must be claude or codex');
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      const path = resolve(expandPath(config.workspace_base_path), 'work-items', id);
      const resolverProvider = config.work_items.resolver.provider ?? workProvider;
      getDb()
        .prepare(
          `INSERT INTO work_items (
            id, reference, path, work_provider, resolver_provider, state, stage,
            progress_current, progress_total, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'resolving', 'provider_check', 0, 0, ?, ?)`,
        )
        .run(id, reference, path, workProvider, resolverProvider, now, now);
      emitLocalChange();
      queue(id, 'work-item.create', (task) => resolveAndPrepare(id, task));
      return workItemListItem(getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id), {
        getSessionStates,
      });
    },

    retry(id) {
      const row = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
      if (!row) throw workItemError('work_item_not_found', 'Work item not found');
      const action = retryAction(row);
      if (!action) throw workItemError('invalid_state', 'Work item has no retryable operation');
      if (action === 'resolution') {
        mutateWorkItem(id, { state: 'resolving', stage: 'provider_check', ...clearErrorPatch() }, ['error']);
        queue(id, 'work-item.create', (task) => resolveAndPrepare(id, task));
      } else if (action === 'preparation') {
        mutateWorkItem(id, { state: 'preparing', stage: 'root_generation', ...clearErrorPatch() }, ['error']);
        queue(id, 'work-item.create', (task) => prepare(id, task));
      } else if (action === 'terminal') {
        mutateWorkItem(id, { state: 'preparing', stage: 'session_launch', ...clearErrorPatch() }, ['error']);
        queue(id, 'work-item.create', () => launchTerminal(id, { replaceExisting: true }));
      } else if (action === 'repository_addition') {
        const pendingWorkspace = pendingRepositoryAddition(row);
        mutateWorkItem(id, { state: 'preparing', stage: 'child_compensation', ...clearErrorPatch() }, ['error']);
        queue(id, 'work-item.create', (task) =>
          recoverRepositoryAddition(id, pendingWorkspace.repo, pendingWorkspace.start_revision, task),
        );
      } else if (row.stage === 'child_compensation') {
        mutateWorkItem(id, { state: 'preparing', ...clearErrorPatch() }, ['error']);
        queue(id, 'work-item.create', (task) => finishCompensation(id, task));
      } else {
        mutateWorkItem(id, { state: 'destroying', ...clearErrorPatch() }, ['error']);
        queue(id, 'work-item.destroy', (task) => destroyLifecycle(id, task));
      }
      return workItemListItem(getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id), {
        getSessionStates,
      });
    },

    async addRepository(id, rawRepository, rawRevision) {
      const config = getConfig();
      const repository = validateRepository(rawRepository, config);
      return withWorkItemLock(id, async () => {
        const row = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
        if (!row) throw workItemError('work_item_not_found', 'Work item not found');
        const existingRepositories = repositoriesFor(row);
        if (existingRepositories.includes(repository)) {
          const workItem = workItemDetail(row, { config: getConfig(), getSessionStates });
          const repositoryWorkspace = workItem.repository_workspaces.find(
            (workspace) => workspace.identifier === repository,
          );
          if (repositoryWorkspace?.state !== 'ready') {
            throw workItemError('invalid_state', `Repository workspace is not ready: ${repository}`);
          }
          return {
            added: false,
            work_item: workItem,
            repository_workspace: repositoryWorkspace,
          };
        }
        const pendingWorkspace = pendingRepositoryAddition(row);
        if (row.state === 'error' && pendingWorkspace?.repo === repository) {
          return runTask(
            {
              kind: 'work-item.add-repository',
              label: `Add ${repository}`,
              context: { workItemId: id, repo: repository },
            },
            (task) => recoverRepositoryAddition(id, repository, pendingWorkspace.start_revision, task),
          );
        }
        if (row.state !== 'ready') throw workItemError('work_item_busy', 'Work item is not ready');
        const startRevision = validateRevision(rawRevision, repository, config);
        return runTask(
          {
            kind: 'work-item.add-repository',
            label: `Add ${repository}`,
            context: { workItemId: id, repo: repository },
          },
          (task) => addRepositoryLifecycle(id, repository, startRevision, task),
        );
      });
    },

    destroy(id) {
      const row = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
      if (!row) throw workItemError('work_item_not_found', 'Work item not found');
      if (row.state === 'destroyed') return { accepted: false, row };
      if (['resolving', 'preparing', 'destroying'].includes(row.state)) {
        throw workItemError('work_item_busy', 'Work item is busy');
      }
      const resumingCleanup = retryAction(row) === 'cleanup';
      mutateWorkItem(
        id,
        {
          state: 'destroying',
          ...(resumingCleanup ? {} : { stage: 'session_stop', progress_current: 0, progress_total: 0 }),
          ...clearErrorPatch(),
        },
        ['ready', 'error'],
      );
      queue(id, 'work-item.destroy', (task) => destroyLifecycle(id, task));
      return { accepted: true, row: getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id) };
    },

    list() {
      return getDb()
        .prepare("SELECT * FROM work_items WHERE state != 'destroyed' ORDER BY updated_at DESC")
        .all()
        .map((row) => workItemListItem(row, { getSessionStates }));
    },

    detail(id) {
      const row = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
      return row ? workItemDetail(row, { config: getConfig(), getSessionStates }) : null;
    },

    async waitForIdle(id) {
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      await pending.get(id);
    },
  };
}

export function recoverInterruptedWorkItems() {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, state, stage, progress_current, progress_total FROM work_items WHERE state IN ('resolving', 'preparing', 'destroying')",
    )
    .all();
  if (rows.length === 0) return [];
  transaction(db, () => {
    const now = new Date().toISOString();
    const fail = db.prepare(
      `UPDATE work_items
       SET state = 'error', stage = ?, progress_current = ?, progress_total = ?,
           error_code = 'interrupted', error_detail = ?, error_provider = NULL, updated_at = ?
       WHERE id = ?`,
    );
    const completeTerminalLaunch = db.prepare(
      `UPDATE work_items
       SET state = 'ready', stage = 'complete', progress_current = 0, progress_total = 0,
           error_code = NULL, error_detail = NULL, error_provider = NULL, updated_at = ?
       WHERE id = ?`,
    );
    const liveSession = db.prepare(
      "SELECT id FROM sessions WHERE work_item_id = ? AND status IN ('active', 'detached') LIMIT 1",
    );
    const activeChildren = db.prepare(
      "SELECT COUNT(*) AS count FROM workspaces WHERE work_item_id = ? AND status != 'destroyed'",
    );
    for (const row of rows) {
      if (row.state === 'preparing' && row.stage === 'session_launch' && liveSession.get(row.id)) {
        completeTerminalLaunch.run(now, row.id);
        continue;
      }

      const childCount = activeChildren.get(row.id).count;
      const needsChildCompensation = row.state === 'preparing' && row.stage === 'child_creation' && childCount > 0;
      const stage = needsChildCompensation ? 'child_compensation' : row.stage;
      const current = needsChildCompensation ? 0 : row.progress_current;
      const total = needsChildCompensation ? childCount : row.progress_total;
      fail.run(stage, current, total, `Interrupted during ${row.stage}`, now, row.id);
    }
    db.exec(
      `DELETE FROM workspace_claims
       WHERE workspace_id IN (SELECT id FROM workspaces WHERE work_item_id IS NOT NULL)`,
    );
  });
  emitLocalChange();
  return rows.map(({ id, stage }) => ({ id, stage }));
}
