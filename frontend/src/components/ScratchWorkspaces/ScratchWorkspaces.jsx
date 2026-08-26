import { getRelativeTime } from '../../lib/time.js';
import { SessionStateBadge } from '../ui/SessionStateBadge/SessionStateBadge.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './ScratchWorkspaces.module.css';

/**
 * @param {{
 *   scratchWorkspaces: import('../../types').Workspace[],
 *   workspaceStates?: Map<string, 'working' | 'idle'>,
 *   dismissedIdle?: Set<string>,
 * }} props
 */
export function ScratchWorkspaces({ scratchWorkspaces, workspaceStates, dismissedIdle }) {
  return (
    <div className={styles.container}>
      <Stack justify="between" className={styles.header}>
        <h2 className={styles.title}>Scratch Workspaces ({scratchWorkspaces.length})</h2>
      </Stack>
      {scratchWorkspaces.length > 0 ? (
        <table className={styles.table}>
          <colgroup>
            <col className={styles.colName} />
            <col className={styles.colRepo} />
            <col className={styles.colSession} />
            <col className={styles.colCreated} />
          </colgroup>
          <thead>
            <tr>
              <th className={styles.th}>Name</th>
              <th className={styles.th}>Repo</th>
              <th className={`${styles.th} ${styles.thCenter}`}>Session</th>
              <th className={`${styles.th} ${styles.thRight}`}>Created</th>
            </tr>
          </thead>
          <tbody>
            {scratchWorkspaces.map((ws) => {
              const targetKey = `workspace:${ws.id}`;
              const wsState = workspaceStates?.get(targetKey);
              const isDismissed = dismissedIdle?.has(targetKey);
              return (
                <tr
                  key={ws.id}
                  className={styles.row}
                  onClick={() => {
                    window.location.hash = `/workspace/${ws.id}`;
                  }}
                >
                  <td className={styles.cell}>
                    <a
                      href={`#/workspace/${ws.id}`}
                      className={styles.bookmark}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {ws.bookmark}
                    </a>
                  </td>
                  <td className={styles.cell}>{ws.repo && <span className={styles.repoTag}>{ws.repo}</span>}</td>
                  <td className={`${styles.cell} ${styles.cellCenter}`}>
                    <SessionStateBadge state={wsState} dismissed={isDismissed} border={false} />
                  </td>
                  <td className={`${styles.cell} ${styles.cellRight}`}>
                    <span className={styles.timeLabel}>{getRelativeTime(ws.created_at)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className={styles.emptyText}>No scratch workspaces</p>
      )}
    </div>
  );
}
