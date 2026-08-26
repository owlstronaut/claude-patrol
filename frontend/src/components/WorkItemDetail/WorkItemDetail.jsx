import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useAgentProvider } from '../../context/AgentProviderContext.jsx';
import { useWorkItem } from '../../hooks/useWorkItems.js';
import {
  createSession,
  destroyWorkItem,
  fetchSessions,
  killSession,
  reattachSession,
  retryWorkItem,
} from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import { workItemPath } from '../../lib/routes.js';
import { getRelativeTime } from '../../lib/time.js';
import shared from '../../styles/shared.module.css';
import { AgentProviderButton } from '../AgentProviderButton/AgentProviderButton.jsx';
import { LinkedPullRequests } from '../LinkedPullRequests/LinkedPullRequests.jsx';
import { SessionHistory } from '../SessionHistory/SessionHistory.jsx';
import { StatusBadge } from '../StatusBadge/StatusBadge.jsx';
import { TerminalCard } from '../TerminalCard/TerminalCard.jsx';
import { Badge } from '../ui/Badge/Badge.jsx';
import { Box } from '../ui/Box/Box.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { LoadingIndicator } from '../ui/LoadingIndicator/LoadingIndicator.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import { WORK_ITEM_STATE_LABELS, WorkItemStatusBadge } from '../WorkItemStatusBadge/WorkItemStatusBadge.jsx';
import styles from './WorkItemDetail.module.css';

const RETRY_LABELS = {
  resolution: 'Retry resolution',
  preparation: 'Retry preparation',
  cleanup: 'Retry cleanup',
  terminal: 'Retry terminal',
};

const PANE_STATE_STORAGE_PREFIX = 'claude-patrol-work-item-panes';

/** @typedef {'task' | 'repositories'} WorkItemPane */

/** @param {string} workItemId */
function loadPaneState(workItemId) {
  try {
    const stored = localStorage.getItem(`${PANE_STATE_STORAGE_PREFIX}:${workItemId}`);
    if (!stored) return { task: false, repositories: false };
    const parsed = JSON.parse(stored);
    return {
      task: parsed?.task === true,
      repositories: parsed?.repositories === true,
    };
  } catch {
    return { task: false, repositories: false };
  }
}

/**
 * @param {{title: string, collapsed: boolean, onToggle: () => void, children: React.ReactNode}} props
 */
function CollapsiblePane({ title, collapsed, onToggle, children }) {
  const contentId = useId();

  return (
    <Box p={0} border rounded="lg" bg="white" className={styles.collapsiblePane}>
      <h3 className={styles.paneHeading}>
        <button
          type="button"
          className={styles.paneToggle}
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={contentId}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
        >
          <span>{title}</span>
          <svg
            className={`${styles.paneChevron} ${collapsed ? '' : styles.paneChevronOpen}`}
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m6 4 4 4-4 4" />
          </svg>
        </button>
      </h3>
      <div id={contentId} className={styles.paneBody} role="region" hidden={collapsed} aria-label={`${title} pane`}>
        {children}
      </div>
    </Box>
  );
}

