import { useCallback, useEffect, useState } from 'react';
import { useAgentProvider } from '../../context/AgentProviderContext.jsx';
import { useSyncEvents } from '../../hooks/useSyncEvents.js';
import {
  createSession as apiCreateSession,
  destroyWorkspace as apiDestroyWorkspace,
  killSession as apiKillSession,
  reattachSession as apiReattachSession,
  fetchSessions,
  fetchWorkspace,
} from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import { getRelativeTime } from '../../lib/time.js';
import shared from '../../styles/shared.module.css';
import { AgentProviderButton } from '../AgentProviderButton/AgentProviderButton.jsx';
import { SessionHistory } from '../SessionHistory/SessionHistory.jsx';
import { TerminalCard } from '../TerminalCard/TerminalCard.jsx';
import { Badge } from '../ui/Badge/Badge.jsx';
import { Box } from '../ui/Box/Box.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { LoadingIndicator } from '../ui/LoadingIndicator/LoadingIndicator.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './WorkspaceDetail.module.css';

/**
 * Scratch workspace detail view.
 * @param {{
 *   workspaceId: string,
 *   onBack: () => void,
 *   workspaceStates: Map<string, 'working' | 'idle'>,
 * }} props
 */
export function WorkspaceDetail({ workspaceId, onBack, workspaceStates }) {
  const { provider } = useAgentProvider();
  const [workspace, setWorkspace] = useState(/** @type {import('../../types').Workspace | null} */ (null));
  const [session, setSession] = useState(/** @type {import('../../types').Session | null} */ (null));
  const [loading, setLoading] = useState(true);
  const [openingSession, setOpeningSession] = useState(false);
  const [openingError, setOpeningError] = useState('');

  const loadData = useCallback(async () => {
    try {
      const ws = await fetchWorkspace(workspaceId);
      setWorkspace(ws);
      if (ws.status === 'active') {
        const sessions = await fetchSessions({ type: 'workspace', id: ws.id });
        setSession(sessions[0] || null);
      } else {
        setSession(null);
      }
    } catch (err) {
      console.error('Failed to load workspace:', err);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    loadData();
  }, [loadData]);
  useSyncEvents(loadData);

  const handleStartSession = useCallback(async () => {
    if (!workspace) return;
    setOpeningSession(true);
    setOpeningError('');
    try {
      const sess = await apiCreateSession({ type: 'workspace', id: workspace.id }, provider);
      setSession(sess);
    } catch (err) {
      console.error('Failed to create session:', err);
      setOpeningError(getErrorMessage(err, `Failed to start ${provider === 'codex' ? 'Codex' : 'Claude'}`));
    } finally {
      setOpeningSession(false);
    }
  }, [provider, workspace]);

  const handleKillSession = useCallback(async () => {
    if (!session) return;
    try {
      await apiKillSession(session.id);
      setSession(null);
    } catch (err) {
      console.error('Failed to kill session:', err);
    }
  }, [session]);

  const handleSessionExit = useCallback(() => {
    setSession(null);
  }, []);

  const handleReattach = useCallback(async () => {
    if (!session) return;
    try {
      const updated = await apiReattachSession(session.id);
      setSession(updated);
    } catch (err) {
      console.error('Failed to reattach session:', err);
    }
  }, [session]);

  const handleDestroy = useCallback(() => {
    if (!workspace) return;
    // Navigate back immediately - destroy runs in the background
    onBack();
    apiDestroyWorkspace(workspace.id).catch((err) => {
      console.error('Failed to destroy workspace:', err);
    });
  }, [workspace, onBack]);

  // Auto-redirect to PR detail when a scratch workspace gets adopted
  useEffect(() => {
    if (workspace?.pr_id && !workspace.repo) {
      window.location.hash = `/pr/${encodeURIComponent(workspace.pr_id)}`;
    }
  }, [workspace?.pr_id, workspace?.repo]);

  if (loading) return <LoadingIndicator className={shared.loading}>Loading workspace...</LoadingIndicator>;
  if (!workspace) return <div className={shared.error}>Workspace not found</div>;

  const adopted = workspace.pr_id && !workspace.repo;

  return (
    <Box pb={16}>
      <Stack direction="col" gap={4}>
        {/* Header */}
        <Box p={5} border rounded="lg" bg="white">
          <Stack direction="col" gap={3}>
            <Stack justify="between">
              <Button size="md" onClick={onBack}>
                &larr; Back
              </Button>
              <Stack gap={2}>
                {workspace.status === 'active' && (
                  <Button variant="danger" size="sm" onClick={handleDestroy}>
                    Destroy
                  </Button>
                )}
              </Stack>
            </Stack>
            <div className={styles.title}>{workspace.branch}</div>
            <Stack gap={2} wrap className={shared.identityRow}>
              {workspace.repo && <span className={shared.repoTag}>{workspace.repo}</span>}
              <span className={shared.branchTag}>{workspace.branch}</span>
              <span className={shared.separator}>-</span>
              <span className={shared.updatedText}>Created {getRelativeTime(workspace.created_at)}</span>
              {workspace.status === 'destroyed' && <Badge color="red">Destroyed</Badge>}
            </Stack>
            {adopted && (
              <div className={styles.adoptedNotice}>
                Adopted by PR -{' '}
                <a href={`#/pr/${encodeURIComponent(workspace.pr_id || '')}`} className={styles.prLink}>
                  View PR
                </a>
              </div>
            )}
          </Stack>
        </Box>

        {/* Terminal */}
        {workspace.status === 'active' &&
          (session ? (
            <TerminalCard
              session={session}
              title={`Terminal - ${workspace.branch}`}
              onKill={handleKillSession}
              onExit={handleSessionExit}
              onReattach={handleReattach}
              workspaceId={workspace.id}
              prId={workspace.pr_id || undefined}
              sessionState={workspaceStates.get(`workspace:${workspace.id}`)}
            />
          ) : (
            <Box p={5} border rounded="lg" bg="white">
              <Stack direction="col" gap={3}>
                <Stack justify="between">
                  <h3 className={shared.sectionTitle}>Terminal</h3>
                </Stack>
                <Stack gap={2} wrap>
                  <AgentProviderButton
                    variant="primary"
                    size="lg"
                    onClick={handleStartSession}
                    disabled={openingSession}
                    busy={openingSession}
                  >
                    {openingSession
                      ? 'Starting session...'
                      : `Start ${provider === 'codex' ? 'Codex' : 'Claude'} session`}
                  </AgentProviderButton>
                </Stack>
                {openingError && (
                  <p className={styles.launchError} role="alert">
                    {openingError}
                  </p>
                )}
              </Stack>
            </Box>
          ))}

        {/* Past Sessions */}
        <SessionHistory key={workspaceId} target={{ type: 'workspace', id: workspaceId }} />
      </Stack>
    </Box>
  );
}
