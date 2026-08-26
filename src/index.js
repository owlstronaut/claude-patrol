import { execFile as execFileCb } from 'node:child_process';
import { emitLocalChange } from './app-events.js';
import {
  configEvents,
  ensureConfig,
  isPollConfigured,
  loadConfig,
  setCurrentConfig,
  unwatchConfig,
  watchConfig,
} from './config.js';
import { closeDb, initDb } from './db.js';
import { startHealthChecks, stopHealthChecks } from './health.js';
import { isRunning, readPid, removePid, writePid } from './pid.js';
import { reconcilePollTargets, resetStatements, startPoller, stopPoller } from './poller.js';
import {
  activeSessionCount,
  cleanupOrphanedSessions,
  cleanupOrphanedTmuxSessions,
  killAllSessions,
  reattachOrphanedSessions,
  setMcpPort,
} from './pty-manager.js';
import { startRulesEngine, stopRulesEngine } from './rules.js';
import { createServer } from './server.js';
import { validateStartup } from './startup.js';
import { destroyTui, initTui, setHeader } from './tui.js';
import { startUpdateChecks, stopUpdateChecks } from './update-check.js';
import { recoverInterruptedWorkItems } from './work-items.js';
import { inspectWorkspaceState, pruneStaleComposeStacks, recoverInterruptedWorkspaceOperations } from './workspace.js';
import { reconcilePatrolWorkspacesOnStartup } from './workspace-reconciliation.js';

/**
 * Start the claude-patrol server.
 * @param {{ open?: boolean, noOpen?: boolean }} [options]
 */
