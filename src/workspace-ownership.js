import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MARKER_VERSION = 1;
export const PATROL_WORKSPACE_MARKER = 'patrol-workspace.json';

/**
 * Record Patrol ownership inside jj metadata so it cannot affect the working
 * copy commit and survives a Patrol database reset.
 */
export function writePatrolWorkspaceMarker(workspacePath, { id, repo, name, kind }) {
  const markerPath = resolve(workspacePath, '.jj', PATROL_WORKSPACE_MARKER);
  writeFileSync(markerPath, `${JSON.stringify({ version: MARKER_VERSION, id, repo, name, kind })}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

/** Return a validated Patrol ownership marker, or null. */
export function readPatrolWorkspaceMarker(workspacePath) {
  const markerPath = resolve(workspacePath, '.jj', PATROL_WORKSPACE_MARKER);
  if (!existsSync(markerPath)) return null;
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (
      marker?.version !== MARKER_VERSION ||
      typeof marker.id !== 'string' ||
      typeof marker.repo !== 'string' ||
      typeof marker.name !== 'string' ||
      !['pr', 'scratch', 'work_item'].includes(marker.kind)
    ) {
      return null;
    }
    return marker;
  } catch {
    return null;
  }
}
