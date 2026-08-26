import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { closeDb, getDb, initDb } from './db.js';
import { ensureSessionAndSend } from './dispatcher.js';
import {
  getPullRequestOwner,
  linkWorkItemPullRequest,
  listWorkItemPullRequests,
  parsePullRequestReference,
  reconcileWorkItemPullRequests,
  unlinkWorkItemPullRequest,
} from './work-item-prs.js';
import { createWorkspace } from './workspace.js';

afterEach(() => closeDb());

function insertWorkItem(id, repositories, createdAt = '2026-08-20T00:00:00.000Z') {
  getDb()
    .prepare(
      `INSERT INTO work_items (
        id, reference, title, resolved_repositories_json, path, work_provider,
        resolver_provider, state, stage, progress_current, progress_total,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'codex', 'codex', 'ready', 'complete', 0, 0, ?, ?)`,
    )
    .run(id, `PROJECT-${id}`, `Work ${id}`, JSON.stringify(repositories), `/tmp/${id}`, createdAt, createdAt);
}

function insertPullRequest(id, headOid = null, createdAt = '2026-08-22T00:00:00.000Z') {
  const [repository, numberText] = id.split('#');
  const [org, repo] = repository.split('/');
  const number = Number(numberText);
  getDb()
    .prepare(
      `INSERT INTO prs (
        id, number, title, repo, org, author, url, branch, head_oid,
        created_at, updated_at, synced_at
      ) VALUES (?, ?, ?, ?, ?, 'octocat', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      number,
      `PR ${number}`,
      repo,
      org,
      `https://github.com/${repository}/pull/${number}`,
      `feature-${number}`,
      headOid,
      createdAt,
      createdAt,
      createdAt,
    );
}

function insertChildWorkspace(id, workItemId, path) {
  const now = '2026-08-21T00:00:00.000Z';
  getDb()
    .prepare(
      `INSERT INTO workspaces (
        id, work_item_id, name, path, branch, repo, status, created_at,
        operation_state, operation_updated_at, base_commit
      ) VALUES (?, ?, ?, ?, ?, 'acme/widgets', 'active', ?, 'ready', ?, ?)`,
    )
    .run(id, workItemId, id, path, `patrol/${id}`, now, now, 'b'.repeat(64));
}

test('a work item owns multiple pull requests without requiring poller rows', async () => {
  initDb(':memory:');
  insertWorkItem('one', ['acme/widgets', 'acme/tools']);
  insertWorkItem('two', ['acme/widgets']);
  insertPullRequest('acme/tools#12');

  assert.deepEqual(parsePullRequestReference('https://github.com/acme/widgets/pull/11?notification_referrer_id=1'), {
    id: 'acme/widgets#11',
    org: 'acme',
    repo: 'widgets',
    repository: 'acme/widgets',
    number: 11,
    url: 'https://github.com/acme/widgets/pull/11',
  });

  const beforePoll = linkWorkItemPullRequest('one', 'acme/widgets#11');
  const tracked = linkWorkItemPullRequest('one', 'https://github.com/acme/tools/pull/12');
  assert.equal(beforePoll.tracked, false);
  assert.equal(tracked.tracked, true);
  assert.equal(listWorkItemPullRequests('one').length, 2);
  assert.equal(getPullRequestOwner('acme/widgets#11').id, 'one');
  assert.equal(linkWorkItemPullRequest('one', 'acme/widgets#11').id, 'acme/widgets#11');

  assert.throws(
    () => linkWorkItemPullRequest('two', 'acme/widgets#11'),
    (error) => error.code === 'pull_request_owned',
  );
  assert.throws(
    () => linkWorkItemPullRequest('one', 'acme/other#1'),
    (error) => error.code === 'repository_not_in_work_item',
  );
  await assert.rejects(createWorkspace('acme/tools#12', {}), (error) => error.code === 'pr_owned_by_work_item');

  assert.deepEqual(unlinkWorkItemPullRequest('one', 'acme/tools#12'), {
    removed: true,
    pr_id: 'acme/tools#12',
    work_item_id: 'one',
  });
  assert.ok(getDb().prepare("SELECT 1 FROM prs WHERE id = 'acme/tools#12'").get());
});

test('provenance reconciliation links only a unique immutable-history match', async () => {
  initDb(':memory:');
  insertWorkItem('one', ['acme/widgets']);
  insertWorkItem('two', ['acme/widgets']);
  insertChildWorkspace('child-one', 'one', '/tmp/one/repos/widgets');
  insertChildWorkspace('child-two', 'two', '/tmp/two/repos/widgets');
  const uniqueOid = '1'.repeat(64);
  const ambiguousOid = '2'.repeat(64);
  insertPullRequest('acme/widgets#21', uniqueOid);
  insertPullRequest('acme/widgets#22', ambiguousOid);
  const warnings = [];

  const linked = await reconcileWorkItemPullRequests(['acme/widgets#21', 'acme/widgets#22'], {
    runExec: async (_command, args, options) => {
      const oid = args[2];
      const path = options.cwd;
      const isAncestor = oid === uniqueOid ? path.includes('/one/') : oid === ambiguousOid;
      if (isAncestor) return {};
      const error = new Error('not an ancestor');
      error.code = 1;
      throw error;
    },
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.deepEqual(
    linked.map((pr) => pr.id),
    ['acme/widgets#21'],
  );
  assert.equal(getPullRequestOwner('acme/widgets#21').id, 'one');
  assert.equal(getPullRequestOwner('acme/widgets#22'), null);
  assert.match(warnings[0], /ambiguous/u);
});

test('PR dispatch resolves through the owning work item instead of a standalone workspace', async () => {
  initDb(':memory:');
  insertWorkItem('one', ['acme/widgets']);
  insertPullRequest('acme/widgets#31');
  linkWorkItemPullRequest('one', 'acme/widgets#31');
  const now = '2026-08-22T00:00:00.000Z';
  getDb()
    .prepare(
      `INSERT INTO workspaces (
        id, pr_id, name, path, branch, repo, status, created_at,
        operation_state, operation_updated_at
      ) VALUES ('legacy-pr-workspace', 'acme/widgets#31', 'legacy', '/tmp/legacy',
        'feature-31', 'acme/widgets', 'active', ?, 'ready', ?)`,
    )
    .run(now, now);
  getDb()
    .prepare(
      `INSERT INTO sessions (id, workspace_id, pid, provider, status, started_at)
       VALUES ('legacy-session', 'legacy-pr-workspace', 1, 'claude', 'detached', ?)`,
    )
    .run(now);

  await assert.rejects(
    ensureSessionAndSend({ pr_id: 'acme/widgets#31', prompt: 'inspect it' }),
    (error) => error.code === 'no_session',
  );
});
