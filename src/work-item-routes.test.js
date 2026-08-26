import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, test } from 'node:test';
import { actionRegistry } from './actions.js';
import { createAppContext } from './app-context.js';
import { appEvents } from './app-events.js';
import { parseConfig } from './config.js';
import { closeDb, getDb, initDb } from './db.js';
import { ensureSessionAndSend } from './dispatcher.js';
import { createServer } from './server.js';

afterEach(() => closeDb());

function configFixture() {
  return parseConfig({
    poll: { orgs: [], repos: [] },
    repos: { 'acme/widgets': { defaultRevision: 'main@origin' } },
    work_items: {
      repositories: ['acme/widgets'],
      resolver: {
        server: {
          name: 'work-reference',
          transport: 'http',
          url: 'https://mcp.example.test/readonly',
          enabled_tools: ['get_issue'],
        },
        instructions: 'Resolve project references.',
      },
    },
  });
}

function listItem(id = 'item-1') {
  return {
    id,
    reference: 'PROJECT-1',
    title: null,
    work_provider: 'codex',
    resolver_provider: 'codex',
    state: 'resolving',
    stage: 'provider_check',
    progress: { current: 0, total: 0 },
    repositories: [],
    updated_at: '2026-08-22T00:00:00.000Z',
    has_session_history: false,
    session: null,
    error: null,
  };
}

async function serverFixture(workItemService, overrides = {}) {
  initDb(':memory:');
  const config = configFixture();
  const context = createAppContext({
    getConfig: () => config,
    getDb,
    appEvents: new EventEmitter(),
    pollerEvents: new EventEmitter(),
    getSessionStates: () => [],
    getGhRateLimitState: () => ({ limited: false }),
    workItemService,
    ...overrides,
  });
  return createServer({ context, config });
}

test('work-item routes use the fixed asynchronous DTO and structured errors', async () => {
  const item = listItem();
  const service = {
    create: ({ reference, workProvider }) => ({ ...item, reference, work_provider: workProvider }),
    list: () => [item],
    detail: (id) => (id === item.id ? { ...item, root_path: '/tmp/item-1', repository_workspaces: [] } : null),
    retry: () => item,
    destroy: () => ({ accepted: true }),
    waitForIdle: async () => {},
  };
  const server = await serverFixture(service);
  try {
    const invalid = await server.inject({
      method: 'POST',
      url: '/api/work-items',
      payload: { reference: 'PROJECT-1', work_provider: 'codex', unexpected: true },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, 'invalid_request');

    const created = await server.inject({
      method: 'POST',
      url: '/api/work-items',
      payload: { reference: 'PROJECT-1', work_provider: 'codex' },
    });
    assert.equal(created.statusCode, 202);
    assert.equal(created.headers.location, '/api/work-items/item-1');
    assert.equal(created.json().work_item.reference, 'PROJECT-1');
    const startAction = actionRegistry.start_work_item;
    const startArgs = startAction.schema.parse({ reference: 'PROJECT-1', work_provider: 'codex' });
    assert.deepEqual(startAction.dispatch(startArgs), {
      method: 'POST',
      path: '/api/work-items',
      body: { reference: 'PROJECT-1', work_provider: 'codex' },
    });
    assert.deepEqual(startAction.transform(created.json()), created.json().work_item);
    const started = await startAction.mcpHandler(server, {
      reference: 'PROJECT-1',
      work_provider: 'codex',
    });
    assert.equal(started.id, 'item-1');
    assert.equal(started.root_path, '/tmp/item-1');

    const list = await server.inject({ method: 'GET', url: '/api/work-items' });
    assert.deepEqual(list.json(), { work_items: [item] });
    const repositories = await server.inject({ method: 'GET', url: '/api/repos' });
    assert.deepEqual(repositories.json(), { repos: ['acme/widgets'] });
    const missing = await server.inject({ method: 'GET', url: '/api/work-items/missing' });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'work_item_not_found');
  } finally {
    await server.close();
  }
});

