import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { unlinkSync } from 'node:fs';
import { emitGhRateLimit, emitLocalChange } from './app-events.js';
import { getDb } from './db.js';
import { deriveCIStatus, formatPR } from './pr-status.js';
import { SingleFlight } from './single-flight.js';
import { makePrId } from './utils.js';
import { reconcileWorkItemPullRequests } from './work-item-prs.js';
import { destroyWorkspace } from './workspace.js';

export const pollerEvents = new EventEmitter();

// Page size 50 with 30 inline check contexts. Larger inline payloads
// can 504 from GitHub's gateway. Pagination picks up the rest for PRs that
// exceed 30 checks (see CHECKS_PAGE_QUERY).
const GRAPHQL_QUERY = `
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        id
        number
        title
        body
        url
        isDraft
        headRefName
        headRefOid
        baseRefName
        isCrossRepository
        mergeable
        createdAt
        updatedAt
        author { login }
        repository { name owner { login } }
        labels(first: 10) { nodes { name color } }
        reviews(first: 50) { nodes { author { login __typename } state submittedAt } }
        comments(first: 50) { nodes { author { login __typename } createdAt } }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 30) {
                  pageInfo { hasNextPage endCursor }
                  nodes {
                    ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
                    ... on StatusContext { context state targetUrl }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

const PR_BODY_HTML_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      bodyHTML
    }
  }
}
`;

// Single-PR query used by the "force refresh" path. Mirrors the inline PR
// fragment in GRAPHQL_QUERY plus bodyHTML, so the cached html on the detail
// view stays consistent with the rest of the refreshed fields.
const SINGLE_PR_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
      title
      body
      bodyHTML
      url
      state
      isDraft
      headRefName
      headRefOid
      baseRefName
      isCrossRepository
      mergeable
      createdAt
      updatedAt
      author { login }
      repository { name owner { login } }
      labels(first: 10) { nodes { name color } }
      reviews(first: 50) { nodes { author { login __typename } state submittedAt } }
      comments(first: 50) { nodes { author { login __typename } createdAt } }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 30) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
                  ... on StatusContext { context state targetUrl }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

const CHECKS_PAGE_QUERY = `
query($id: ID!, $cursor: String!) {
  node(id: $id) {
    ... on PullRequest {
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
                  ... on StatusContext { context state targetUrl }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

// Id-only enumeration of every open PR for a role. Deliberately pulls no
// reviews/comments/checks - those heavy connections are what made a full
// search expensive, and cleanup only needs to know which tracked PRs are
// still open. Cheap enough to run every cycle so merged/closed PRs (and
// their workspaces) get torn down promptly instead of waiting for the next
// 30-minute full sweep.
const OPEN_IDS_QUERY = `
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        repository { name owner { login } }
      }
    }
  }
}
`;

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Detect rate-limit signals in gh output.
 * Matches both REST (HTTP 403 stderr text) and GraphQL (response body) patterns.
 * @param {string} text
 */
function isRateLimitMessage(text) {
  if (!text) return false;
  return (
    /API rate limit exceeded/i.test(text) ||
    /exceeded a secondary rate limit/i.test(text) ||
    /\brate limit\b.*\bexceeded\b/i.test(text) ||
    /"type"\s*:\s*"RATE_LIMITED"/.test(text)
  );
}

class RateLimitedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitedError';
    this.rateLimited = true;
  }
}

/** @type {{limited: boolean, message: string | null, detectedAt: string | null, resetAt: string | null}} */
let rateLimitState = { limited: false, message: null, detectedAt: null, resetAt: null };
let resetLookupInFlight = false;

/** Snapshot of the current gh rate-limit state. */
export function getGhRateLimitState() {
  return { ...rateLimitState };
}

function setRateLimited(rawMessage) {
  const message = (rawMessage || '').trim().slice(0, 500) || 'gh API rate limit exceeded';
  const wasLimited = rateLimitState.limited;
  rateLimitState = {
    limited: true,
    message,
    detectedAt: wasLimited ? rateLimitState.detectedAt : new Date().toISOString(),
    resetAt: rateLimitState.resetAt,
  };
  if (!wasLimited) {
    console.warn(`[poller] gh rate limit detected: ${message.slice(0, 200)}`);
    emitGhRateLimit(getGhRateLimitState());
    fetchRateLimitReset();
  }
}

function clearRateLimited() {
  if (!rateLimitState.limited) return;
  rateLimitState = { limited: false, message: null, detectedAt: null, resetAt: null };
  console.log('[poller] gh rate limit cleared');
  emitGhRateLimit(getGhRateLimitState());
}

/**
 * Best-effort fetch of `gh api rate_limit` to learn when the window resets.
 * The rate_limit endpoint is exempt from rate limiting per GitHub docs, so it
 * normally succeeds even while the user is throttled.
 */
function fetchRateLimitReset() {
  if (resetLookupInFlight) return;
  resetLookupInFlight = true;
  const child = spawn('gh', ['api', 'rate_limit'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  child.stdout.on('data', (d) => out.push(d));
  child.on('error', () => {
    resetLookupInFlight = false;
  });
  child.on('close', (code) => {
    resetLookupInFlight = false;
    if (code !== 0) return;
    try {
      const parsed = JSON.parse(Buffer.concat(out).toString());
      const buckets = parsed?.resources;
      if (!buckets) return;
      // Pick the soonest reset among buckets that are actually exhausted; fall
      // back to the soonest reset overall.
      let soonest = null;
      for (const b of Object.values(buckets)) {
        if (typeof b?.reset !== 'number') continue;
        if (b.remaining === 0 && (soonest === null || b.reset < soonest)) {
          soonest = b.reset;
        }
      }
      if (soonest === null) {
        for (const b of Object.values(buckets)) {
          if (typeof b?.reset !== 'number') continue;
          if (soonest === null || b.reset < soonest) soonest = b.reset;
        }
      }
      if (soonest !== null && rateLimitState.limited) {
        rateLimitState = { ...rateLimitState, resetAt: new Date(soonest * 1000).toISOString() };
        emitGhRateLimit(getGhRateLimitState());
      }
    } catch {
      /* ignore */
    }
  });
}

/**
 * Fetch a single PR's bodyHTML on demand. Returns the rendered HTML string,
 * or null if the call fails (e.g. rate-limited). Used by the detail route to
 * avoid pulling bodyHTML for every PR on every poll cycle.
 * @param {string} owner
 * @param {string} name
 * @param {number} number
 * @returns {Promise<string | null>}
 */
export async function fetchPRBodyHtml(owner, name, number) {
  try {
    const result = await ghGraphql(PR_BODY_HTML_QUERY, { owner, name, number });
    return result?.data?.repository?.pullRequest?.bodyHTML ?? null;
  } catch (err) {
    console.warn(`[poller] body_html fetch failed for ${owner}/${name}#${number}: ${err.message}`);
    return null;
  }
}

