import { emitLocalChange } from './app-events.js';
import { getDb } from './db.js';
import { formatPR } from './pr-status.js';
import { execFile } from './utils.js';

const PR_ID_PATTERN = /^([^\s/#]+)\/([^\s/#]+)#([1-9]\d*)$/u;
const COMMIT_ID_PATTERN = /^[0-9a-f]{40,64}$/iu;

function ownershipError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** @param {string} value */
export function parsePullRequestReference(value) {
  if (typeof value !== 'string') throw ownershipError('invalid_pull_request', 'Pull request must be a string');
  const trimmed = value.trim();
  let canonical = trimmed;
  if (/^https?:\/\//iu.test(trimmed)) {
    let url;
    try {
      url = new URL(trimmed);
    } catch {
      throw ownershipError('invalid_pull_request', 'Pull request URL is invalid');
    }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
      throw ownershipError('invalid_pull_request', 'Pull request URL must use https://github.com');
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 4 || parts[2] !== 'pull' || !/^[1-9]\d*$/u.test(parts[3])) {
      throw ownershipError('invalid_pull_request', 'Expected a GitHub pull request URL');
    }
    canonical = `${parts[0]}/${parts[1]}#${parts[3]}`;
  }
  const match = PR_ID_PATTERN.exec(canonical);
  if (!match) throw ownershipError('invalid_pull_request', 'Expected owner/repo#number or a GitHub pull request URL');
  const [, org, repo, number] = match;
  return {
    id: `${org}/${repo}#${number}`,
    org,
    repo,
    repository: `${org}/${repo}`,
    number: Number(number),
    url: `https://github.com/${org}/${repo}/pull/${number}`,
  };
}

function repositoriesFor(row) {
  try {
    const parsed = JSON.parse(row?.resolved_repositories_json ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function linkedPullRequest(link, row = null) {
  const parsed = parsePullRequestReference(link.pr_id);
  if (!row) {
    return {
      ...parsed,
      title: null,
      branch: null,
      base_branch: null,
      draft: false,
      mergeable: 'UNKNOWN',
      ci_status: 'pending',
      review_status: 'pending',
      updated_at: null,
      tracked: false,
      linked_at: link.linked_at,
      link_source: link.source,
    };
  }
  const pr = formatPR(row);
  return {
    id: pr.id,
    org: pr.org,
    repo: pr.repo,
    repository: `${pr.org}/${pr.repo}`,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    branch: pr.branch,
    base_branch: pr.base_branch,
    draft: pr.draft,
    mergeable: pr.mergeable,
    ci_status: pr.ci_status,
    review_status: pr.review_status,
    updated_at: pr.updated_at,
    tracked: true,
    linked_at: link.linked_at,
    link_source: link.source,
  };
}

/** @param {string} workItemId */
export function listWorkItemPullRequests(workItemId) {
  const db = getDb();
  const links = db
    .prepare(
      `SELECT l.pr_id, l.work_item_id, l.source, l.linked_at
         FROM work_item_pull_requests l
        WHERE l.work_item_id = ?
        ORDER BY l.linked_at DESC, l.pr_id`,
    )
    .all(workItemId);
  const getPr = db.prepare('SELECT * FROM prs WHERE id = ?');
  return links
    .map((link) => linkedPullRequest(link, getPr.get(link.pr_id) ?? null))
    .sort((a, b) => (b.updated_at ?? b.linked_at).localeCompare(a.updated_at ?? a.linked_at));
}

/** @param {string} prId */
export function getPullRequestOwner(prId) {
  return (
    getDb()
      .prepare(
        `SELECT wi.id, wi.reference, wi.title, wi.state, l.source, l.linked_at
           FROM work_item_pull_requests l
           JOIN work_items wi ON wi.id = l.work_item_id
          WHERE l.pr_id = ?`,
      )
      .get(prId) ?? null
  );
}

/** @param {object[]} prs */
export function enrichPullRequestsWithOwners(prs, db = getDb()) {
  const owners = new Map(
    db
      .prepare(
        `SELECT l.pr_id, wi.id, wi.reference, wi.title, wi.state, l.source, l.linked_at
           FROM work_item_pull_requests l
           JOIN work_items wi ON wi.id = l.work_item_id`,
      )
      .all()
      .map((row) => [row.pr_id, row]),
  );
  for (const pr of prs) {
    const owner = owners.get(pr.id) ?? null;
    pr.work_item_id = owner?.id ?? null;
    pr.work_item = owner ? { id: owner.id, reference: owner.reference, title: owner.title, state: owner.state } : null;
  }
  return prs;
}

export function linkWorkItemPullRequest(workItemId, pullRequest, { source = 'explicit', emit = true } = {}) {
  const db = getDb();
  const workItem = db.prepare('SELECT * FROM work_items WHERE id = ?').get(workItemId);
  if (!workItem) throw ownershipError('work_item_not_found', 'Work item not found');
  if (['destroying', 'destroyed'].includes(workItem.state)) {
    throw ownershipError('invalid_state', 'Destroyed work items cannot accept pull requests');
  }
  const parsed = parsePullRequestReference(pullRequest);
  if (!repositoriesFor(workItem).includes(parsed.repository)) {
    throw ownershipError(
      'repository_not_in_work_item',
      `Pull request repository is not part of this work item: ${parsed.repository}`,
    );
  }
  const current = db.prepare('SELECT * FROM work_item_pull_requests WHERE pr_id = ?').get(parsed.id);
  if (current?.work_item_id === workItemId)
    return linkedPullRequest(current, db.prepare('SELECT * FROM prs WHERE id = ?').get(parsed.id));
  if (current) {
    throw ownershipError(
      'pull_request_owned',
      `Pull request ${parsed.id} already belongs to work item ${current.work_item_id}`,
    );
  }
  const link = { pr_id: parsed.id, work_item_id: workItemId, source, linked_at: new Date().toISOString() };
  db.prepare('INSERT INTO work_item_pull_requests (pr_id, work_item_id, source, linked_at) VALUES (?, ?, ?, ?)').run(
    link.pr_id,
    link.work_item_id,
    link.source,
    link.linked_at,
  );
  if (emit) emitLocalChange();
  return linkedPullRequest(link, db.prepare('SELECT * FROM prs WHERE id = ?').get(parsed.id));
}

export function unlinkWorkItemPullRequest(workItemId, pullRequest) {
  const parsed = parsePullRequestReference(pullRequest);
  const db = getDb();
  const current = db.prepare('SELECT work_item_id FROM work_item_pull_requests WHERE pr_id = ?').get(parsed.id);
  if (!current) return { removed: false, pr_id: parsed.id, work_item_id: workItemId };
  if (current.work_item_id !== workItemId) {
    throw ownershipError('pull_request_owned', `Pull request ${parsed.id} belongs to another work item`);
  }
  db.prepare('DELETE FROM work_item_pull_requests WHERE pr_id = ?').run(parsed.id);
  emitLocalChange();
  return { removed: true, pr_id: parsed.id, work_item_id: workItemId };
}

/**
 * Link unowned PRs when their GitHub head is provably an ancestor of exactly
 * one work-item checkout's current commit.
 */
export async function reconcileWorkItemPullRequests(prIds, { runExec = execFile, logger = console } = {}) {
  const ids = [...new Set((prIds ?? []).filter((id) => typeof id === 'string'))];
  if (ids.length === 0) return [];
  const db = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  const prs = db
    .prepare(
      `SELECT p.id, p.org, p.repo, p.head_oid, p.created_at
         FROM prs p
         LEFT JOIN work_item_pull_requests l ON l.pr_id = p.id
        WHERE p.id IN (${placeholders})
          AND l.pr_id IS NULL
          AND p.head_oid IS NOT NULL`,
    )
    .all(...ids)
    .filter((pr) => COMMIT_ID_PATTERN.test(pr.head_oid));
  const candidates = db.prepare(
    `SELECT w.work_item_id, w.path, w.base_commit
       FROM workspaces w
       JOIN work_items wi ON wi.id = w.work_item_id
      WHERE w.repo = ?
        AND w.status = 'active'
        AND w.operation_state = 'ready'
        AND wi.state IN ('ready', 'error')
        AND wi.created_at <= ?`,
  );
  const linked = [];
  for (const pr of prs) {
    const matches = [];
    for (const candidate of candidates.all(`${pr.org}/${pr.repo}`, pr.created_at)) {
      if (candidate.base_commit === pr.head_oid) continue;
      try {
        await runExec('git', ['merge-base', '--is-ancestor', pr.head_oid, 'HEAD'], { cwd: candidate.path });
        matches.push(candidate.work_item_id);
      } catch (error) {
        // Exit code 1 means "not an ancestor" - not a provenance match. Anything
        // else (bad revision, missing checkout) is a real failure; let it propagate.
        if (error?.code !== 1) throw error;
      }
    }
    const unique = [...new Set(matches)];
    if (unique.length === 1) {
      linked.push(linkWorkItemPullRequest(unique[0], pr.id, { source: 'provenance' }));
    } else if (unique.length > 1) {
      logger.warn(`[work-items] PR provenance is ambiguous for ${pr.id}: ${unique.join(', ')}`);
    }
  }
  return linked;
}
