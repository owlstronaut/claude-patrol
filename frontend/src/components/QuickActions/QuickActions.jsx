import { useAgentProvider } from '../../context/AgentProviderContext.jsx';
import { usePeerReviewState } from '../../hooks/usePeerReviewState.js';
import { sendTerminalCommand } from '../../lib/terminal.js';
import { Button } from '../ui/Button/Button.jsx';
import { Spinner } from '../ui/Spinner/Spinner.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './QuickActions.module.css';

/**
 * @typedef {{label: string, command: string}} QuickAction
 * @param {string | undefined} baseBranch
 * @returns {QuickAction[]}
 */
function getActions(baseBranch) {
  const target = baseBranch || 'main';
  return [
    {
      label: `Rebase onto ${target}`,
      command: `Rebase this branch onto remote ${target}. First check whether the current branch is part of a tracked stack by running \`gh stack view --json\` - if it is, use \`gh stack sync\` to fetch, cascade-rebase the whole stack onto trunk, and push it atomically; if that hits a conflict it will tell you to run \`gh stack rebase\`, so do that and resolve conflicts with \`git status\` to see the conflicted files, editing them, then \`git add <file>\` and \`gh stack rebase --continue\` until the stack is clean. If the branch is standalone (the common case), run \`git fetch origin ${target}\`, then check if we're already up to date with \`git merge-base --is-ancestor HEAD origin/${target}\` - if so, just say it's already rebased and do nothing. Otherwise run \`git rebase origin/${target}\`, resolving any conflicts the same way (\`git status\`, edit, \`git add <file>\`, \`git rebase --continue\`). Resolving conflicts is part of the task - do not stop and ask. Then run the project's test suite (look in package.json, Makefile, etc. for the right command). Once tests pass, push with \`git push --force-with-lease\`. If tests fail, do not push - report what failed.`,
    },
    {
      label: 'Fix lint errors',
      command: 'Run the linter. Fix all errors and warnings. Show me what you changed.',
    },
    {
      label: 'Update PR description',
      command:
        'Read the diff for the PR on this branch, then update the PR description using `gh pr edit` with `--body`. Follow any PR description conventions configured for this project.',
    },
  ];
}

/**
 * Quick action buttons that send commands to an active terminal session.
 * @param {{
 *   wsRef?: { current: WebSocket | null },
 *   onSend?: (text: string) => void,
 *   baseBranch?: string,
 *   workspaceId?: string,
 *   prId?: string,
 *   sessionState?: 'working' | 'idle',
 *   sessionProvider: import('../../types').AgentProvider,
 * }} props
 */
export function QuickActions({ wsRef, onSend, baseBranch, workspaceId, prId, sessionState, sessionProvider }) {
  const { capabilities } = useAgentProvider();
  const peerReview = usePeerReviewState(prId ? workspaceId : undefined);
  const presenterProvider = peerReview.presenterProvider ?? sessionProvider;
  const reviewerProvider = peerReview.reviewerProvider ?? (sessionProvider === 'claude' ? 'codex' : 'claude');
  const presenterName = presenterProvider === 'codex' ? 'Codex' : 'Claude';
  const reviewerName = reviewerProvider === 'codex' ? 'Codex' : 'Claude';
  const reviewerCapability = capabilities[reviewerProvider];
  /** @param {QuickAction} action */
  const handleAction = (action) => {
    if (onSend) {
      onSend(action.command);
      return;
    }
    sendTerminalCommand(wsRef?.current, action.command);
  };

  const reviewActive = ['requested', 'running', 'delivering'].includes(peerReview.review?.status || '');
  const reviewDisabled =
    peerReview.requesting ||
    reviewActive ||
    sessionState === 'working' ||
    !peerReview.ready ||
    !reviewerCapability.available;
  let reviewTitle = `Review the full effective PR diff with ${reviewerName}`;
  if (reviewerCapability.checking) reviewTitle = `Checking ${reviewerName} availability`;
  else if (!reviewerCapability.available) {
    reviewTitle = reviewerCapability.reason || `${reviewerName} is unavailable`;
  } else if (peerReview.reason === 'session_restart_required') {
    reviewTitle = `Restart this ${presenterName} session to enable peer review`;
  } else if (!peerReview.ready) reviewTitle = 'The workspace is not ready for peer review';
  else if (sessionState === 'working') reviewTitle = `Wait for ${presenterName} to become idle`;

  const statusText = (() => {
    if (peerReview.error) return peerReview.error;
    if (peerReview.requesting) return `Requesting ${reviewerName} review...`;
    if (peerReview.review?.status === 'requested') return `Asking ${presenterName} to start ${reviewerName}...`;
    if (peerReview.review?.status === 'running') return `${reviewerName} is reviewing the full diff...`;
    if (peerReview.review?.status === 'delivering') return `${presenterName} is presenting the review...`;
    if (peerReview.review?.status === 'complete') return `Review delivered in ${presenterName}.`;
    if (peerReview.review?.status === 'failed') {
      return peerReview.review.error?.message || `${reviewerName} review failed.`;
    }
    if (peerReview.review?.status === 'delivery_unconfirmed') {
      return peerReview.review.error?.message || 'Review delivery could not be confirmed.';
    }
    return null;
  })();

  return (
    <Stack gap={2} wrap className={styles.actions}>
      <span className={styles.label}>Quick actions:</span>
      {getActions(baseBranch).map((action) => (
        <Button key={action.label} size="md" onClick={() => handleAction(action)}>
          {action.label}
        </Button>
      ))}
      {prId && workspaceId && (
        <Button
          size="md"
          variant="primary"
          onClick={peerReview.requestReview}
          disabled={reviewDisabled}
          busy={peerReview.requesting}
          title={reviewTitle}
        >
          {peerReview.requesting ? `Requesting ${reviewerName}...` : `Review with ${reviewerName}`}
        </Button>
      )}
      {prId && workspaceId && statusText && (
        <span
          className={peerReview.error || peerReview.review?.error ? styles.error : styles.status}
          role="status"
          aria-live="polite"
        >
          {(peerReview.requesting || reviewActive) && <Spinner />}
          {statusText}
        </span>
      )}
    </Stack>
  );
}