test('repository workspace MCP calls support inferred and explicit work-item targets', async () => {
  const calls = [];
  const service = {
    create() {},
    list: () => [],
    detail: () => null,
    retry() {},
    destroy() {},
    addRepository: async (id, repository, revision) => {
      calls.push({ id, repository, revision });
      return { added: true, work_item: { id }, repository_workspace: { identifier: repository } };
    },
  };
  const server = await serverFixture(service);
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO work_items (
        id, reference, path, resolved_repositories_json, work_provider, resolver_provider, state, stage,
        progress_current, progress_total, created_at, updated_at
      ) VALUES ('item-1', 'PROJECT-1', '/tmp/item-1', '["acme/widgets"]', 'codex', 'codex',
        'ready', 'complete', 0, 0, ?, ?)`,
    )
    .run(now, now);
  getDb()
    .prepare(
      `INSERT INTO sessions (id, work_item_id, pid, provider, status, started_at)
       VALUES ('work-session', 'item-1', 1, 'codex', 'active', ?)`,
    )
    .run(now);

  try {
    const inferred = await actionRegistry.add_repo_workspace.mcpHandler(
      server,
      { repo: 'acme/widgets' },
      { callerSessionId: 'work-session' },
    );
    assert.equal(inferred.added, true);
    const explicit = await actionRegistry.add_repo_workspace.mcpHandler(
      server,
      { repo: 'acme/widgets', revision: 'feature@git', work_item_id: 'item-2' },
      { callerSessionId: 'outside-session' },
    );
    assert.equal(explicit.work_item.id, 'item-2');
    assert.deepEqual(calls, [
      { id: 'item-1', repository: 'acme/widgets', revision: undefined },
      { id: 'item-2', repository: 'acme/widgets', revision: 'feature@git' },
    ]);

    const firstPullRequest = await actionRegistry.link_pull_request.mcpHandler(
      server,
      { pr: 'https://github.com/acme/widgets/pull/8' },
      { callerSessionId: 'work-session' },
    );
    assert.equal(firstPullRequest.id, 'acme/widgets#8');
    const secondPullRequest = await server.inject({
      method: 'POST',
      url: '/api/work-items/item-1/pull-requests',
      payload: { pr: 'acme/widgets#9' },
    });
    assert.equal(secondPullRequest.statusCode, 200);
    assert.equal(
      getDb().prepare("SELECT COUNT(*) AS count FROM work_item_pull_requests WHERE work_item_id = 'item-1'").get()
        .count,
      2,
    );
    const detached = await actionRegistry.unlink_pull_request.mcpHandler(
      server,
      { pr: 'acme/widgets#8' },
      { callerSessionId: 'work-session' },
    );
    assert.equal(detached.removed, true);

    const missingTarget = await actionRegistry.add_repo_workspace.mcpHandler(
      server,
      { repo: 'acme/widgets' },
      { callerSessionId: 'outside-session' },
    );
    assert.equal(missingTarget.error, 'work_item_id_required');
    const missingPullRequestTarget = await actionRegistry.link_pull_request.mcpHandler(
      server,
      { pr: 'acme/widgets#10' },
      { callerSessionId: 'outside-session' },
    );
    assert.equal(missingPullRequestTarget.error, 'work_item_id_required');
  } finally {
    await server.close();
  }
});

test('work-item session creation accepts a selected provider and persists it', async () => {
  const service = { create() {}, list: () => [], detail: () => null, retry() {}, destroy() {} };
  const launches = [];
  const server = await serverFixture(service, {
    createSession: (target, cwd, provider, options) => {
      launches.push({ target, cwd, provider, options });
      return {
        id: 'selected-provider-session',
        workspace_id: null,
        work_item_id: target.id,
        pid: 123,
        provider,
        status: 'active',
        started_at: '2026-08-22T00:00:00.000Z',
      };
    },
  });
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO work_items (
        id, reference, path, work_provider, resolver_provider, state, stage,
        progress_current, progress_total, created_at, updated_at
      ) VALUES ('provider-item', 'PROJECT-PROVIDER', '/tmp/provider-item', 'codex', 'codex',
        'ready', 'complete', 0, 0, ?, ?)`,
    )
    .run(now, now);

  try {
    const missingProvider = await server.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { work_item_id: 'provider-item' },
    });
    assert.equal(missingProvider.statusCode, 400);
    assert.equal(missingProvider.json().error.code, 'invalid_request');

    const response = await server.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { work_item_id: 'provider-item', provider: 'claude' },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().provider, 'claude');
    assert.deepEqual(launches[0].target, { type: 'work_item', id: 'provider-item' });
    assert.equal(launches[0].cwd, '/tmp/provider-item');
    assert.equal(launches[0].provider, 'claude');
    assert.deepEqual(launches[0].options, { enablePatrolMcp: true });
    assert.equal(
      getDb().prepare('SELECT work_provider FROM work_items WHERE id = ?').get('provider-item').work_provider,
      'claude',
    );
  } finally {
    await server.close();
  }
});

