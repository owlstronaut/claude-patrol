import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { emitLocalChange } from '../app-events.js';
import {
  attachSession,
  createResumedSession,
  createSession,
  killSessionAndWait,
  normalizeGlobalSessionName,
  popOutSession,
  reattachSession,
} from '../pty-manager.js';
import { sanitizePublicText } from '../public-errors.js';
import { normalizeSessionProvider } from '../session-launch.js';
import { sessionTargetFromRow } from '../session-target.js';
import { runTask } from '../tasks.js';
import {
  claudeProjectDirForWorkspace,
  findSessionJsonl,
  getOrCreateTranscriptSummary,
  parseTranscript,
} from '../transcripts.js';
import { execFile, expandPath, toClaudeProjectKey } from '../utils.js';
import { createScratchWorkspace } from '../workspace.js';

/**
 * Register session routes.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerSessionRoutes(app) {
  const { getConfig, getDb, getSessionStates } = app.appContext;
  const launchSession = app.appContext.createSession ?? createSession;
  const formatSession = (row, stateBySessionId = null) => {
    const workItem = row.work_item_id
      ? getDb().prepare('SELECT title, reference, path FROM work_items WHERE id = ?').get(row.work_item_id)
      : null;
    const activityState =
      stateBySessionId === null
        ? (getSessionStates().find((entry) => entry.sessionId === row.id)?.state ?? null)
        : (stateBySessionId.get(row.id) ?? null);
    return {
      ...row,
      target: sessionTargetFromRow(row),
      activity_state: activityState,
      work_item_title: workItem?.title ?? null,
      work_item_reference: workItem?.reference ?? null,
      root_path: workItem?.path ?? null,
    };
  };
  const formatSessions = (rows) => {
    const stateBySessionId = new Map(getSessionStates().map((entry) => [entry.sessionId, entry.state]));
    return rows.map((row) => formatSession(row, stateBySessionId));
  };
  const targetError = (reply, code, message, status = 400) =>
    reply.code(status).send({
      error: {
        code,
        message: sanitizePublicText(message, { maxBytes: 4096 }),
        detail: null,
        failed_provider: null,
        retry_action: null,
        recovery_actions: [],
      },
    });

  app.post('/api/sessions', (request, reply) => {
    const { workspace_id, work_item_id, global: isGlobal, name: rawName } = request.body || {};
    let provider;
    try {
      provider = request.body?.provider === undefined ? null : normalizeSessionProvider(request.body.provider);
    } catch (error) {
      return targetError(reply, 'invalid_provider', error.message);
    }
    const db = getDb();

    const keys = request.body && typeof request.body === 'object' ? Object.keys(request.body) : [];
    const targetCount = (workspace_id ? 1 : 0) + (work_item_id ? 1 : 0) + (isGlobal === true ? 1 : 0);
    if (targetCount !== 1) {
      return targetError(reply, 'invalid_request', 'Exactly one session target is required');
    }

    let cwd;
    let target;
    let sessionOptions = {};
    if (isGlobal === true) {
      if (keys.some((key) => !['global', 'provider', 'name'].includes(key)) || provider === null) {
        return targetError(reply, 'invalid_request', 'Global sessions require global: true and provider');
      }
      let name;
      try {
        name = normalizeGlobalSessionName(rawName);
      } catch (error) {
        return targetError(reply, 'invalid_session_name', error.message);
      }
      cwd = getConfig().global_terminal_cwd || process.cwd();
      target = { type: 'global' };
      sessionOptions = { name, reuseExisting: false };
    } else if (workspace_id) {
      if (keys.some((key) => !['workspace_id', 'provider'].includes(key)) || provider === null) {
        return targetError(reply, 'invalid_request', 'Workspace sessions require workspace_id and provider');
      }
      const workspace = db
        .prepare(
          "SELECT * FROM workspaces WHERE id = ? AND work_item_id IS NULL AND status = 'active' AND operation_state = 'ready'",
        )
        .get(workspace_id);
      if (!workspace) {
        const child = db.prepare('SELECT work_item_id FROM workspaces WHERE id = ?').get(workspace_id);
        if (child?.work_item_id) {
          return targetError(
            reply,
            'work_item_child_managed',
            'Work-item child workspaces do not have independent sessions',
            409,
          );
        }
        return targetError(reply, 'invalid_state', 'Workspace not found or not active', 409);
      }
      cwd = workspace.path;
      target = { type: 'workspace', id: workspace_id };
    } else if (work_item_id) {
      if (keys.some((key) => !['work_item_id', 'provider'].includes(key)) || provider === null) {
        return targetError(reply, 'invalid_request', 'Work-item sessions require work_item_id and provider');
      }
      const workItem = db.prepare('SELECT * FROM work_items WHERE id = ?').get(work_item_id);
      if (!workItem) return targetError(reply, 'work_item_not_found', 'Work item not found', 404);
      if (workItem.state !== 'ready') return targetError(reply, 'invalid_state', 'Work item is not ready', 409);
      const live = db
        .prepare("SELECT id FROM sessions WHERE work_item_id = ? AND status IN ('active', 'detached')")
        .get(work_item_id);
      if (live) return targetError(reply, 'session_exists', 'A work-item session is already running', 409);
      cwd = workItem.path;
      target = { type: 'work_item', id: work_item_id };
      sessionOptions = {
        enablePatrolMcp: true,
      };
    } else {
      return targetError(reply, 'invalid_request', 'Session target is required');
    }

    try {
      const session = launchSession(target, cwd, provider, sessionOptions);
      if (work_item_id) {
        db.prepare('UPDATE work_items SET work_provider = ?, updated_at = ? WHERE id = ?').run(
          provider,
          new Date().toISOString(),
          work_item_id,
        );
      }
      const persistedSession = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id) ?? session;
      emitLocalChange();
      return reply.code(201).send({
        ...formatSession(persistedSession),
        ws_url: `ws://${request.hostname}/ws/sessions/${session.id}`,
      });
    } catch (err) {
      const status = ['provider_conflict', 'global_session_limit'].includes(err.code) ? 409 : 500;
      return targetError(
        reply,
        err.code ?? 'session_launch_failed',
        `Failed to create session: ${err.message}`,
        status,
      );
    }
  });

  app.get('/api/sessions', (request, reply) => {
    const db = getDb();
    const { workspace_id, work_item_id, global: isGlobal } = request.query;
    const filterCount = (workspace_id ? 1 : 0) + (work_item_id ? 1 : 0) + (isGlobal === 'true' ? 1 : 0);
    if (filterCount > 1) return targetError(reply, 'invalid_request', 'Session filters are mutually exclusive');
    if (workspace_id) {
      const child = db.prepare('SELECT work_item_id FROM workspaces WHERE id = ?').get(workspace_id);
      if (child?.work_item_id) {
        return targetError(
          reply,
          'work_item_child_managed',
          'Work-item child workspaces do not have independent sessions',
          409,
        );
      }
      const rows = db
        .prepare("SELECT * FROM sessions WHERE workspace_id = ? AND status IN ('active', 'detached')")
        .all(workspace_id);
      return formatSessions(rows);
    }
    if (work_item_id) {
      const rows = db
        .prepare("SELECT * FROM sessions WHERE work_item_id = ? AND status IN ('active', 'detached')")
        .all(work_item_id);
      return formatSessions(rows);
    }
    if (isGlobal === 'true') {
      const rows = db
        .prepare(
          `SELECT * FROM sessions
            WHERE workspace_id IS NULL
              AND work_item_id IS NULL
              AND status IN ('active', 'detached')
            ORDER BY started_at, id`,
        )
        .all();
      return formatSessions(rows);
    }
    const rows = db
      .prepare(
        `SELECT s.*
         FROM sessions s
         LEFT JOIN workspaces w ON w.id = s.workspace_id
         WHERE s.status IN ('active', 'detached')
           AND (s.workspace_id IS NULL OR w.work_item_id IS NULL)`,
      )
      .all();
    return formatSessions(rows);
  });

  app.patch('/api/sessions/:id', (request, reply) => {
    const keys = request.body && typeof request.body === 'object' ? Object.keys(request.body) : [];
    if (keys.length !== 1 || keys[0] !== 'name') {
      return targetError(reply, 'invalid_request', 'Session rename requires only name');
    }

    let name;
    try {
      name = normalizeGlobalSessionName(request.body.name);
    } catch (error) {
      return targetError(reply, 'invalid_session_name', error.message);
    }
    if (name === null) return targetError(reply, 'invalid_session_name', 'Session name is required');

    const db = getDb();
    const session = db
      .prepare(
        `SELECT * FROM sessions
          WHERE id = ?
            AND workspace_id IS NULL
            AND work_item_id IS NULL
            AND status IN ('active', 'detached')`,
      )
      .get(request.params.id);
    if (!session) return targetError(reply, 'session_not_found', 'Live global session not found', 404);

    db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, session.id);
    emitLocalChange();
    return formatSession({ ...session, name });
  });

  app.delete('/api/sessions/:id', async (request, reply) => {
    try {
      await killSessionAndWait(request.params.id);
    } catch (error) {
      return targetError(reply, error.code ?? 'session_stop_failed', error.message, 500);
    }
    return { ok: true };
  });

  app.post('/api/sessions/:id/popout', (request, reply) => {
    try {
      popOutSession(request.params.id);
      emitLocalChange();
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post('/api/sessions/:id/reattach', (request, reply) => {
    try {
      const session = reattachSession(request.params.id);
      emitLocalChange();
      return formatSession(session);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Session history (all sessions - active and killed)
  app.get('/api/sessions/history', (request, reply) => {
    const db = getDb();
    const { workspace_id, work_item_id, global: isGlobal } = request.query;
    const filterCount = (workspace_id ? 1 : 0) + (work_item_id ? 1 : 0) + (isGlobal === 'true' ? 1 : 0);
    if (filterCount > 1) return targetError(reply, 'invalid_request', 'Session filters are mutually exclusive');
    if (workspace_id) {
      const child = db.prepare('SELECT work_item_id FROM workspaces WHERE id = ?').get(workspace_id);
      if (child?.work_item_id) {
        return targetError(
          reply,
          'work_item_child_managed',
          'Work-item child workspaces do not have independent history',
          409,
        );
      }
      return db
        .prepare('SELECT * FROM sessions WHERE workspace_id = ? ORDER BY started_at DESC')
        .all(workspace_id)
        .map(formatSession);
    }
    if (work_item_id) {
      return db
        .prepare('SELECT * FROM sessions WHERE work_item_id = ? ORDER BY started_at DESC')
        .all(work_item_id)
        .map(formatSession);
    }
    if (isGlobal === 'true') {
      return db
        .prepare('SELECT * FROM sessions WHERE workspace_id IS NULL AND work_item_id IS NULL ORDER BY started_at DESC')
        .all()
        .map(formatSession);
    }
    return db
      .prepare(
        `SELECT s.*
         FROM sessions s
         LEFT JOIN workspaces w ON w.id = s.workspace_id
         WHERE s.status = 'killed'
           AND (s.workspace_id IS NULL OR w.work_item_id IS NULL)
         ORDER BY s.started_at DESC LIMIT 100`,
      )
      .all()
      .map(formatSession);
  });

  // Session transcript
  app.get('/api/sessions/:id/transcript', (request, reply) => {
    const db = getDb();
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    if (session.provider !== 'claude') {
      return reply.code(409).send({ error: 'Transcripts are only available for Claude sessions' });
    }

    // Derive claude_project_dir from workspace path if not stored (pre-migration sessions)
    let claudeProjectDir = session.claude_project_dir;
    if (!claudeProjectDir && session.workspace_id) {
      const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(session.workspace_id);
      if (ws) {
        claudeProjectDir = claudeProjectDirForWorkspace(ws.path);
      }
    } else if (!claudeProjectDir && session.work_item_id) {
      const item = db.prepare('SELECT path FROM work_items WHERE id = ?').get(session.work_item_id);
      if (item) claudeProjectDir = claudeProjectDirForWorkspace(item.path);
    }

    let jsonlPath = null;

    // Prefer our archived copy
    if (session.transcript_path && existsSync(session.transcript_path)) {
      jsonlPath = session.transcript_path;
    } else if (claudeProjectDir) {
      // Try to find the live JSONL
      jsonlPath = findSessionJsonl(claudeProjectDir, session.started_at, session.ended_at);
    }

    if (!jsonlPath) {
      return reply.code(404).send({ error: 'No transcript available' });
    }

    if (request.query.path_only) {
      if (request.query.summary) {
        const summaryPath = getOrCreateTranscriptSummary(jsonlPath);
        return { summary_path: summaryPath || jsonlPath, transcript_path: jsonlPath };
      }
      return { path: jsonlPath };
    }

    try {
      return parseTranscript(jsonlPath);
    } catch (err) {
      return reply.code(500).send({ error: `Failed to read transcript: ${err.message}` });
    }
  });

  // Promote a global session to a scratch workspace
  app.post('/api/sessions/:id/promote', async (request, reply) => {
    const { repo, branch } = request.body || {};
    if (!repo || !branch) {
      return reply.code(400).send({ error: 'repo and branch are required' });
    }

    const db = getDb();
    const session = db.prepare("SELECT * FROM sessions WHERE id = ? AND status = 'active'").get(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found or not active' });
    }
    if (session.workspace_id || session.work_item_id) {
      return reply.code(400).send({ error: 'Session is already in a workspace' });
    }
    if (session.provider !== 'claude') {
      return reply.code(409).send({ error: 'Only Claude sessions can be promoted' });
    }

    const config = getConfig();
    const [org, repoName] = repo.split('/');
    const mainRepoPath = resolve(expandPath(config.work_dir), org, repoName);

    try {
      const { workspace, session: newSession } = await runTask(
        {
          kind: 'session.promote',
          label: `Promote session to scratch-${branch.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`,
          context: { sessionId: session.id, repo, branch },
        },
        async () => {
          // 1. Create scratch workspace starting from default@- (parent of main working copy)
          const workspace = await createScratchWorkspace(repo, branch, config, { startRevision: 'default@-' });

          // 2. Migrate changes via jj squash (non-fatal if empty)
          try {
            await execFile('jj', ['squash', '--from', 'default@', '--into', `${workspace.name}@`, '-R', mainRepoPath]);
          } catch (err) {
            console.warn(`[promote] jj squash non-fatal: ${err.message}`);
          }

          // 3. Copy Claude session files to new workspace's project dir
          let claudeSessionUuid = null;
          if (session.claude_project_dir) {
            const jsonlPath = findSessionJsonl(session.claude_project_dir, session.started_at, null);
            if (jsonlPath) {
              claudeSessionUuid = basename(jsonlPath, '.jsonl');
              const targetProjectDir = resolve(expandPath('~/.claude/projects'), toClaudeProjectKey(workspace.path));
              mkdirSync(targetProjectDir, { recursive: true });

              // Copy the .jsonl file
              copyFileSync(jsonlPath, resolve(targetProjectDir, basename(jsonlPath)));

              // Copy the session directory (contains tool results, images, etc.) if it exists
              const sessionDir = resolve(session.claude_project_dir, claudeSessionUuid);
              const targetSessionDir = resolve(targetProjectDir, claudeSessionUuid);
              if (existsSync(sessionDir)) {
                cpSync(sessionDir, targetSessionDir, { recursive: true });
              }
            }
          }

          // 4. Kill the old global session
          await killSessionAndWait(session.id);

          // 5. Create new session in workspace with --resume
          const newSession = claudeSessionUuid
            ? createResumedSession({ type: 'workspace', id: workspace.id }, workspace.path, claudeSessionUuid)
            : createSession({ type: 'workspace', id: workspace.id }, workspace.path);

          return { workspace, session: newSession };
        },
      );

      emitLocalChange();
      return reply.code(201).send({ workspace, session: newSession });
    } catch (err) {
      return reply.code(500).send({ error: `Promote failed: ${err.message}` });
    }
  });

  // WebSocket route for terminal attachment
  app.get('/ws/sessions/:id', { websocket: true }, (socket, request) => {
    attachSession(request.params.id, socket);
  });
}
