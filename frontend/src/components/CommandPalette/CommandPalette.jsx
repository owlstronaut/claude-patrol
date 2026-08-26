import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { StatusBadge } from '../StatusBadge/StatusBadge.jsx';
import { Badge } from '../ui/Badge/Badge.jsx';
import { SessionStateBadge } from '../ui/SessionStateBadge/SessionStateBadge.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './CommandPalette.module.css';

/** @typedef {'working' | 'idle'} SessionState */
/** @typedef {{match: boolean, score: number}} MatchResult */
/** @typedef {MatchResult & {type: 'pr', item: import('../../types').PullRequest}} PullRequestEntry */
/** @typedef {MatchResult & {type: 'workspace', item: import('../../types').Workspace}} WorkspaceEntry */
/** @typedef {MatchResult & {type: 'work_item', item: import('../../types').WorkItemListItem}} WorkItemEntry */
/** @typedef {MatchResult & {type: 'global', item: import('../../types').Session}} GlobalEntry */
/** @typedef {PullRequestEntry | WorkspaceEntry | WorkItemEntry | GlobalEntry} PaletteEntry */

/**
 * @param {string} query
 * @param {import('../../types').PullRequest} pr
 * @returns {MatchResult}
 */
function fuzzyMatchPR(query, pr) {
  if (!query) return { match: true, score: 0 };
  const primary = `${pr.title} ${pr.org}/${pr.repo} #${pr.number} ${pr.branch}`.toLowerCase();
  const body = (pr.body || '').toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

  let score = 0;
  for (const token of tokens) {
    const inPrimary = primary.includes(token);
    const inBody = body.includes(token);
    if (!inPrimary && !inBody) return { match: false, score: 0 };
    score += inPrimary ? 2 : 1;
  }
  return { match: true, score };
}

/**
 * @param {string} query
 * @param {import('../../types').Workspace} ws
 * @returns {MatchResult}
 */
function fuzzyMatchWorkspace(query, ws) {
  if (!query) return { match: true, score: 0 };
  const haystack = `${ws.bookmark} ${ws.repo || ''} scratch workspace`.toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

  let score = 0;
  for (const token of tokens) {
    if (!haystack.includes(token)) return { match: false, score: 0 };
    score += 1;
  }
  return { match: true, score };
}

/** @param {string} query @param {import('../../types').WorkItemListItem} item @returns {MatchResult} */
function fuzzyMatchWorkItem(query, item) {
  if (!query) return { match: true, score: 0 };
  const pullRequests = item.pull_requests.map((pr) => `${pr.id} ${pr.title || ''} ${pr.branch || ''}`).join(' ');
  const haystack =
    `${item.title || ''} ${item.reference} ${item.repositories.join(' ')} ${pullRequests} work item`.toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (!haystack.includes(token)) return { match: false, score: 0 };
  }
  return { match: true, score: tokens.length };
}

/**
 * @param {{
 *   prs: import('../../types').PullRequest[],
 *   workItems: import('../../types').WorkItemListItem[],
 *   scratchWorkspaces: import('../../types').Workspace[],
 *   workspaceStates?: Map<string, SessionState>,
 *   dismissedIdle?: Set<string>,
 *   globalSessions: import('../../types').Session[],
 *   onNavigate: (prId: string) => void,
 *   onNavigateWorkspace: (workspaceId: string) => void,
 *   onNavigateWorkItem: (workItemId: string) => void,
 *   onOpenGlobalTerminal: (sessionId?: string) => void,
 *   onCloseGlobalTerminal?: () => void,
 * }} props
 */
