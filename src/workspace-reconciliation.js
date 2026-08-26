import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { getDb } from './db.js';
import { sanitizePublicText } from './public-errors.js';
import { execFile, expandPath, toClaudeProjectKey } from './utils.js';
import { destroyWorkspaceWithGuards, dockerComposeDown, sourceRepositoryPath } from './workspace.js';
import {
  PATROL_WORKSPACE_MARKER,
  readPatrolWorkspaceMarker,
  writePatrolWorkspaceMarker,
} from './workspace-ownership.js';

function cleanupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function relationInside(root, candidate) {
  const relation = relative(root, candidate);
  if (relation === '' || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return null;
  return relation;
}

function canonicalDirectory(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return realpathSync(path);
  } catch {
    return null;
  }
}

function workspaceCoordinates(path, config, { allowMissing = false } = {}) {
  const base = realpathSync(expandPath(config.workspace_base_path));
  let canonical = canonicalDirectory(path);
  if (!canonical && allowMissing && !existsSync(path)) {
    try {
      canonical = resolve(realpathSync(dirname(resolve(path))), basename(path));
    } catch {
      throw cleanupError('unsafe_workspace_path', `Workspace parent cannot be verified: ${path}`);
    }
  }
  if (!canonical) throw cleanupError('unsafe_workspace_path', `Workspace path is not a real directory: ${path}`);
  const relation = relationInside(base, canonical);
  const parts = relation?.split(sep) ?? [];
  if (parts.length !== 3 || parts.some((part) => !part || part === '.' || part === '..')) {
    throw cleanupError('unsafe_workspace_path', `Workspace path is outside Patrol's exact workspace depth: ${path}`);
  }
  const [owner, repoName, leaf] = parts;
  if (owner === 'work-items') {
    throw cleanupError('work_item_child_managed', `Work-item paths are not owned by workspace reconciliation: ${path}`);
  }
  return { base, canonical, owner, repoName, leaf, repo: `${owner}/${repoName}` };
}

async function listJjWorkspaces(sourcePath, runExec) {
  const { stdout } = await runExec(
    'jj',
    ['workspace', 'list', '--ignore-working-copy', '-T', 'name ++ "\\t" ++ root ++ "\\n"', '-R', sourcePath],
    { encoding: 'utf8', timeout: 30_000 },
  );
  const workspaces = new Map();
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const name = line.slice(0, tab);
    const root = line.slice(tab + 1);
    const canonical = canonicalDirectory(root);
    if (name && canonical) workspaces.set(canonical, name);
  }
  return workspaces;
}

function directoryChildren(path) {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  } catch {
    return [];
  }
}

/**
 * Find only directories Patrol can prove it created. A directory depth alone
 * is not ownership because work_dir and workspace_base_path may be identical.
 */
export async function discoverPatrolWorkspaceDirectories(config, { runExec = execFile } = {}) {
  const base = canonicalDirectory(expandPath(config.workspace_base_path));
  if (!base) return { candidates: [], warnings: [] };

  const candidates = [];
  const warnings = [];
  for (const ownerEntry of directoryChildren(base)) {
    if (ownerEntry.name === 'work-items') continue;
    const ownerPath = resolve(base, ownerEntry.name);
    for (const repoEntry of directoryChildren(ownerPath)) {
      const repoPath = resolve(ownerPath, repoEntry.name);
      const repo = `${ownerEntry.name}/${repoEntry.name}`;
      const possible = directoryChildren(repoPath)
        .map((entry) => ({ entry, path: resolve(repoPath, entry.name) }))
        .filter(({ path }) => existsSync(resolve(path, '.jj')));
      if (possible.length === 0) continue;

      let sourcePath = null;
      let jjWorkspaces = new Map();
      try {
        sourcePath = sourceRepositoryPath(repo, config);
        jjWorkspaces = await listJjWorkspaces(sourcePath, runExec);
      } catch (error) {
        warnings.push(`${repo}: ${sanitizePublicText(error.message)}`);
      }

      for (const { path } of possible) {
        const canonical = canonicalDirectory(path);
        if (!canonical) continue;
        const marker = readPatrolWorkspaceMarker(canonical);
        const listedName = jjWorkspaces.get(canonical);
        if (marker?.repo === repo && marker.kind !== 'work_item' && (!listedName || listedName === marker.name)) {
          candidates.push({
            path: canonical,
            repo,
            workspaceName: marker.name,
            ownershipSource: 'marker',
            sourcePath,
          });
        }
      }
    }
  }
  return { candidates, warnings };
}