/** @param {{item: import('../../types').WorkItemDetail}} props */
function WorkItemProgress({ item }) {
  const destruction =
    ['destroying', 'destroyed'].includes(item.state) ||
    ['session_stop', 'transcript_archive', 'child_destruction', 'root_destruction'].includes(item.stage);
  if (destruction) {
    const steps = [
      { label: 'Stop terminal', stages: ['session_stop'] },
      { label: 'Archive session history', stages: ['transcript_archive'] },
      {
        label:
          `Remove repositories ${item.stage === 'child_destruction' ? `${item.progress.current}/${item.progress.total}` : ''}`.trim(),
        stages: ['child_destruction'],
      },
      { label: 'Remove root', stages: ['root_destruction'] },
    ];
    const current =
      item.state === 'destroyed'
        ? steps.length
        : Math.max(
            0,
            steps.findIndex((step) => step.stages.includes(item.stage)),
          );
    return (
      <ProgressSteps
        steps={steps.map((step, index) => ({
          label: step.label,
          status:
            item.state === 'destroyed' || index < current
              ? 'done'
              : index === current
                ? item.state === 'error'
                  ? 'failed'
                  : 'active'
                : 'pending',
        }))}
      />
    );
  }

  const prepareProgress = item.progress.total > 0 ? `${item.progress.current}/${item.progress.total}` : '';
  const phase = ['provider_check', 'reference_resolution'].includes(item.stage)
    ? 0
    : ['root_generation', 'child_creation', 'child_compensation'].includes(item.stage)
      ? 1
      : 2;
  const complete = item.state === 'ready';
  const failed = item.state === 'error';
  return (
    <ProgressSteps
      steps={[
        {
          label: 'Resolve reference',
          status: complete || phase > 0 ? 'done' : phase === 0 ? (failed ? 'failed' : 'active') : 'pending',
        },
        {
          label: `Prepare repositories ${prepareProgress}`.trim(),
          status: complete || phase > 1 ? 'done' : phase === 1 ? (failed ? 'failed' : 'active') : 'pending',
        },
        {
          label: 'Ready to open terminal',
          status: complete ? 'done' : phase === 2 ? (failed ? 'failed' : 'active') : 'pending',
        },
      ]}
    />
  );
}

/** @param {{steps: {label: string, status: string}[]}} props */
function ProgressSteps({ steps }) {
  return (
    <ol className={styles.progress} aria-label="Work item progress">
      {steps.map((step) => (
        <li
          key={step.label}
          className={styles[step.status]}
          aria-current={step.status === 'active' ? 'step' : undefined}
        >
          <span aria-hidden="true">
            {step.status === 'done' ? '\u2713' : step.status === 'failed' ? '!' : '\u2022'}
          </span>
          {step.label}
          {step.status === 'failed' ? ' failed' : ''}
        </li>
      ))}
    </ol>
  );
}