export async function startServer(options = {}) {
  // --port <number> overrides config.port and skips the single-instance check
  const portFlagIdx = process.argv.indexOf('--port');
  let portOverride = portFlagIdx !== -1 ? Number(process.argv[portFlagIdx + 1]) : null;
  const hostFlagIdx = process.argv.indexOf('--host');
  const hostOverride = hostFlagIdx !== -1 ? process.argv[hostFlagIdx + 1] : null;

  const isReattachEarly = options.reattach || process.argv.includes('--reattach');
  // On a restart-style relaunch (--reattach) without an explicit --port, pin
  // to the previous instance's port so MCP URLs in already-running Claude
  // sessions stay valid.
  if (isReattachEarly && portOverride === null) {
    const previousPort = readPid()?.port;
    if (typeof previousPort === 'number') portOverride = previousPort;
  }
  if (!isReattachEarly && !portOverride) {
    const status = isRunning();
    if (status.running) {
      console.error(
        `[claude-patrol] Already running (pid ${status.pid}, port ${status.port}). Use "claude-patrol stop" to stop it.`,
      );
      process.exit(78); // EX_CONFIG (sysexits.h) - not a crash, just a precondition failure
    }
  }

  if (!ensureConfig()) {
    console.log(`[claude-patrol] First run - starting in setup mode.`);
  }

  console.log('[claude-patrol] Starting up...');

  const config = loadConfig();
  try {
    await validateStartup(config);
  } catch (err) {
    console.error(`[claude-patrol] ${err.message}`);
    process.exit(1);
  }
  setCurrentConfig(config);
  initDb(config.db_path);

  const interruptedWorkspaces = recoverInterruptedWorkspaceOperations();
  if (interruptedWorkspaces.length > 0) {
    console.warn(`[claude-patrol] Recovered ${interruptedWorkspaces.length} interrupted workspace operation(s)`);
  }
  const workspaceIssues = inspectWorkspaceState();
  if (workspaceIssues.length > 0) {
    console.warn(
      `[claude-patrol] ${workspaceIssues.length} workspace operation(s) need reconciliation; inspect GET /api/workspaces/operations`,
    );
  }

  const isClean = options.clean || process.argv.includes('--clean');
  if (isClean) {
    cleanupOrphanedSessions();
    cleanupOrphanedTmuxSessions();
    console.log('[claude-patrol] Cleaned up all orphaned sessions');
  } else {
    // Default: reattach surviving tmux sessions, kill dead ones.
    const count = reattachOrphanedSessions();
    if (count > 0) console.log(`[claude-patrol] Reattached ${count} surviving session(s)`);
  }
  const interruptedWorkItems = recoverInterruptedWorkItems();
  if (interruptedWorkItems.length > 0) {
    console.warn(`[claude-patrol] Recovered ${interruptedWorkItems.length} interrupted work-item operation(s)`);
  }

  // Tear down compose stacks orphaned by past workspace destroys. Runs in the
  // background so a slow docker daemon doesn't delay startup.
  pruneStaleComposeStacks(config.workspace_base_path)
    .then(({ torn, warnings }) => {
      if (torn.length > 0) {
        console.log(`[claude-patrol] Pruned ${torn.length} stale compose stack(s): ${torn.join(', ')}`);
      }
      for (const w of warnings) console.warn(`[claude-patrol] ${w}`);
    })
    .catch((err) => console.warn(`[claude-patrol] Stale compose prune failed: ${err.message}`));

  let pollerRunning = false;
  if (isPollConfigured(config)) {
    startPoller(config);
    pollerRunning = true;
  } else {
    console.log(
      config.work_items
        ? '[claude-patrol] No poll targets configured - work-item mode remains available'
        : '[claude-patrol] No poll targets configured - skipping poller (setup mode)',
    );
  }
  startHealthChecks();
  startUpdateChecks();

  const host = hostOverride || config.host;
  const server = await createServer({ config: { ...config, host } });

  // Wire the rules engine (after createServer so app.inject is available;
  // before listen so trigger handlers attach before any pr-changed fires).
  startRulesEngine(server, config);

  let port = portOverride || config.port;
  // When an explicit --port is given (e.g. on restart), the caller wants
  // exactly that port - bumping would invalidate MCP URLs in already-running
  // agent sessions. Retry the same port through the overlap window with the
  // dying old process, then bail out. Without --port, fall back to bumping.
  const stickyPort = portOverride !== null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await server.listen({ port, host });
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      if (stickyPort) {
        if (attempt === 9) throw err;
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      console.warn(`[claude-patrol] Port ${port} in use, trying ${port + 1}`);
      port++;
    }
  }

  // Write MCP config after server binds so it uses the actual port
  setMcpPort(port);

  // Write PID file with actual port
  writePid(port);

  const serverUrl = `http://localhost:${port}`;

  try {
    const reconciliation = await reconcilePatrolWorkspacesOnStartup(config, {
      isPatrolAvailable: () => server.server.listening,
    });
    if (reconciliation.deleted.length > 0) {
      console.log(`[claude-patrol] Removed ${reconciliation.deleted.length} orphaned Patrol workspace(s)`);
    }
    if (reconciliation.cleanedWorkspaces.length > 0) {
      console.log(
        `[claude-patrol] Completed cleanup for ${reconciliation.cleanedWorkspaces.length} stale workspace operation(s)`,
      );
    }
    for (const warning of reconciliation.warnings) {
      console.warn(`[claude-patrol] Workspace reconciliation warning: ${warning}`);
    }
    for (const candidate of reconciliation.blocked) {
      console.warn(`[claude-patrol] Kept stale workspace ${candidate.path}: ${candidate.reason}`);
    }
  } catch (error) {
    console.warn(`[claude-patrol] Workspace reconciliation failed: ${error.message}`);
  }

  // Start TUI if running in an interactive terminal
  const isTTY = process.stdin.isTTY && process.stdout.isTTY;
  if (isTTY) {
    const pollTargets = [...config.poll.orgs.map((o) => `org:${o}`), ...config.poll.repos.map((r) => `repo:${r}`)].join(
      ', ',
    );
    const headerMsg = pollTargets
      ? `${serverUrl}  |  polling ${pollTargets} every ${config.poll.interval_seconds}s`
      : config.work_items
        ? `${serverUrl}  |  work items enabled`
        : `${serverUrl}  |  setup mode - open browser to configure`;
    initTui({
      header: headerMsg,
      footer: '[space] open browser  [ctrl-c] quit',
    });
  }

  if (isReattachEarly) {
    console.log(`[claude-patrol] Restarted successfully on ${serverUrl}`);
  } else {
    console.log(`Server listening on ${serverUrl}`);
  }

  // Only open browser when explicitly requested via --open
  const shouldOpen = !options.noOpen && (options.open || process.argv.includes('--open'));
  if (shouldOpen) {
    execFileCb('open', [serverUrl], (err) => {
      if (err) console.warn(`Could not open browser: ${err.message}`);
    });
  }

  configEvents.on('change', (newConfig) => {
    setCurrentConfig(newConfig);
    resetStatements();
    if (isPollConfigured(newConfig)) {
      console.log(`Config changed, ${pollerRunning ? 'restarting' : 'starting'} poller`);
      startPoller(newConfig);
      pollerRunning = true;
    } else {
      console.log('Config changed but no poll targets yet');
      stopPoller();
      pollerRunning = false;
      reconcilePollTargets(newConfig).catch((error) =>
        console.error(`[poller] Target reconciliation failed: ${error.message}`),
      );
    }
    emitLocalChange();
    // Update header with new config
    if (isTTY) {
      const targets = [
        ...newConfig.poll.orgs.map((o) => `org:${o}`),
        ...newConfig.poll.repos.map((r) => `repo:${r}`),
      ].join(', ');
      setHeader(
        targets
          ? `${serverUrl}  |  polling ${targets} every ${newConfig.poll.interval_seconds}s`
          : newConfig.work_items
            ? `${serverUrl}  |  work items enabled`
            : `${serverUrl}  |  setup mode - open browser to configure`,
      );
    }
  });

  watchConfig();

  // Listen for IPC messages from watch.js (vite output, watch status)
  if (process.send) {
    process.on('message', (msg) => {
      if (msg?.type === 'log') {
        const level = msg.level || 'log';
        if (level === 'error') console.error(msg.msg);
        else if (level === 'warn') console.warn(msg.msg);
        else console.log(msg.msg);
      }
    });
  }

  console.log('Running');

  // Graceful shutdown
  let shutdownState = 'running'; // running | prompting | exiting

  async function doExit(killSessions) {
    shutdownState = 'exiting';
    destroyTui();
    unwatchConfig();
    await stopPoller({ drain: true });
    await stopRulesEngine({ drain: true });
    stopHealthChecks();
    stopUpdateChecks();
    if (killSessions) {
      console.log('Killing all sessions...');
      killAllSessions();
    } else {
      const n = activeSessionCount();
      if (n > 0) console.log(`Leaving ${n} session(s) running - will reattach on next start.`);
    }
    removePid();
    server.closeSSE();
    try {
      await server.close();
    } catch {
      /* ignore close errors */
    }
    closeDb();
    console.log('Shutdown complete.');
    process.exit(0);
  }

  function shutdown(signal) {
    const count = activeSessionCount();

    if (shutdownState === 'exiting') {
      process.exit(1);
    }

    if (shutdownState === 'prompting') {
      // Second signal while prompting - exit preserving sessions
      doExit(false);
      return;
    }

    if (count === 0 || isClean || signal === 'SIGTERM') {
      // No sessions, --clean mode, or SIGTERM: exit immediately
      doExit(isClean);
      return;
    }

    // Interactive prompt: active sessions exist
    shutdownState = 'prompting';
    destroyTui();
    console.log(`\n${count} active session(s) running.`);
    console.log('  [k] Kill sessions and exit');
    console.log('  [Enter/p] Preserve sessions and exit (reattach on next start)');
    console.log('  [Ctrl-C] Preserve and exit immediately');

    // Re-enable raw mode so single keypresses are delivered immediately
    if (isTTY && !process.stdin.isRaw) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const onKey = (key) => {
      process.stdin.removeListener('data', onKey);
      // Treat Ctrl-C as preserve-and-exit
      if (key === '\x03') {
        doExit(false);
        return;
      }
      const first = key.trim().toLowerCase();
      if (first === 'k') {
        doExit(true);
      } else {
        doExit(false);
      }
    };
    process.stdin.on('data', onKey);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Listen for keyboard input in interactive mode
  if (isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (key) => {
      if (key === '\x03') {
        shutdown('SIGINT');
        return;
      }
      if (key === ' ') {
        console.log(`Opening ${serverUrl}...`);
        execFileCb('open', [serverUrl], (err) => {
          if (err) console.warn(`Could not open browser: ${err.message}`);
        });
      }
    });
  }
}

// Direct execution guard: `node src/index.js` still works
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/src/index.js')) {
  startServer();
}