function markDatabaseWorkspaces(config) {
  const warnings = [];
  const rows = getDb()
    .prepare('SELECT id, pr_id, work_item_id, name, path, repo FROM workspaces WHERE work_item_id IS NULL')
    .all();
  for (const workspace of rows) {
    if (!existsSync(workspace.path)) continue;
    try {
      const coordinates = workspaceCoordinates(workspace.path, config);
      const repo = workspace.repo ?? coordinates.repo;
      if (repo !== coordinates.repo)
        throw cleanupError('workspace_identity_changed', 'database repository does not match path');
      const markerPath = resolve(coordinates.canonical, '.jj', PATROL_WORKSPACE_MARKER);
      const marker = readPatrolWorkspaceMarker(coordinates.canonical);
      if (marker) {
        if (marker.id !== workspace.id || marker.repo !== repo || marker.name !== workspace.name) {
          warnings.push(`${workspace.path}: Patrol ownership marker does not match database row ${workspace.id}`);
        }
        continue;
      }
      if (existsSync(markerPath)) {
        warnings.push(`${workspace.path}: Patrol ownership marker is invalid`);
        continue;
      }
      writePatrolWorkspaceMarker(coordinates.canonical, {
        id: workspace.id,
        repo,
        name: workspace.name,
        kind: workspace.pr_id ? 'pr' : 'scratch',
      });
    } catch (error) {
      warnings.push(`${workspace.path}: ${sanitizePublicText(error.message)}`);
    }
  }
  return warnings;
}

function canonicalOwnedPaths(excludeWorkspaceId = null) {
  const rows = getDb().prepare('SELECT id, path FROM workspaces').all();
  const paths = new Map();
  for (const row of rows) {
    if (row.id === excludeWorkspaceId) continue;
    const canonical = canonicalDirectory(row.path);
    paths.set(canonical ?? resolve(row.path), row.id);
  }
  return paths;
}

function databaseOwner(path, excludeWorkspaceId = null) {
  const canonical = canonicalDirectory(path) ?? resolve(path);
  return canonicalOwnedPaths(excludeWorkspaceId).get(canonical) ?? null;
}

function updateOrphan(path, state, step, error = null, extra = {}) {
  const assignments = ['operation_state = ?', 'operation_step = ?', 'operation_error = ?', 'operation_updated_at = ?'];
  const values = [state, step, error, new Date().toISOString()];
  for (const [column, value] of Object.entries(extra)) {
    assignments.push(`${column} = ?`);
    values.push(value);
  }
  values.push(path);
  getDb()
    .prepare(`UPDATE workspace_orphans SET ${assignments.join(', ')} WHERE path = ?`)
    .run(...values);
}