test('global session routes create distinct named sessions and reject ambiguous dispatch', async () => {
  const service = {
    create() {},
    list: () => [],
    detail: () => null,
    retry() {},
    destroy() {},
    waitForIdle: async () => {},
  };
  const launches = [];
  let sequence = 0;
  let stateReads = 0;
  const server = await serverFixture(service, {
    getSessionStates() {
      stateReads++;
      return [];
    },
    createSession(target, _cwd, provider, options) {
      if (options.name === 'Overflow') {
        const error = new Error('global session limit reached');
        error.code = 'global_session_limit';
        throw error;
      }
      sequence++;
      const session = {
        id: `global-${sequence}`,
        workspace_id: null,
        work_item_id: null,
        name: options.name,
        pid: sequence,
        provider,
        status: 'active',
        started_at: `2026-08-22T00:00:0${sequence}.000Z`,
        ended_at: null,
        claude_project_dir: null,
        transcript_path: null,
      };
      launches.push({ target, provider, options });
      getDb()
        .prepare(
          `INSERT INTO sessions (id, name, pid, provider, status, started_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(session.id, session.name, session.pid, session.provider, session.status, session.started_at);
      return session;
    },
  });

  try {
    const first = await server.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { global: true, provider: 'claude', name: 'Planner' },
    });
    const second = await server.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { global: true, provider: 'codex', name: 'Reviewer' },
    });
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.equal(first.json().name, 'Planner');
    assert.equal(second.json().name, 'Reviewer');
    assert.deepEqual(
      launches.map(({ target, provider, options }) => ({ target, provider, options })),
      [
        { target: { type: 'global' }, provider: 'claude', options: { name: 'Planner', reuseExisting: false } },
        { target: { type: 'global' }, provider: 'codex', options: { name: 'Reviewer', reuseExisting: false } },
      ],
    );

    stateReads = 0;
    const listed = await server.inject({ method: 'GET', url: '/api/sessions?global=true' });
    assert.equal(stateReads, 1);
    assert.deepEqual(
      listed.json().map(({ id, name }) => ({ id, name })),
      [
        { id: 'global-1', name: 'Planner' },
        { id: 'global-2', name: 'Reviewer' },
      ],
    );

    const renamed = await server.inject({
      method: 'PATCH',
      url: '/api/sessions/global-2',
      payload: { name: '  Critic  ' },
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().name, 'Critic');
    assert.equal(getDb().prepare("SELECT name FROM sessions WHERE id = 'global-2'").get().name, 'Critic');

    const invalidName = await server.inject({
      method: 'PATCH',
      url: '/api/sessions/global-2',
      payload: { name: '   ' },
    });
    assert.equal(invalidName.statusCode, 400);
    assert.equal(invalidName.json().error.code, 'invalid_session_name');

    const deceptiveName = await server.inject({
      method: 'PATCH',
      url: '/api/sessions/global-2',
      payload: { name: 'Critic\u202ereversed' },
    });
    assert.equal(deceptiveName.statusCode, 400);
    assert.equal(deceptiveName.json().error.code, 'invalid_session_name');

    const overLimit = await server.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { global: true, provider: 'claude', name: 'Overflow' },
    });
    assert.equal(overLimit.statusCode, 409);
    assert.equal(overLimit.json().error.code, 'global_session_limit');

    await assert.rejects(
      ensureSessionAndSend({ global: true, prompt: 'do not choose arbitrarily' }),
      (error) => error.code === 'ambiguous_target',
    );
  } finally {
    await server.close();
  }
});

test('session deletion does not emit a change when no session changes', async () => {
  const service = { create() {}, list: () => [], detail: () => null, retry() {}, destroy() {} };
  const server = await serverFixture(service);
  let localChanges = 0;
  const onLocalChange = () => {
    localChanges++;
  };
  appEvents.on('local-change', onLocalChange);

  try {
    const response = await server.inject({ method: 'DELETE', url: '/api/sessions/missing' });
    assert.equal(response.statusCode, 200);
    assert.equal(localChanges, 0);
  } finally {
    appEvents.off('local-change', onLocalChange);
    await server.close();
  }
});

test('session filters distinguish global, work-item, and managed child targets', async () => {
  const service = { create() {}, list: () => [], detail: () => null, retry() {}, destroy() {} };
  const server = await serverFixture(service);
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO work_items (
        id, reference, path, work_provider, resolver_provider, state, stage,
        progress_current, progress_total, created_at, updated_at
      ) VALUES ('item-1', 'PROJECT-1', '/tmp/item-1', 'codex', 'codex',
        'ready', 'complete', 0, 0, ?, ?)`,
    )
    .run(now, now);
  getDb()
    .prepare(
      `INSERT INTO workspaces (
        id, work_item_id, name, path, bookmark, repo, status, created_at,
        operation_state, operation_updated_at
      ) VALUES ('child-1', 'item-1', 'child', '/tmp/child', 'patrol/work-item-1',
        'acme/widgets', 'active', ?, 'ready', ?)`,
    )
    .run(now, now);
  getDb()
    .prepare(
      `INSERT INTO sessions (id, work_item_id, pid, provider, status, started_at)
       VALUES ('work-session', 'item-1', 1, 'codex', 'active', ?)`,
    )
    .run(now);
  getDb()
    .prepare(
      `INSERT INTO sessions (id, workspace_id, pid, provider, status, started_at)
       VALUES ('child-session', 'child-1', 3, 'claude', 'active', ?)`,
    )
    .run(now);
  getDb()
    .prepare(
      `INSERT INTO sessions (id, pid, provider, status, started_at)
       VALUES ('global-session', 2, 'claude', 'active', ?)`,
    )
    .run(now);

  try {
    const invalidProvider = await server.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { global: true, provider: 'sk-abcdefghijklmnop' },
    });
    assert.equal(invalidProvider.statusCode, 400);
    assert.equal(invalidProvider.json().error.code, 'invalid_provider');
    assert.doesNotMatch(invalidProvider.json().error.message, /abcdefghijklmnop/);

    const global = await server.inject({ method: 'GET', url: '/api/sessions?global=true' });
    assert.deepEqual(
      global.json().map((session) => session.id),
      ['global-session'],
    );
    assert.deepEqual(global.json()[0].target, { type: 'global' });

    const all = await server.inject({ method: 'GET', url: '/api/sessions' });
    assert.deepEqual(
      all
        .json()
        .map((session) => session.id)
        .sort(),
      ['global-session', 'work-session'],
    );

    const workItem = await server.inject({ method: 'GET', url: '/api/sessions?work_item_id=item-1' });
    assert.deepEqual(
      workItem.json().map((session) => session.id),
      ['work-session'],
    );
    assert.deepEqual(workItem.json()[0].target, { type: 'work_item', id: 'item-1' });

    const child = await server.inject({ method: 'GET', url: '/api/sessions?workspace_id=child-1' });
    assert.equal(child.statusCode, 409);
    assert.equal(child.json().error.code, 'work_item_child_managed');
    await assert.rejects(
      ensureSessionAndSend({ session_id: 'child-session', prompt: 'do not run' }),
      (error) => error.code === 'unsupported_target',
    );

    const childMcp = await server.inject({ method: 'POST', url: '/mcp/child-session', payload: {} });
    assert.equal(childMcp.statusCode, 404);

    const workItemMcp = await server.inject({
      method: 'POST',
      url: '/mcp/work-session',
      headers: { accept: 'application/json, text/event-stream' },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      },
    });
    assert.equal(workItemMcp.statusCode, 200);

    const workspaceList = await server.inject({ method: 'GET', url: '/api/workspaces' });
    assert.deepEqual(workspaceList.json(), []);
    const config = await server.inject({ method: 'GET', url: '/api/config' });
    assert.equal(config.json().poll_configured, false);
    assert.equal(config.json().default_session_provider, 'claude');
    assert.equal(config.json().needs_setup, false);
    assert.equal(config.json().work_items.configured, true);
  } finally {
    await server.close();
  }
});