/** @param {{repository: import('../../types').WorkItemRepository}} props */
function RepositoryRow({ repository }) {
  const [copied, setCopied] = useState(false);
  const copyPath = useCallback(() => {
    if (!repository.checkout_available || !repository.path) return;
    navigator.clipboard.writeText(repository.path).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [repository.checkout_available, repository.path]);

  return (
    <div className={styles.repositoryRow}>
      <Stack justify="between" gap={3} wrap>
        <span className={styles.repositoryName}>{repository.identifier}</span>
        <Badge color={repository.state === 'error' ? 'red' : repository.state === 'ready' ? 'green' : 'gray'}>
          {repository.state}
        </Badge>
      </Stack>
      <dl className={styles.repositoryFacts}>
        <div>
          <dt>Bookmark</dt>
          <dd>{repository.bookmark}</dd>
        </div>
        <div>
          <dt>Start revision</dt>
          <dd>{repository.start_revision}</dd>
        </div>
        <div>
          <dt>Base commit</dt>
          <dd>{repository.base_commit ? repository.base_commit.slice(0, 12) : 'Not resolved'}</dd>
        </div>
      </dl>
      {repository.checkout_available && repository.path && (
        <Button size="xs" onClick={copyPath}>
          {copied ? 'Copied' : 'Copy path'}
        </Button>
      )}
      {repository.warnings.length > 0 && (
        <ul className={styles.warnings}>
          {repository.warnings.map((warning, index) => (
            <li key={`${index}:${warning}`}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** @param {{recovery: import('../../types').RecoveryAction}} props */
function RecoveryCommandButton({ recovery }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    if (!recovery.command) return;
    await navigator.clipboard.writeText(recovery.command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [recovery.command]);

  return (
    <Button size="sm" onClick={copy}>
      {copied ? 'Copied' : recovery.label}
    </Button>
  );
}

/**
 * @param {{workItemId: string, onBack: () => void, targetStates: Map<string, 'working' | 'idle'>, selectedPrId?: string | null}} props
 */
export function WorkItemDetail({ workItemId, onBack, targetStates, selectedPrId = null }) {
  const { provider } = useAgentProvider();
  const { workItem, loading, error, reload } = useWorkItem(workItemId);
  const target = useMemo(() => ({ type: /** @type {'work_item'} */ ('work_item'), id: workItemId }), [workItemId]);
  const [session, setSession] = useState(/** @type {import('../../types').Session | null} */ (null));
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionPending, setActionPending] = useState(/** @type {'retry' | 'destroy' | null} */ (null));
  const [collapsedPanes, setCollapsedPanes] = useState(() => loadPaneState(workItemId));
  const wsRef = useRef(/** @type {WebSocket | null} */ (null));
  const workItemState = workItem?.state;
  const expectedSessionId = workItem?.session?.id;

  useEffect(() => {
    setCollapsedPanes(loadPaneState(workItemId));
  }, [workItemId]);

  const togglePane = useCallback(
    (/** @type {WorkItemPane} */ pane) => {
      setCollapsedPanes((current) => {
        const next = { ...current, [pane]: !current[pane] };
        try {
          localStorage.setItem(`${PANE_STATE_STORAGE_PREFIX}:${workItemId}`, JSON.stringify(next));
        } catch {
          // The in-memory preference still works when storage is unavailable.
        }
        return next;
      });
    },
    [workItemId],
  );

  useEffect(() => {
    if (!workItemState) return undefined;
    if (workItemState === 'destroyed') {
      setSession(null);
      setSessionLoading(false);
      return undefined;
    }
    let active = true;
    setSessionLoading(true);
    fetchSessions(target)
      .then((sessions) => {
        if (active) {
          setSessionError('');
          setSession(sessions.find((candidate) => candidate.id === expectedSessionId) ?? sessions[0] ?? null);
        }
      })
      .catch((nextError) => {
        if (active) setSessionError(getErrorMessage(nextError, 'Failed to load terminal state'));
      })
      .finally(() => {
        if (active) setSessionLoading(false);
      });
    return () => {
      active = false;
    };
  }, [expectedSessionId, target, workItemState]);

  const runAction = useCallback(
    async (
      /** @type {'retry' | 'destroy'} */ actionName,
      /** @type {() => Promise<unknown>} */ action,
      /** @type {string} */ fallback,
    ) => {
      setActionPending(actionName);
      setActionError('');
      try {
        await action();
        reload();
      } catch (nextError) {
        setActionError(getErrorMessage(nextError, fallback));
      } finally {
        setActionPending(null);
      }
    },
    [reload],
  );

  const handleRetry = useCallback(() => {
    void runAction('retry', () => retryWorkItem(workItemId), 'Failed to retry work item');
  }, [runAction, workItemId]);

  const handleDestroy = useCallback(() => {
    if (!workItem) return;
    const count = workItem.repository_workspaces.filter((repository) => repository.checkout_available).length;
    if (
      !window.confirm(
        `Remove ${count} checkout directories and their jj workspace registrations. Patrol will leave repository bookmarks and commits in the source repositories.`,
      )
    )
      return;
    void runAction('destroy', () => destroyWorkItem(workItemId), 'Failed to destroy work item');
  }, [runAction, workItem, workItemId]);

  const ensureSession = useCallback(async () => {
    if (session) return session;
    setSessionLoading(true);
    setActionError('');
    try {
      const created = await createSession(target, provider);
      setSession(created);
      reload();
      return created;
    } catch (nextError) {
      setActionError(getErrorMessage(nextError, 'Failed to restart terminal'));
      return null;
    } finally {
      setSessionLoading(false);
    }
  }, [provider, reload, session, target]);

  const handleKillSession = useCallback(async () => {
    if (!session) return;
    setActionError('');
    try {
      await killSession(session.id);
      setSession(null);
      reload();
    } catch (nextError) {
      setActionError(getErrorMessage(nextError, 'Failed to stop terminal'));
    }
  }, [reload, session]);

  const handleSessionExit = useCallback(() => {
    setSession(null);
    reload();
  }, [reload]);

  const handleReattach = useCallback(async () => {
    if (!session) return;
    setSession(await reattachSession(session.id));
  }, [session]);

  if (loading) return <LoadingIndicator className={shared.loading}>Loading work item...</LoadingIndicator>;
  if (!workItem) {
    return (
      <Box p={6} border rounded="lg" bg="white" className={styles.notFound}>
        <p>{getErrorMessage(error, 'Work item not found')}</p>
        <Button as="a" href="#/" size="sm">
          Back to dashboard
        </Button>
      </Box>
    );
  }

  const retryAction = workItem.error?.retry_action ?? null;
  const creationBusy = workItem.state === 'resolving' || workItem.state === 'preparing';
  const destroying = workItem.state === 'destroying';
  const destroyed = workItem.state === 'destroyed';
  const canDestroy = (workItem.state === 'ready' || workItem.state === 'error') && retryAction !== 'cleanup';
  const providerName = workItem.work_provider === 'codex' ? 'Codex' : 'Claude';
  const selectedProviderName = provider === 'codex' ? 'Codex' : 'Claude';
  const resolverName = workItem.resolver_provider === 'codex' ? 'Codex' : 'Claude';
  const selectedPullRequest =
    workItem.pull_requests.find((pullRequest) => pullRequest.id === selectedPrId) ?? workItem.pull_requests[0] ?? null;

  return (
    <Box pb={16}>
      <Stack direction="col" gap={4}>
        <Box p={5} border rounded="lg" bg="white">
          <Stack direction="col" gap={3}>
            <Stack justify="between" gap={3} wrap>
              <Button size="md" onClick={onBack}>
                &larr; Back
              </Button>
              <Stack gap={2} wrap>
                {retryAction && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleRetry}
                    disabled={!!actionPending || destroying}
                    busy={actionPending === 'retry'}
                  >
                    {actionPending === 'retry' ? 'Retrying...' : RETRY_LABELS[retryAction]}
                  </Button>
                )}
                {canDestroy && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={handleDestroy}
                    disabled={!!actionPending}
                    busy={actionPending === 'destroy'}
                  >
                    {actionPending === 'destroy' ? 'Destroying...' : 'Destroy'}
                  </Button>
                )}
              </Stack>
            </Stack>
            <h2 className={styles.title}>{workItem.title || workItem.reference}</h2>
            <Stack gap={2} wrap className={styles.identity}>
              <WorkItemStatusBadge status={WORK_ITEM_STATE_LABELS[workItem.state]} />
              <span className={styles.reference}>{workItem.reference}</span>
              <span>{providerName}</span>
              {selectedPullRequest && (
                <a className={styles.prIdentity} href={`#${workItemPath(workItem.id, selectedPullRequest.id)}`}>
                  {selectedPullRequest.repository} #{selectedPullRequest.number}
                </a>
              )}
              {selectedPullRequest?.tracked && (
                <>
                  <StatusBadge status={selectedPullRequest.ci_status} type="ci" />
                  <StatusBadge status={selectedPullRequest.review_status} type="review" />
                </>
              )}
              {workItem.pull_request_count > 1 && <span>{workItem.pull_request_count} pull requests</span>}
              <span>Created {getRelativeTime(workItem.created_at)}</span>
              <span>Updated {getRelativeTime(workItem.updated_at)}</span>
            </Stack>
            {workItem.error && workItem.resolver_provider !== workItem.work_provider && (
              <p className={styles.resolver}>Reference resolver: {resolverName}</p>
            )}
            {(creationBusy || destroying) && (
              <p className={styles.actionNote}>
                {destroying ? 'Destruction is in progress.' : 'Destroy is unavailable while creation is in progress.'}
              </p>
            )}
            <WorkItemProgress item={workItem} />
          </Stack>
        </Box>

        {workItem.summary && (
          <CollapsiblePane title="Task" collapsed={collapsedPanes.task} onToggle={() => togglePane('task')}>
            <p className={styles.summary}>{workItem.summary}</p>
          </CollapsiblePane>
        )}

        {workItem.error && (
          <Box p={5} border borderColor="red-200" rounded="lg" bg="white" className={styles.failure}>
            <h3 className={shared.sectionTitle}>Failure</h3>
            <dl className={styles.errorFacts}>
              <div>
                <dt>Code</dt>
                <dd>{workItem.error.code}</dd>
              </div>
              {workItem.error.failed_provider && (
                <div>
                  <dt>Failed provider</dt>
                  <dd>{workItem.error.failed_provider}</dd>
                </div>
              )}
            </dl>
            {workItem.error.detail && <p className={styles.errorDetail}>{workItem.error.detail}</p>}
            {workItem.error.recovery_actions.length > 0 && (
              <Stack gap={2} wrap>
                {workItem.error.recovery_actions.map((recovery, index) =>
                  recovery.kind === 'settings' && recovery.href ? (
                    <Button key={`${recovery.kind}:${index}`} as="a" href={recovery.href} size="sm">
                      {recovery.label}
                    </Button>
                  ) : recovery.command ? (
                    <RecoveryCommandButton key={`${recovery.kind}:${index}`} recovery={recovery} />
                  ) : null,
                )}
              </Stack>
            )}
          </Box>
        )}

        {selectedPrId && (
          <LinkedPullRequests
            workItem={workItem}
            selectedPrId={selectedPrId}
            onWorkItemReload={reload}
            ensureSession={ensureSession}
            wsRef={wsRef}
          />
        )}

        <CollapsiblePane
          title="Repositories"
          collapsed={collapsedPanes.repositories}
          onToggle={() => togglePane('repositories')}
        >
          <div className={styles.repositoryList}>
            {workItem.repository_workspaces.map((repository) => (
              <RepositoryRow key={repository.identifier} repository={repository} />
            ))}
            {workItem.repository_workspaces.length === 0 && (
              <p className={styles.empty}>Repositories have not been resolved.</p>
            )}
          </div>
        </CollapsiblePane>

        {!destroyed &&
          workItem.state === 'ready' &&
          (session ? (
            <TerminalCard
              session={session}
              title={`Terminal - ${workItem.title || workItem.reference}`}
              onKill={handleKillSession}
              onExit={handleSessionExit}
              onReattach={handleReattach}
              wsRef={wsRef}
              baseBranch={selectedPullRequest?.base_branch ?? undefined}
              prId={selectedPullRequest?.tracked ? selectedPullRequest.id : undefined}
              sessionState={targetStates.get(`work-item:${workItem.id}`)}
            />
          ) : (
            <Box p={5} border rounded="lg" bg="white">
              <Stack direction="col" gap={3}>
                <h3 className={shared.sectionTitle}>Terminal</h3>
                <p className={styles.actionNote}>
                  Choose Claude or Codex before{' '}
                  {workItem.has_session_history ? 'reopening the terminal' : 'opening the terminal'}.
                </p>
                <AgentProviderButton
                  variant="primary"
                  size="lg"
                  onClick={ensureSession}
                  disabled={sessionLoading || !!actionPending}
                  busy={sessionLoading}
                >
                  {sessionLoading
                    ? 'Opening terminal...'
                    : workItem.has_session_history
                      ? `Reopen terminal with ${selectedProviderName}`
                      : `Open terminal with ${selectedProviderName}`}
                </AgentProviderButton>
              </Stack>
            </Box>
          ))}

        {!selectedPrId && (
          <LinkedPullRequests
            workItem={workItem}
            onWorkItemReload={reload}
            ensureSession={ensureSession}
            wsRef={wsRef}
          />
        )}

        {actionError && (
          <p className={styles.requestError} role="alert">
            {actionError}
          </p>
        )}
        {sessionError && (
          <p className={styles.requestError} role="alert">
            {sessionError}
          </p>
        )}
        {error ? (
          <p className={styles.requestError} role="alert">
            {getErrorMessage(error, 'Failed to refresh work item')}
          </p>
        ) : null}
        {retryAction === 'cleanup' && (
          <Box p={4} border rounded="lg" bg="white">
            <span className={styles.rootPath}>Retained root: {workItem.root_path}</span>
          </Box>
        )}
        <SessionHistory key={workItemId} target={target} />
      </Stack>
    </Box>
  );
}