function recordOrphans(candidates, now) {
  const db = getDb();
  const owned = canonicalOwnedPaths();
  const upsert = db.prepare(`
    INSERT INTO workspace_orphans (
      path, repo, workspace_name, ownership_source, first_seen, last_seen,
      operation_state, operation_step, operation_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'detected', 'destroy:detected', ?)
    ON CONFLICT(path) DO UPDATE SET
      repo = excluded.repo,
      workspace_name = excluded.workspace_name,
      ownership_source = excluded.ownership_source,
      last_seen = excluded.last_seen
  `);
  const remove = db.prepare('DELETE FROM workspace_orphans WHERE path = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const candidate of candidates) {
      if (owned.has(candidate.path)) {
        remove.run(candidate.path);
      } else {
        upsert.run(candidate.path, candidate.repo, candidate.workspaceName, candidate.ownershipSource, now, now, now);
      }
    }
    for (const row of db.prepare('SELECT path FROM workspace_orphans').all()) {
      if (owned.has(canonicalDirectory(row.path) ?? resolve(row.path))) remove.run(row.path);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function assertPatrolAvailable(isPatrolAvailable) {
  if (!isPatrolAvailable()) {
    throw cleanupError('patrol_unavailable', 'Patrol is not available; source deletion is disabled');
  }
}

function liveSessionsUsing(path, excludeWorkspaceId = null) {
  const target = canonicalDirectory(path) ?? resolve(path);
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.workspace_id, w.path AS workspace_path, wi.path AS work_item_path
         FROM sessions s
         LEFT JOIN workspaces w ON w.id = s.workspace_id
         LEFT JOIN work_items wi ON wi.id = s.work_item_id
        WHERE s.status IN ('active', 'detached')`,
    )
    .all();
  return rows.filter((row) => {
    if (excludeWorkspaceId && row.workspace_id === excludeWorkspaceId) return true;
    for (const candidate of [row.workspace_path, row.work_item_path]) {
      if (!candidate) continue;
      const sessionPath = canonicalDirectory(candidate) ?? resolve(candidate);
      if (sessionPath === target || relationInside(target, sessionPath) !== null) return true;
    }
    return false;
  });
}

async function processesUsing(path, runExec) {
  try {
    const { stdout } = await runExec('lsof', ['-n', '-P', '-t', '+D', path], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return [
      ...new Set(
        String(stdout)
          .split(/\s+/)
          .filter((value) => /^\d+$/.test(value)),
      ),
    ];
  } catch (error) {
    const stdout = String(error.stdout ?? '');
    const pids = [...new Set(stdout.split(/\s+/).filter((value) => /^\d+$/.test(value)))];
    if (pids.length > 0) return pids;
    if (Number(error.code) === 1 && stdout.trim() === '' && String(error.stderr ?? '').trim() === '') return [];
    throw cleanupError('process_check_failed', `Could not inspect processes using ${path}: ${error.message}`);
  }
}

async function assertNoUsage(path, runExec, excludeWorkspaceId = null) {
  const sessions = liveSessionsUsing(path, excludeWorkspaceId);
  if (sessions.length > 0) {
    throw cleanupError(
      'workspace_in_use',
      `Live Patrol sessions use the workspace: ${sessions.map((session) => session.id).join(', ')}`,
    );
  }
  const pids = await processesUsing(path, runExec);
  if (pids.length > 0) {
    throw cleanupError('workspace_in_use', `Processes use the workspace tree: ${pids.join(', ')}`);
  }
}

async function assertWorkspaceIdentity(candidate, config, runExec) {
  const coordinates = workspaceCoordinates(candidate.path, config);
  if (coordinates.repo !== candidate.repo) {
    throw cleanupError(
      'workspace_identity_changed',
      `Workspace repository changed from ${candidate.repo} to ${coordinates.repo}`,
    );
  }
  const sourcePath = sourceRepositoryPath(candidate.repo, config);
  const jjWorkspaces = await listJjWorkspaces(sourcePath, runExec);
  if (jjWorkspaces.get(coordinates.canonical) !== candidate.workspaceName) {
    throw cleanupError(
      'workspace_identity_changed',
      'The jj workspace name or root no longer matches Patrol ownership',
    );
  }
  if (candidate.ownershipSource === 'marker') {
    const marker = readPatrolWorkspaceMarker(coordinates.canonical);
    if (
      !marker ||
      marker.kind === 'work_item' ||
      marker.repo !== candidate.repo ||
      marker.name !== candidate.workspaceName
    ) {
      throw cleanupError('workspace_identity_changed', 'The Patrol workspace ownership marker is missing or changed');
    }
  } else if (candidate.ownershipSource !== 'database') {
    throw cleanupError('workspace_identity_changed', 'The Patrol workspace ownership source is invalid');
  }
  return { ...coordinates, sourcePath };
}

async function inspectJjSafety(candidate, config, runExec) {
  const identity = await assertWorkspaceIdentity(candidate, config, runExec);
  let snapshot;
  try {
    snapshot = await runExec('jj', ['status', '--no-pager', '-R', identity.canonical], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw cleanupError('jj_snapshot_failed', `Fresh jj snapshot failed: ${error.message}`);
  }
  if (/\b(?:warning|error):/i.test(String(snapshot.stderr ?? ''))) {
    throw cleanupError('jj_snapshot_warning', `Fresh jj snapshot produced warnings: ${snapshot.stderr.trim()}`);
  }

  let metadata;
  try {
    ({ stdout: metadata } = await runExec(
      'jj',
      [
        'log',
        '--no-graph',
        '-r',
        '@',
        '-T',
        'commit_id ++ "\\t" ++ if(empty, "true", "false") ++ "\\t" ++ if(conflict, "true", "false") ++ "\\n"',
        '--ignore-working-copy',
        '-R',
        identity.canonical,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    ));
  } catch (error) {
    throw cleanupError('jj_inspection_failed', `Could not inspect the fresh jj commit: ${error.message}`);
  }
  const [commitId, empty, conflict] = String(metadata).trim().split('\t');
  if (!/^[0-9a-f]{40,64}$/i.test(commitId ?? '') || !['true', 'false'].includes(empty)) {
    throw cleanupError('jj_inspection_failed', 'Fresh jj commit metadata was incomplete');
  }
  if (conflict === 'true') throw cleanupError('jj_conflict', 'The workspace commit contains conflicts');
  if (empty === 'true') return { ...identity, commitId, empty: true };

  try {
    await runExec(
      'jj',
      ['git', 'fetch', '--all-remotes', '--config', 'git.abandon-unreachable-commits=false', '-R', identity.sourcePath],
      { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (error) {
    throw cleanupError('jj_fetch_failed', `Remote bookmark fetch failed: ${error.message}`);
  }

  let reachable;
  try {
    ({ stdout: reachable } = await runExec(
      'jj',
      [
        'log',
        '--no-graph',
        '-r',
        '@ & ::remote_bookmarks()',
        '-T',
        'commit_id ++ "\\n"',
        '--ignore-working-copy',
        '-R',
        identity.canonical,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    ));
  } catch (error) {
    throw cleanupError('jj_reachability_failed', `Remote reachability check failed: ${error.message}`);
  }
  if (!String(reachable).split(/\s+/).includes(commitId)) {
    throw cleanupError(
      'unpublished_changes',
      'The non-empty workspace commit is not reachable from a fetched remote bookmark',
    );
  }
  return { ...identity, commitId, empty: false };
}

async function inspectAutomaticCleanup(candidate, config, runtime, excludeWorkspaceId = null) {
  assertPatrolAvailable(runtime.isPatrolAvailable);
  if (excludeWorkspaceId === null) {
    const owner = databaseOwner(candidate.path);
    if (owner) throw cleanupError('workspace_reowned', `Workspace path is owned by database row ${owner}`);
  }
  await assertNoUsage(candidate.path, runtime.runExec, excludeWorkspaceId);
  return inspectJjSafety(candidate, config, runtime.runExec);
}

function alreadyForgotten(error) {
  return /no such workspace|no workspace named|workspace.*(?:not found|does not exist|unknown)/i.test(
    error?.message ?? '',
  );
}

async function cleanupMissingOrphan(orphan, config, runtime) {
  assertPatrolAvailable(runtime.isPatrolAvailable);
  const coordinates = workspaceCoordinates(orphan.path, config, { allowMissing: true });
  if (coordinates.repo !== orphan.repo || !['marker', 'database'].includes(orphan.ownership_source)) {
    throw cleanupError('workspace_identity_changed', 'The missing workspace no longer matches Patrol ownership');
  }
  updateOrphan(orphan.path, 'destroying', 'destroy:forget_workspace');
  try {
    const sourcePath = sourceRepositoryPath(orphan.repo, config);
    await runtime.runExec('jj', ['workspace', 'forget', orphan.workspace_name, '-R', sourcePath], {
      encoding: 'utf8',
      timeout: 30_000,
    });
  } catch (error) {
    if (!alreadyForgotten(error))
      throw cleanupError('workspace_forget_failed', `jj workspace forget failed: ${error.message}`);
  }
  updateOrphan(orphan.path, 'destroying', 'destroy:claude_project');
  const projectPath = resolve(expandPath('~/.claude/projects'), toClaudeProjectKey(orphan.path));
  await runtime.removeDirectory(projectPath);
  getDb().prepare('DELETE FROM workspace_orphans WHERE path = ?').run(orphan.path);
}

async function cleanupOrphan(orphan, config, runtime) {
  updateOrphan(orphan.path, 'destroying', 'destroy:sessions', null);
  const safety = await inspectAutomaticCleanup(
    {
      path: orphan.path,
      repo: orphan.repo,
      workspaceName: orphan.workspace_name,
      ownershipSource: orphan.ownership_source,
    },
    config,
    runtime,
  );
  updateOrphan(orphan.path, 'destroying', 'destroy:snapshot', null, { commit_id: safety.commitId });

  updateOrphan(orphan.path, 'destroying', 'destroy:docker');
  const dockerWarning = await runtime.dockerDown(orphan.path);
  if (dockerWarning) throw cleanupError('docker_cleanup_failed', dockerWarning);

  assertPatrolAvailable(runtime.isPatrolAvailable);
  const owner = databaseOwner(orphan.path);
  if (owner) throw cleanupError('workspace_reowned', `Workspace path is owned by database row ${owner}`);
  await assertNoUsage(orphan.path, runtime.runExec);

  updateOrphan(orphan.path, 'destroying', 'destroy:forget_workspace');
  try {
    await runtime.runExec('jj', ['workspace', 'forget', orphan.workspace_name, '-R', safety.sourcePath], {
      encoding: 'utf8',
      timeout: 30_000,
    });
  } catch (error) {
    if (!alreadyForgotten(error))
      throw cleanupError('workspace_forget_failed', `jj workspace forget failed: ${error.message}`);
  }

  updateOrphan(orphan.path, 'destroying', 'destroy:transcripts');
  updateOrphan(orphan.path, 'destroying', 'destroy:directory');
  assertPatrolAvailable(runtime.isPatrolAvailable);
  const finalOwner = databaseOwner(orphan.path);
  if (finalOwner) throw cleanupError('workspace_reowned', `Workspace path is owned by database row ${finalOwner}`);
  await assertNoUsage(orphan.path, runtime.runExec);
  await runtime.removeDirectory(orphan.path);

  updateOrphan(orphan.path, 'destroying', 'destroy:claude_project');
  const projectPath = resolve(expandPath('~/.claude/projects'), toClaudeProjectKey(orphan.path));
  await runtime.removeDirectory(projectPath);
  getDb().prepare('DELETE FROM workspace_orphans WHERE path = ?').run(orphan.path);
}

async function cleanupStaleDatabaseWorkspace(workspace, config, runtime) {
  if (!existsSync(workspace.path)) {
    const coordinates = workspaceCoordinates(workspace.path, config, { allowMissing: true });
    if (workspace.repo && coordinates.repo !== workspace.repo) {
      throw cleanupError(
        'workspace_identity_changed',
        'The missing workspace repository no longer matches its database row',
      );
    }
    await destroyWorkspaceWithGuards(workspace.id, config, { runExec: runtime.runExec });
    return;
  }
  const coordinates = workspaceCoordinates(workspace.path, config);
  const marker = readPatrolWorkspaceMarker(coordinates.canonical);
  const ownershipSource = marker ? 'marker' : 'database';
  await inspectAutomaticCleanup(
    {
      path: coordinates.canonical,
      repo: workspace.repo ?? coordinates.repo,
      workspaceName: workspace.name,
      ownershipSource,
    },
    config,
    runtime,
    workspace.id,
  );
  assertPatrolAvailable(runtime.isPatrolAvailable);
  await assertNoUsage(workspace.path, runtime.runExec, workspace.id);
  await destroyWorkspaceWithGuards(workspace.id, config, {
    runExec: runtime.runExec,
    beforeDirectoryRemoval: async () => {
      assertPatrolAvailable(runtime.isPatrolAvailable);
      workspaceCoordinates(workspace.path, config);
      const owner = databaseOwner(workspace.path, workspace.id);
      if (owner) throw cleanupError('workspace_reowned', `Workspace path is also owned by database row ${owner}`);
      await assertNoUsage(workspace.path, runtime.runExec, workspace.id);
    },
  });
}

/**
 * Reconcile Patrol's database and filesystem, then automatically remove only
 * inactive trees that pass every deletion gate. This function requires an
 * explicit live-server predicate so callers cannot delete while Patrol is
 * unavailable.
 */
export async function reconcilePatrolWorkspacesOnStartup(
  config,
  {
    isPatrolAvailable = () => false,
    runExec = execFile,
    dockerDown = dockerComposeDown,
    removeDirectory = (path) => rm(path, { recursive: true, force: true }),
    now = () => new Date().toISOString(),
  } = {},
) {
  if (!isPatrolAvailable()) {
    return { deleted: [], cleanedWorkspaces: [], blocked: [], warnings: ['Patrol is unavailable; cleanup skipped'] };
  }
  const runtime = { isPatrolAvailable, runExec, dockerDown, removeDirectory };
  const db = getDb();
  db.prepare(
    `UPDATE workspace_orphans
        SET operation_state = 'error',
            operation_error = 'Interrupted during ' || operation_step,
            operation_updated_at = ?
      WHERE operation_state = 'destroying'`,
  ).run(now());

  const markerWarnings = markDatabaseWorkspaces(config);
  const discovery = await discoverPatrolWorkspaceDirectories(config, { runExec });
  recordOrphans(discovery.candidates, now());

  const deleted = [];
  const cleanedWorkspaces = [];
  const blocked = [];
  const staleRows = db
    .prepare(
      `SELECT * FROM workspaces
        WHERE work_item_id IS NULL
          AND (operation_state = 'error' OR (status = 'destroyed' AND operation_state = 'destroyed'))
        ORDER BY operation_updated_at, id`,
    )
    .all();
  for (const workspace of staleRows) {
    try {
      await cleanupStaleDatabaseWorkspace(workspace, config, runtime);
      cleanedWorkspaces.push(workspace.id);
    } catch (error) {
      blocked.push({ path: workspace.path, reason: sanitizePublicText(error.message), code: error.code ?? null });
    }
  }

  const orphans = db.prepare('SELECT * FROM workspace_orphans ORDER BY first_seen, path').all();
  for (const orphan of orphans) {
    try {
      if (existsSync(orphan.path)) {
        await cleanupOrphan(orphan, config, runtime);
      } else {
        await cleanupMissingOrphan(orphan, config, runtime);
      }
      deleted.push(orphan.path);
    } catch (error) {
      const message = sanitizePublicText(error.message);
      updateOrphan(
        orphan.path,
        'error',
        getDb().prepare('SELECT operation_step FROM workspace_orphans WHERE path = ?').get(orphan.path)
          ?.operation_step ?? 'destroy:failed',
        message,
      );
      blocked.push({ path: orphan.path, reason: message, code: error.code ?? null });
    }
  }
  return { deleted, cleanedWorkspaces, blocked, warnings: [...markerWarnings, ...discovery.warnings] };
}