/**
 * Force-refresh a single PR from GitHub and upsert it into the DB. Bypasses
 * the incremental-polling cadence: the next time you ask for this PR, every
 * field reflects the live GitHub state.
 *
 * If the PR has been MERGED or CLOSED, this short-circuits to the same
 * cleanup the poller's orphan path runs: destroy active workspaces, delete
 * the row, and return `{ removed: true, state }` so the caller can react
 * (the dashboard navigates back, the MCP caller sees the terminal state).
 *
 * @param {string} prId - "org/repo#number"
 * @param {object} config - current app config, needed for workspace teardown
 * @returns {Promise<{ removed: boolean, state: 'OPEN' | 'CLOSED' | 'MERGED' }>}
 */
export async function refreshSinglePR(prId, config) {
  const match = /^(.+)\/(.+)#(\d+)$/.exec(prId);
  if (!match) throw new Error(`Invalid PR id: ${prId}`);
  const [, owner, name, numStr] = match;
  const number = Number(numStr);

  const db = getDb();
  const existing = db.prepare('SELECT id FROM prs WHERE id = ?').get(prId);
  if (!existing) throw new Error(`PR not tracked: ${prId}`);

  const result = await ghGraphql(SINGLE_PR_QUERY, { owner, name, number });
  const pr = result?.data?.repository?.pullRequest;
  if (!pr) throw new Error(`GitHub returned no pull request for ${prId}`);

  const state = pr.state || 'OPEN';
  if (state === 'MERGED' || state === 'CLOSED') {
    await cleanupStalePR(prId, config);
    db.prepare('DELETE FROM prs WHERE id = ?').run(prId);
    emitLocalChange();
    return { removed: true, state };
  }

  // Paginate the rest of the check contexts if there are more than the inline
  // page covered. Same handling as the bulk search path.
  const contextsConn = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  if (contextsConn?.pageInfo?.hasNextPage) {
    const extra = await fetchRemainingChecks(pr.id, contextsConn.pageInfo.endCursor);
    contextsConn.nodes.push(...extra);
    contextsConn.pageInfo.hasNextPage = false;
  }

  upsertPRs([pr]);
  await reconcileWorkItemPullRequests([prId]);

  // Overwrite body_html unconditionally - upsertPRs blanks it only when the
  // body text changes, but a force-refresh should also pick up rendering
  // changes (autolink updates, embedded images, etc.).
  if (pr.bodyHTML != null) {
    db.prepare('UPDATE prs SET body_html = ? WHERE id = ?').run(pr.bodyHTML, prId);
  }

  emitLocalChange();
  return { removed: false, state };
}

/**
 * Run a single gh api graphql call. Returns { stdout, stderr, code } or
 * rejects on spawn error.
 */
function ghGraphqlOnce(query, variables) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', ['api', 'graphql', '--input', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const chunks = [];
    const errChunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));

    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(chunks).toString(),
        stderr: Buffer.concat(errChunks).toString(),
        code,
      });
    });

    child.on('error', reject);
    child.stdin.end(JSON.stringify({ query, variables }));
  });
}