export function CommandPalette({
  prs,
  workItems,
  scratchWorkspaces,
  workspaceStates,
  dismissedIdle,
  globalSessions,
  onNavigate,
  onNavigateWorkspace,
  onNavigateWorkItem,
  onOpenGlobalTerminal,
  onCloseGlobalTerminal,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dialogRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const inputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const resultsRef = useRef(/** @type {HTMLDivElement | null} */ (null));

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setSelectedIndex(0);
  }, []);

  // Global Cmd+K / Ctrl+K listener
  useEffect(() => {
    /** @param {KeyboardEvent} e */
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => {
          if (prev) {
            setQuery('');
            setSelectedIndex(0);
            return false;
          }
          return true;
        });
      }
    };
    const openPalette = () => setOpen(true);
    document.addEventListener('keydown', handler);
    document.addEventListener('claude-patrol:open-command-palette', openPalette);
    return () => {
      document.removeEventListener('keydown', handler);
      document.removeEventListener('claude-patrol:open-command-palette', openPalette);
    };
  }, []);

  // Autofocus input when opened
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEscapeKey(open, close);
  useClickOutside(dialogRef, open ? close : () => {});

  const filtered = useMemo(() => {
    const standalonePRs = prs.filter((pr) => !pr.work_item_id);
    /** @type {PullRequestEntry[]} */
    const prItems = query
      ? standalonePRs
          .map((pr) => ({ ...fuzzyMatchPR(query, pr), type: /** @type {'pr'} */ ('pr'), item: pr }))
          .filter((r) => r.match)
      : standalonePRs.map((pr) => ({ match: true, score: 0, type: /** @type {'pr'} */ ('pr'), item: pr }));

    /** @type {WorkspaceEntry[]} */
    const wsItems =
      (scratchWorkspaces || []).length > 0
        ? query
          ? (scratchWorkspaces || [])
              .map((ws) => ({
                ...fuzzyMatchWorkspace(query, ws),
                type: /** @type {'workspace'} */ ('workspace'),
                item: ws,
              }))
              .filter((r) => r.match)
          : (scratchWorkspaces || []).map((ws) => ({
              match: true,
              score: 0,
              type: /** @type {'workspace'} */ ('workspace'),
              item: ws,
            }))
        : [];

    /** @type {WorkItemEntry[]} */
    const workItemItems = workItems
      .map((item) => ({ ...fuzzyMatchWorkItem(query, item), type: /** @type {'work_item'} */ ('work_item'), item }))
      .filter((entry) => entry.match);

    const globalTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    /** @type {GlobalEntry[]} */
    const globalItems = globalSessions
      .map((session) => {
        const haystack = `${session.name || ''} global terminal ${session.provider}`.toLowerCase();
        const match = globalTokens.every((token) => haystack.includes(token));
        return {
          match,
          score: match ? globalTokens.length : 0,
          type: /** @type {'global'} */ ('global'),
          item: session,
        };
      })
      .filter((entry) => entry.match);

    const all = [...prItems, ...workItemItems, ...wsItems, ...globalItems];

    // Boost items with active sessions to top (idle first, then working), then sort by score
    /** @param {PaletteEntry} entry */
    const sessionPriority = (entry) => {
      if (!workspaceStates?.size) return 0;
      const targetKey =
        entry.type === 'work_item'
          ? `work-item:${entry.item.id}`
          : entry.type === 'workspace'
            ? `workspace:${entry.item.id}`
            : entry.type === 'pr' && entry.item.workspace_id
              ? `workspace:${entry.item.workspace_id}`
              : null;
      if (!targetKey) return 0;
      const state = workspaceStates.get(targetKey);
      if (state === 'idle') return 2;
      if (state === 'working') return 1;
      return 0;
    };

    return all.sort((a, b) => {
      const aPri = sessionPriority(a);
      const bPri = sessionPriority(b);
      if (aPri !== bPri) return bPri - aPri;
      return b.score - a.score;
    });
  }, [prs, workItems, scratchWorkspaces, workspaceStates, globalSessions, query]);

  const activeIndex = Math.min(selectedIndex, Math.max(filtered.length - 1, 0));

  // Scroll selected item into view
  useEffect(() => {
    if (!resultsRef.current) return;
    const selected = resultsRef.current.children[activeIndex];
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const handleSelect = useCallback(
    /** @param {PaletteEntry} entry */
    (entry) => {
      if (entry.type === 'global') {
        onOpenGlobalTerminal(entry.item.id);
      } else {
        onCloseGlobalTerminal?.();
        if (entry.type === 'pr') {
          onNavigate(entry.item.id);
        } else if (entry.type === 'work_item') {
          onNavigateWorkItem(entry.item.id);
        } else {
          onNavigateWorkspace(entry.item.id);
        }
      }
      close();
    },
    [onNavigate, onNavigateWorkspace, onNavigateWorkItem, onOpenGlobalTerminal, onCloseGlobalTerminal, close],
  );

  /** @param {import('react').KeyboardEvent<HTMLDivElement>} e */
  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(Math.min(activeIndex + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(Math.max(activeIndex - 1, 0));
    } else if (e.key === 'Enter' && filtered[activeIndex]) {
      e.preventDefault();
      handleSelect(filtered[activeIndex]);
    }
  };

  if (!open) return null;

  return (
    <div className={styles.overlay} onKeyDown={handleKeyDown}>
      <div className={styles.dialog} ref={dialogRef}>
        <div className={styles.inputWrapper}>
          <svg
            className={styles.searchIcon}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            placeholder="Search PRs, work items, and workspaces..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
          />
          <span className={styles.hint}>esc</span>
        </div>
        <div className={styles.results} ref={resultsRef}>
          {filtered.length === 0 ? (
            <div className={styles.empty}>No results</div>
          ) : (
            filtered.map((entry, i) => (
              <div
                key={
                  entry.type === 'pr'
                    ? entry.item.id
                    : entry.type === 'global'
                      ? `global-${entry.item.id}`
                      : `${entry.type}-${entry.item.id}`
                }
                className={`${styles.result} ${i === activeIndex ? styles.resultSelected : ''}`}
                onClick={() => handleSelect(entry)}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                {entry.type === 'pr' ? (
                  <PRResult
                    pr={entry.item}
                    sessionState={
                      entry.item.workspace_id ? workspaceStates?.get(`workspace:${entry.item.workspace_id}`) : undefined
                    }
                    dismissed={
                      entry.item.workspace_id ? dismissedIdle?.has(`workspace:${entry.item.workspace_id}`) : false
                    }
                  />
                ) : entry.type === 'global' ? (
                  <GlobalResult session={entry.item} />
                ) : entry.type === 'work_item' ? (
                  <WorkItemResult
                    item={entry.item}
                    sessionState={workspaceStates?.get(`work-item:${entry.item.id}`)}
                    dismissed={dismissedIdle?.has(`work-item:${entry.item.id}`)}
                  />
                ) : (
                  <WorkspaceResult
                    ws={entry.item}
                    sessionState={workspaceStates?.get(`workspace:${entry.item.id}`)}
                    dismissed={dismissedIdle?.has(`workspace:${entry.item.id}`)}
                  />
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** @param {{pr: import('../../types').PullRequest, sessionState?: SessionState, dismissed?: boolean}} props */
function PRResult({ pr, sessionState, dismissed }) {
  return (
    <Stack direction="col" gap={1} className={styles.resultInfo}>
      <div className={styles.resultTitle}>{pr.title}</div>
      <Stack gap={2} className={styles.resultMeta}>
        <span className={styles.resultRepo}>
          {pr.org}/{pr.repo}
        </span>
        <span className={styles.resultNumber}>#{pr.number}</span>
        <span className={styles.resultBranch}>{pr.branch}</span>
      </Stack>
      <Stack gap={1} className={styles.resultBadges}>
        <StatusBadge status={pr.ci_status} type="ci" />
        <StatusBadge status={pr.review_status} type="review" />
        {pr.mergeable === 'CONFLICTING' && <StatusBadge status={pr.mergeable} type="merge" />}
        {pr.draft && <Badge color="yellow">Draft</Badge>}
        <SessionStateBadge state={sessionState} dismissed={dismissed} />
      </Stack>
    </Stack>
  );
}

/** @param {{session: import('../../types').Session}} props */
function GlobalResult({ session }) {
  return (
    <Stack direction="col" gap={1} className={styles.resultInfo}>
      <div className={styles.resultTitle}>{session.name || 'Global session'}</div>
      <Stack gap={1} className={styles.resultBadges}>
        <Badge color="green">{session.status === 'detached' ? 'detached' : `active ${session.provider}`} session</Badge>
      </Stack>
    </Stack>
  );
}

/** @param {{ws: import('../../types').Workspace, sessionState?: SessionState, dismissed?: boolean}} props */
function WorkspaceResult({ ws, sessionState, dismissed }) {
  return (
    <Stack direction="col" gap={1} className={styles.resultInfo}>
      <div className={styles.resultTitle}>{ws.bookmark}</div>
      <Stack gap={2} className={styles.resultMeta}>
        {ws.repo && <span className={styles.resultRepo}>{ws.repo}</span>}
      </Stack>
      <Stack gap={1} className={styles.resultBadges}>
        <Badge color="purple">scratch workspace</Badge>
        <SessionStateBadge state={sessionState} dismissed={dismissed} />
      </Stack>
    </Stack>
  );
}

/** @param {{item: import('../../types').WorkItemListItem, sessionState?: SessionState, dismissed?: boolean}} props */
function WorkItemResult({ item, sessionState, dismissed }) {
  return (
    <Stack direction="col" gap={1} className={styles.resultInfo}>
      <div className={styles.resultTitle}>{item.title || item.reference}</div>
      <Stack gap={2} className={styles.resultMeta}>
        <span className={styles.resultRepo}>{item.reference}</span>
        {item.repositories.slice(0, 2).map((repository) => (
          <span key={repository}>{repository}</span>
        ))}
        {item.pull_request_count > 0 && (
          <span>
            {item.pull_request_count} PR{item.pull_request_count === 1 ? '' : 's'}
          </span>
        )}
      </Stack>
      <Stack gap={1} className={styles.resultBadges}>
        <Badge color={item.state === 'error' ? 'red' : 'indigo'}>{item.state}</Badge>
        <SessionStateBadge state={sessionState} dismissed={dismissed} />
      </Stack>
    </Stack>
  );
}