/**
 * Run a gh api graphql command with retry and exponential backoff.
 * Retries on non-zero exit codes and spawn errors (transient failures).
 * Does not retry on JSON parse errors (bad response, not transient).
 * @param {string} query - GraphQL query string
 * @param {Record<string, string>} variables
 * @returns {Promise<object>}
 */
async function ghGraphql(query, variables) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { stdout, stderr, code } = await ghGraphqlOnce(query, variables);

      if (code !== 0) {
        const errText = stderr || stdout;
        if (isRateLimitMessage(errText)) {
          setRateLimited(errText);
          throw new RateLimitedError(`gh rate limit exceeded: ${errText.slice(0, 200)}`);
        }
        lastError = new Error(`gh graphql failed (exit ${code}): ${errText}`);
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
          console.warn(
            `[poller] gh graphql failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms: ${errText.slice(0, 120)}`,
          );
          await sleep(delay);
          continue;
        }
        throw lastError;
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        // JSON parse error - not transient, don't retry
        throw new Error(`gh graphql returned non-JSON: ${stdout.slice(0, 200)}`);
      }

      // GraphQL primary rate limit returns HTTP 200 with errors[].type === 'RATE_LIMITED'.
      const rateLimitErr = parsed.errors?.find(
        (e) => e?.type === 'RATE_LIMITED' || isRateLimitMessage(e?.message || ''),
      );
      if (rateLimitErr) {
        setRateLimited(rateLimitErr.message || 'GraphQL rate limit exceeded');
        throw new RateLimitedError(`gh graphql rate limited: ${rateLimitErr.message || ''}`);
      }

      clearRateLimited();
      return parsed;
    } catch (err) {
      lastError = err;
      if (err instanceof RateLimitedError) throw err;
      // If it's a JSON parse error, don't retry
      if (err.message.startsWith('gh graphql returned non-JSON')) throw err;
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
        console.warn(
          `[poller] gh graphql failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms: ${err.message.slice(0, 120)}`,
        );
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

/**
 * Fetch remaining check contexts for a PR via pagination.
 * @param {string} nodeId - GitHub node ID of the PR
 * @param {string} startCursor - endCursor from the initial page
 * @returns {Promise<object[]>} additional context nodes
 */
async function fetchRemainingChecks(nodeId, startCursor) {
  const extra = [];
  let cursor = startCursor;
  let hasNext = true;

  while (hasNext) {
    const result = await ghGraphql(CHECKS_PAGE_QUERY, { id: nodeId, cursor });
    const contexts = result.data?.node?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
    if (!contexts) break;
    extra.push(...contexts.nodes);
    hasNext = contexts.pageInfo.hasNextPage;
    cursor = contexts.pageInfo.endCursor;
  }

  return extra;
}

/**
 * Fetch all open PRs for a search qualifier, handling pagination.
 * Also paginates check contexts for PRs that exceed the inline page.
 *
 * @param {string} qualifier - e.g. "org:foo" or "repo:owner/repo" or
 *   "org:a org:b repo:c/d" (multiple qualifiers are OR'd by GitHub search).
 * @param {string | null} [sinceIso] - if set, restricts the search to PRs
 *   updated at or after this ISO timestamp via `updated:>=`. Used by
 *   incremental polls to avoid refetching unchanged PRs.
 * @returns {Promise<{prs: object[]}>}
 */
async function fetchPRs(qualifier, sinceIso = null) {
  const allPRs = [];
  let cursor = null;
  let hasNext = true;

  const sinceClause = sinceIso ? ` updated:>=${sinceIso}` : '';
  while (hasNext) {
    const vars = { q: `${qualifier} is:pr is:open author:@me${sinceClause} sort:updated-desc` };
    if (cursor) vars.cursor = cursor;
    const result = await ghGraphql(GRAPHQL_QUERY, vars);
    const search = result.data?.search;
    if (!search) {
      console.warn(`[poller] Unexpected response shape for ${qualifier}:`, JSON.stringify(result).slice(0, 200));
      break;
    }
    allPRs.push(...search.nodes);

    hasNext = search.pageInfo.hasNextPage;
    cursor = search.pageInfo.endCursor;
  }

  // Paginate checks that do not fit in the inline page.
  for (const pr of allPRs) {
    const contextsConn = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
    if (contextsConn?.pageInfo?.hasNextPage) {
      const extra = await fetchRemainingChecks(pr.id, contextsConn.pageInfo.endCursor);
      contextsConn.nodes.push(...extra);
      contextsConn.pageInfo.hasNextPage = false;
    }
  }

  return { prs: allPRs };
}

/**
 * Enumerate the ids of every open authored PR. Used to drive stale cleanup
 * on incremental cycles, where the
 * heavy `updated:>=` search returns only recently-changed PRs and so can't
 * tell "merged/closed" apart from "not updated lately".
 * @param {string} qualifier
 * @returns {Promise<Array<{id: string, org: string, repo: string}>>}
 */
async function fetchOpenPRIds(qualifier) {
  const out = [];
  let cursor = null;
  let hasNext = true;
  while (hasNext) {
    const vars = { q: `${qualifier} is:pr is:open author:@me` };
    if (cursor) vars.cursor = cursor;
    const result = await ghGraphql(OPEN_IDS_QUERY, vars);
    const search = result.data?.search;
    if (!search) break;
    for (const n of search.nodes) {
      if (n?.number == null) continue;
      const org = n.repository.owner.login;
      const repo = n.repository.name;
      out.push({ id: makePrId(org, repo, n.number), org, repo });
    }
    hasNext = search.pageInfo.hasNextPage;
    cursor = search.pageInfo.endCursor;
  }
  return out;
}

/**
 * Extract check runs from a PR node.
 * @param {object} pr
 * @returns {Array<{name: string, status: string, conclusion: string | null, url: string | null}>}
 */
function extractChecks(pr) {
  const commitNode = pr.commits?.nodes?.[0]?.commit;
  const contexts = commitNode?.statusCheckRollup?.contexts?.nodes ?? [];
  return contexts.map((ctx) => {
    if ('name' in ctx) {
      const workflow = ctx.checkSuite?.workflowRun?.workflow?.name;
      const fullName = workflow ? `${workflow} / ${ctx.name}` : ctx.name;
      return { name: fullName, status: ctx.status, conclusion: ctx.conclusion, url: ctx.detailsUrl };
    }
    return { name: ctx.context, status: ctx.state, conclusion: null, url: ctx.targetUrl };
  });
}

/**
 * Extract reviews from a PR node.
 * @param {object} pr
 * @returns {Array<{reviewer: string, state: string, submitted_at: string}>}
 */
function extractReviews(pr) {
  return (pr.reviews?.nodes ?? []).map((r) => ({
    reviewer: r.author?.login ?? 'unknown',
    reviewer_type: r.author?.__typename ?? 'User',
    state: r.state,
    submitted_at: r.submittedAt,
  }));
}

/**
 * Extract issue comments from a PR node.
 * @param {object} pr
 * @returns {Array<{author: string, author_type: string, created_at: string}>}
 */
function extractComments(pr) {
  return (pr.comments?.nodes ?? []).map((c) => ({
    author: c.author?.login ?? 'unknown',
    author_type: c.author?.__typename ?? 'User',
    created_at: c.createdAt,
  }));
}

/**
 * Extract labels from a PR node.
 * @param {object} pr
 * @returns {Array<{name: string, color: string}>}
 */
function extractLabels(pr) {
  return (pr.labels?.nodes ?? []).map((l) => ({ name: l.name, color: l.color }));
}

/** @type {import('node:sqlite').StatementSync | null} */
let upsertStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let findStaleByOrgStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let findStaleByRepoStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let deletePrStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let getExistingBodyStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let getExistingPrevStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let getPrByIdStmt = null;

/**
 * Get or create cached prepared statements.
 */
function getStatements() {
  const db = getDb();
  if (!upsertStmt) {
    upsertStmt = db.prepare(`
      INSERT OR REPLACE INTO prs (id, number, title, body, body_html, repo, org, author, url, branch, head_oid, base_branch, is_fork, draft, mergeable, checks, reviews, labels, comments, created_at, updated_at, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }
  if (!findStaleByOrgStmt) {
    findStaleByOrgStmt = db.prepare('SELECT id FROM prs WHERE org = ? AND id NOT IN (SELECT value FROM json_each(?))');
  }
  if (!findStaleByRepoStmt) {
    findStaleByRepoStmt = db.prepare(
      'SELECT id FROM prs WHERE org = ? AND repo = ? AND id NOT IN (SELECT value FROM json_each(?))',
    );
  }
  if (!deletePrStmt) {
    deletePrStmt = db.prepare('DELETE FROM prs WHERE id = ?');
  }
  if (!getExistingBodyStmt) {
    getExistingBodyStmt = db.prepare('SELECT body, body_html FROM prs WHERE id = ?');
  }
  if (!getExistingPrevStmt) {
    getExistingPrevStmt = db.prepare('SELECT checks, mergeable, labels, draft FROM prs WHERE id = ?');
  }
  if (!getPrByIdStmt) {
    getPrByIdStmt = db.prepare('SELECT * FROM prs WHERE id = ?');
  }
  return {
    upsert: upsertStmt,
    findStaleByOrg: findStaleByOrgStmt,
    findStaleByRepo: findStaleByRepoStmt,
    deletePr: deletePrStmt,
    getExistingBody: getExistingBodyStmt,
    getExistingPrev: getExistingPrevStmt,
    getPrById: getPrByIdStmt,
  };
}

/**
 * Compute the diff between a previous DB row and the new GraphQL PR node for
 * the watched fields. Returns `null` if nothing in the watched set changed or
 * if there is no previous row (a brand-new PR is initial state, not a transition).
 * @param {object | undefined} prev - raw row from `prs` (with `checks`, `mergeable`, `labels`, `draft`) or undefined
 * @param {object} next - GraphQL PR node
 * @returns {object | null}
 */
function computeChanges(prev, next) {
  if (!prev) return null;
  const changes = {};

  const prevCi = deriveCIStatus(JSON.parse(prev.checks));
  const nextCi = deriveCIStatus(extractChecks(next));
  if (prevCi !== nextCi) changes.ci_status = { from: prevCi, to: nextCi };

  const nextMergeable = next.mergeable || 'UNKNOWN';
  if (prev.mergeable !== nextMergeable) changes.mergeable = { from: prev.mergeable, to: nextMergeable };

  const nextDraft = next.isDraft ? 1 : 0;
  if (prev.draft !== nextDraft) changes.draft = { from: !!prev.draft, to: !!next.isDraft };

  const prevLabels = new Set(JSON.parse(prev.labels).map((l) => l.name));
  const nextLabels = new Set(extractLabels(next).map((l) => l.name));
  const added = [...nextLabels].filter((l) => !prevLabels.has(l));
  const removed = [...prevLabels].filter((l) => !nextLabels.has(l));
  if (added.length || removed.length) changes.labels = { added, removed };

  return Object.keys(changes).length ? changes : null;
}

/**
 * Destroy workspaces and clean up DB rows for a stale PR.
 * @param {string} prId
 * @param {object} config
 */
async function cleanupStalePR(prId, config) {
  const db = getDb();
  const workspaces = db.prepare('SELECT id FROM workspaces WHERE pr_id = ?').all(prId);
  for (const ws of workspaces) {
    try {
      const result = await destroyWorkspace(ws.id, config);
      if (!result.ok) {
        throw new Error(result.warnings.join('; ') || 'workspace cleanup was incomplete');
      }
    } catch (err) {
      console.warn(`[poller] Failed to destroy workspace ${ws.id} for stale PR ${prId}: ${err.message}`);
      throw err;
    }
  }

  // A successful destroy detaches the PR foreign key so stale-PR deletion
  // cannot be blocked. Retain the initial ids so their archived sessions and
  // historical rows can still be removed after every external cleanup step
  // has succeeded.
  for (const workspace of workspaces) {
    const sessionsToDelete = db
      .prepare('SELECT transcript_path FROM sessions WHERE workspace_id = ?')
      .all(workspace.id);
    for (const session of sessionsToDelete) {
      if (session.transcript_path) {
        try {
          unlinkSync(session.transcript_path);
        } catch {
          /* best effort */
        }
      }
    }
    db.prepare('DELETE FROM sessions WHERE workspace_id = ?').run(workspace.id);
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspace.id);
  }
}

/**
 * Upsert authored PRs into the database.
 * @param {object[]} prs raw PR nodes from GraphQL
 */
function upsertPRs(prs) {
  const db = getDb();
  const now = new Date().toISOString();
  const { upsert, getExistingBody, getExistingPrev, getPrById } = getStatements();
  /** @type {Array<{id: string, prev: object, changes: object}>} */
  const pendingDiffs = [];

  db.exec('BEGIN');
  try {
    for (const pr of prs) {
      const prOrg = pr.repository.owner.login;
      const repo = pr.repository.name;
      const id = makePrId(prOrg, repo, pr.number);
      const newBody = pr.body || '';

      // Check if body changed (new PR or updated description)
      const existing = getExistingBody.get(id);
      const bodyChanged = !existing || existing.body !== newBody;

      // Capture prev row for transition detection. SELECT inside the
      // transaction to avoid any concurrent-write race (poller is
      // single-threaded today, but the cost is negligible).
      const prev = getExistingPrev.get(id);

      // body_html isn't fetched in the poll cycle (it's heavy and only used on
      // the detail view). Reuse any cached html as long as the body hasn't
      // changed; otherwise blank it so the detail route refetches it lazily.
      const newBodyHtml = bodyChanged ? '' : (existing?.body_html ?? '');

      upsert.run(
        id,
        pr.number,
        pr.title,
        newBody,
        newBodyHtml,
        repo,
        prOrg,
        pr.author?.login ?? 'unknown',
        pr.url,
        pr.headRefName,
        pr.headRefOid ?? null,
        pr.baseRefName || 'main',
        pr.isCrossRepository ? 1 : 0,
        pr.isDraft ? 1 : 0,
        pr.mergeable || 'UNKNOWN',
        JSON.stringify(extractChecks(pr)),
        JSON.stringify(extractReviews(pr)),
        JSON.stringify(extractLabels(pr)),
        JSON.stringify(extractComments(pr)),
        pr.createdAt,
        pr.updatedAt,
        now,
      );

      const changes = computeChanges(prev, pr);
      if (changes) pendingDiffs.push({ id, prev, changes });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Emit pr-changed events only after the transaction has committed - if the
  // upsert rolled back, downstream consumers must not see transitions for
  // changes that didn't persist. Re-read each changed row and run it through
  // formatPR so consumers (notably the rules engine) get derived fields and
  // a flat label-name array directly.
  for (const { id, prev, changes } of pendingDiffs) {
    const row = getPrById.get(id);
    if (!row) continue;
    pollerEvents.emit('pr-changed', { pr: formatPR(row), prev, changes });
  }
}

/**
 * Destroy workspaces and delete PRs in a configured scope that are no longer
 * present in GitHub's complete authored-open set.
 * @param {'org' | 'repo'} scope
 * @param {string} org
 * @param {string | null} repo
 * @param {string[]} seenIds
 */
async function cleanupStaleScope(scope, org, repo, seenIds, config) {
  const { findStaleByOrg, findStaleByRepo, deletePr } = getStatements();
  const seenJson = JSON.stringify(seenIds);
  const stale = scope === 'org' ? findStaleByOrg.all(org, seenJson) : findStaleByRepo.all(org, repo, seenJson);
  for (const row of stale) {
    await cleanupStalePR(row.id, config);
    deletePr.run(row.id);
  }
}

// The heavy data fetch (`updated:>=<since>`, with reviews/comments/checks)
// is incremental most cycles and only promotes to a full enumeration every
// FULL_SWEEP_INTERVAL_MS. That incremental fetch is the single biggest knob
// on GraphQL point usage. Cleanup of merged/closed PRs no longer waits for
// that full sweep: every cycle also runs the cheap id-only OPEN_IDS_QUERY
// enumeration, which gives a complete open set for stale cleanup. A heavy full sweep is only about
// refreshing data on PRs whose `updatedAt` didn't move (e.g. CI finishing).
const FULL_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
// Overlap window so a PR updated right before/after the previous fetch
// boundary doesn't get skipped because of clock skew or in-flight time.
const INCREMENTAL_BUFFER_MS = 10 * 60 * 1000;
let lastFullSweepAt = null;
let lastSweepAt = null;

/**
 * Decide whether this cycle should do a full sweep.
 */
function shouldFullSweep() {
  return lastFullSweepAt === null || Date.now() - lastFullSweepAt >= FULL_SWEEP_INTERVAL_MS;
}

/**
 * Build the `updated:>=<iso>` filter for an incremental fetch. Returns null
 * when the caller is doing a full sweep, or when we've never swept this
 * before (the first cycle has to fetch everything).
 * @param {boolean} fullSweep
 */
function buildSinceFilter(fullSweep) {
  if (fullSweep) return null;
  if (lastSweepAt === null) return null;
  return new Date(lastSweepAt - INCREMENTAL_BUFFER_MS).toISOString();
}

function recordSync({ syncedAt, sweepStartedAt, fullSweep }) {
  getDb()
    .prepare(
      `UPDATE sync_state
          SET synced_at = ?,
              last_sweep_at = ?,
              last_full_sweep_at = COALESCE(?, last_full_sweep_at)
        WHERE id = 1`,
    )
    .run(syncedAt, new Date(sweepStartedAt).toISOString(), fullSweep ? new Date(sweepStartedAt).toISOString() : null);
}

/**
 * Run a single poll cycle across all configured targets.
 * The heavy data fetch is incremental most cycles; a full sweep runs every
 * FULL_SWEEP_INTERVAL_MS. Cleanup of merged/closed PRs runs every cycle off
 * a cheap id-only enumeration regardless of full-sweep cadence.
 * @param {object} config
 * @param {{force?: boolean}} [options] - `force` makes this a full sweep.
 *   Used by the manual "Sync now" button so it always returns authoritative,
 *   fully cleaned-up state.
 */
async function pollOnce(config, { force = false } = {}) {
  // Skip the cycle entirely if gh is rate-limited and we know when it resets.
  // Without a known reset time we still try, so we can detect recovery and
  // re-fetch the reset window. The first failed call will re-flag us as limited.
  const rl = getGhRateLimitState();
  if (rl.limited && rl.resetAt && Date.parse(rl.resetAt) > Date.now()) {
    console.log(`[poller] Skipping poll - gh rate-limited until ${rl.resetAt}`);
    return;
  }

  const orgs = config.poll.orgs;
  const orgSet = new Set(orgs);
  // Drop repos already covered by an org-level scan
  const repos = config.poll.repos.filter((r) => !orgSet.has(r.split('/')[0]));

  if (orgs.length === 0 && repos.length === 0) {
    pollerEvents.emit('sync', { synced_at: new Date().toISOString(), pr_count: 0 });
    return;
  }

  // Combine all configured targets into a single search. GitHub search OR's
  // multiple `org:` / `repo:` qualifiers, so one call covers everything.
  const qualifier = [...orgs.map((o) => `org:${o}`), ...repos.map((r) => `repo:${r}`)].join(' ');

  const fullSweep = force || shouldFullSweep();
  const since = buildSinceFilter(fullSweep);
  // On incremental cycles the heavy fetch only sees recently-updated PRs, so
  // we need a separate complete open-set to clean up against. On full cycles
  // the heavy fetch already enumerates everything, so we reuse it and skip
  // the extra request.
  const needLightSweep = !fullSweep;
  const sweepStartedAt = Date.now();
  let result;
  let lightIds;
  try {
    [result, lightIds] = await Promise.all([
      fetchPRs(qualifier, since),
      needLightSweep ? fetchOpenPRIds(qualifier) : Promise.resolve(null),
    ]);
  } catch (err) {
    throw new Error(`GitHub refresh failed: ${err.message}`, { cause: err });
  }

  // Record sweep timestamps only after the fetches succeed. A failed fetch
  // doesn't advance the incremental cursor, so the next cycle replays the
  // same window rather than silently dropping the PRs from this one.
  lastSweepAt = sweepStartedAt;
  if (fullSweep) lastFullSweepAt = sweepStartedAt;

  upsertPRs(result.prs);
  await reconcileWorkItemPullRequests(
    result.prs.map((pr) => makePrId(pr.repository.owner.login, pr.repository.name, pr.number)),
  );

  // Build the complete open set for stale cleanup. On full
  // cycles the heavy result already lists every open PR; on incremental
  // cycles we use the cheap id-only enumeration fetched above. Either way
  // these sets are authoritative, so cleanup can run every cycle.
  const openPrs = fullSweep
    ? result.prs.map((pr) => ({
        id: makePrId(pr.repository.owner.login, pr.repository.name, pr.number),
        org: pr.repository.owner.login,
        repo: pr.repository.name,
      }))
    : lightIds || [];

  const bucketize = (openList) => {
    const byOrg = new Map();
    const byRepo = new Map();
    for (const { id, org, repo } of openList) {
      if (orgSet.has(org)) {
        if (!byOrg.has(org)) byOrg.set(org, []);
        byOrg.get(org).push(id);
      } else {
        const key = `${org}/${repo}`;
        if (!byRepo.has(key)) byRepo.set(key, []);
        byRepo.get(key).push(id);
      }
    }
    return { byOrg, byRepo };
  };
  const seen = bucketize(openPrs);

  try {
    for (const org of orgs) {
      await cleanupStaleScope('org', org, null, seen.byOrg.get(org) || [], config);
    }
    for (const ownerRepo of repos) {
      const [owner, repo] = ownerRepo.split('/');
      await cleanupStaleScope('repo', owner, repo, seen.byRepo.get(ownerRepo) || [], config);
    }
  } catch (err) {
    console.error(`[poller] Stale PR cleanup failed: ${err.message}`);
  }

  const mode = fullSweep ? 'full' : 'incremental';
  console.log(`[poller] Sync complete - ${result.prs.length} authored PRs [${mode}] across ${qualifier}`);

  // Adopt scratch workspaces whose branch matches a newly-synced PR
  adoptScratchWorkspaces();

  const syncedAt = new Date().toISOString();
  recordSync({ syncedAt, sweepStartedAt, fullSweep });

  pollerEvents.emit('sync', {
    synced_at: syncedAt,
    pr_count: result.prs.length,
  });
}

/** @type {import('node:sqlite').StatementSync | null} */
let findScratchesStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let findPrByBranchStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let findPrByBranchSuffixStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let adoptWorkspaceStmt = null;

/**
 * Adopt scratch workspaces that match newly-synced PRs.
 * A scratch workspace is adopted when its branch matches a PR's branch
 * and its repo column matches the PR's org/repo. Also handles prefix
 * mismatches (e.g. branch "my-branch" matches PR branch "user/my-branch").
 */
function adoptScratchWorkspaces() {
  const db = getDb();
  if (!findScratchesStmt) {
    findScratchesStmt = db.prepare(
      "SELECT * FROM workspaces WHERE pr_id IS NULL AND work_item_id IS NULL AND status = 'active' AND operation_state = 'ready'",
    );
    findPrByBranchStmt = db.prepare('SELECT id FROM prs WHERE org = ? AND repo = ? AND branch = ?');
    findPrByBranchSuffixStmt = db.prepare("SELECT id FROM prs WHERE org = ? AND repo = ? AND branch LIKE '%/' || ?");
    adoptWorkspaceStmt = db.prepare('UPDATE workspaces SET pr_id = ?, repo = NULL WHERE id = ?');
  }
  const scratches = findScratchesStmt.all();
  if (scratches.length === 0) return;

  let adopted = 0;
  for (const ws of scratches) {
    if (!ws.repo) continue;
    const [org, repo] = ws.repo.split('/');
    // Exact match first, then suffix match (handles user/ prefixes on branches)
    const pr = findPrByBranchStmt.get(org, repo, ws.branch) || findPrByBranchSuffixStmt.get(org, repo, ws.branch);
    if (pr) {
      adoptWorkspaceStmt.run(pr.id, ws.id);
      adopted++;
      console.log(`[poller] Adopted workspace ${ws.name} for PR ${pr.id}`);
    } else {
      console.log(`[poller] No PR match for scratch workspace ${ws.name} (repo=${ws.repo}, branch=${ws.branch})`);
    }
  }
  if (adopted > 0) {
    emitLocalChange();
  }
}

/**
 * Remove PRs from the DB that belong to orgs/repos no longer in the config.
 * Runs when targets change to avoid stale data from removed targets.
 * @param {object} config
 */
async function cleanupRemovedTargets(config) {
  const db = getDb();
  const orgSet = new Set(config.poll.orgs);
  const repoSet = new Set(config.poll.repos);

  // Find all distinct org/repo combos in the DB
  const dbEntries = db.prepare('SELECT DISTINCT org, repo FROM prs').all();
  for (const { org, repo } of dbEntries) {
    const fullRepo = `${org}/${repo}`;
    // Keep if the org is polled, or the specific repo is polled
    if (orgSet.has(org) || repoSet.has(fullRepo)) continue;

    // This org/repo combo is no longer monitored - clean it up
    const staleRows = db.prepare('SELECT id FROM prs WHERE org = ? AND repo = ?').all(org, repo);
    for (const row of staleRows) {
      await cleanupStalePR(row.id, config);
    }
    db.prepare('DELETE FROM prs WHERE org = ? AND repo = ?').run(org, repo);
    console.log(`[poller] Cleaned up ${staleRows.length} stale PR(s) from ${fullRepo} (no longer monitored)`);
  }
}

/** @type {ReturnType<typeof setInterval> | null} */
let intervalHandle = null;
let lastTargetsKey = null;

const pollFlight = new SingleFlight({
  merge: (previous, next) => ({
    config: next.config,
    force: previous.force || next.force,
    resetSweeps: previous.resetSweeps || next.resetSweeps,
    cleanupTargets: previous.cleanupTargets || next.cleanupTargets,
  }),
  run: async ({ config, force, resetSweeps, cleanupTargets }) => {
    if (resetSweeps) {
      lastFullSweepAt = null;
      lastSweepAt = null;
    }
    if (cleanupTargets) await cleanupRemovedTargets(config);
    return pollOnce(config, { force });
  },
});

function schedulePoll(config, options = {}) {
  return pollFlight.request({
    config,
    force: options.force ?? false,
    resetSweeps: options.resetSweeps ?? false,
    cleanupTargets: options.cleanupTargets ?? false,
  });
}

/**
 * Start the polling loop.
 * @param {object} config
 */
export function startPoller(config) {
  stopPoller();
  const targetsKey = [...config.poll.orgs.map((o) => `org:${o}`), ...config.poll.repos.map((r) => `repo:${r}`)]
    .sort()
    .join(',');
  const targets = targetsKey.replace(/,/g, ', ');
  console.log(`[poller] Starting - polling ${targets} every ${config.poll.interval_seconds}s`);

  // Only poll immediately if the targets changed (or first start).
  // Force the next cycle to be a full sweep so a newly-added org/repo
  // pulls in all its open PRs instead of just the last few minutes of
  // updates.
  const targetsChanged = targetsKey !== lastTargetsKey;
  lastTargetsKey = targetsKey;
  if (targetsChanged) {
    schedulePoll(config, { resetSweeps: true, cleanupTargets: true }).catch((err) =>
      console.error(`[poller] Poll failed: ${err.message}`),
    );
  }
  intervalHandle = setInterval(
    () => schedulePoll(config).catch((err) => console.error(`[poller] Poll failed: ${err.message}`)),
    config.poll.interval_seconds * 1000,
  );
}

/**
 * Stop the polling loop.
 */
export function stopPoller({ drain = false } = {}) {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  return drain ? pollFlight.whenIdle() : undefined;
}

/**
 * Trigger an immediate poll with the given config. This is the manual
 * "Sync now" path, so it forces a full sweep and cleanup. The user expects
 * authoritative state, with merged/closed PRs gone.
 * @param {object} config
 * @returns {Promise<void>}
 */
export function triggerPoll(config) {
  return schedulePoll(config, { force: true });
}

/** Remove rows for targets that are no longer configured without starting an interval. */
export function reconcilePollTargets(config) {
  return schedulePoll(config, { resetSweeps: true, cleanupTargets: true });
}

export function getPollerStatus() {
  return { active: pollFlight.active, pending: pollFlight.pending };
}

/**
 * Reset cached prepared statements (needed if db is re-initialized).
 */
export function resetStatements() {
  upsertStmt = null;
  findStaleByOrgStmt = null;
  findStaleByRepoStmt = null;
  deletePrStmt = null;
  getExistingBodyStmt = null;
  getExistingPrevStmt = null;
  getPrByIdStmt = null;
  findScratchesStmt = null;
  findPrByBranchStmt = null;
  findPrByBranchSuffixStmt = null;
  adoptWorkspaceStmt = null;
}
