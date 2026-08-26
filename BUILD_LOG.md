# Build Log

## 2026-08-26 - Repair the work-item reference resolver

Work items failed at `reference_resolution` for every reference. Three separate causes, none related to the git swap - this subsystem is untouched by it, so the resolver presumably worked against an older Claude Code whose permission model differed.

`--permission-mode dontAsk` denies MCP tools outright. It ignores `--allowedTools` in all three forms (exact `mcp__server__tool`, server-level `mcp__server`, and glob `mcp__server__*`), ignores a `permissions.allow` rule passed via `--settings`, and behaves the same whether the server comes from `--mcp-config` under `--strict-mcp-config` or from the user's own registration with settings sources enabled. All six combinations were verified to fail and `auto` verified to succeed, so the resolver now runs under `auto`. That is not `bypassPermissions`: the narrow `--allowedTools` allowlist still applies, unsafe actions are still refused, and `createToolInspector` still aborts the resolve on any tool outside the allowlist.

`--tools ''` prevented the resolver from loading the MCP tool at all. With deferred tool loading the model must call `ToolSearch` to fetch a tool's schema before invoking it, and passing `--tools` in any form - empty or naming the MCP tool - makes the subsequent MCP call fail. The flag is gone; the allowlist was always the real restriction.

That exposed the third cause: `ToolSearch` is a `tool_use` block like any other, so `createToolInspector` aborted with `resolver_tool_violation`. It now sits alongside `StructuredOutput` in an internal-mechanisms set, since it only loads schemas and whatever tool it loads is still checked against the allowlist.

Verified end-to-end against a real Linear reference: resolution returned the issue's title and summary, selected exactly one of three candidate repositories (correctly, the one the issue concerns), created the worktree from `refs/remotes/upstream/main`, generated the parent AGENTS.md/CLAUDE.md/TASK.json, and left the agent unstarted. Destroying it removed the worktree and root directory and preserved the branch, which is the documented policy.

## 2026-08-26 - Stop assuming `origin` is the canonical remote

Two follow-ups to the git swap, both found while configuring a real multi-repo setup where one checkout (`chainguard-dev/mono`) is a fork: `origin` is the personal fork and the canonical repo sits under `upstream`.

`defaultRevision` validation required the ref to start with `refs/remotes/origin/`, so `refs/remotes/upstream/main` was rejected. The rule's purpose is to reject short forms that are ambiguous with local branches, and any `refs/remotes/<remote>/<branch>` satisfies that, so it now accepts a ref under any remote. Without this there was no way to express "start from the canonical repo" in a fork checkout - the only alternative was branching from a fork's `main` that happened to be five weeks stale.

PR workspace creation hard-coded `git fetch origin <branch>`, which fails with `couldn't find remote ref` when the PR branch only exists on the canonical remote. The old jj call passed a bare revision and never named a remote, so this was a regression introduced by the swap rather than a pre-existing limitation. `remoteForRepo` now picks the remote whose URL ends in the PR's `org/repo` (matching both scp-style and URL-style remotes) and falls back to `origin`. The worktree starts from `FETCH_HEAD` rather than `<remote>/<branch>`, because a single-branch fetch only updates the remote-tracking ref opportunistically.

Still unhandled: a PR from a third-party fork, whose branch is on neither remote. `prs.is_fork` records this, but nothing acts on it.

## 2026-08-26 - Replace jj with plain git worktrees and gh-stack

Patrol's whole workspace layer was built on Jujutsu: `jj workspace add/forget` for checkouts, `jj bookmark` for branch pointers, and jj revsets for the review range. jj is no longer part of the toolchain, so every one of those call sites is now git, and the stacked-branch workflow that jj's automatic rebasing used to cover is delegated to the `gh-stack` GitHub CLI extension.

Workspaces are now `git worktree add -b <branch> <path> <start>` against the main checkout under `work_dir`, and teardown is `git worktree remove --force --force` after checking `git worktree list --porcelain` for the target. Checking the porcelain listing first (instead of pattern-matching git's error text) makes removing an already-gone worktree a clean no-op. Crash recovery also runs `git worktree prune` per repo, because a worktree directory deleted out-of-band leaves administrative records under `.git/worktrees/<name>/` that block reusing the same branch or path. `bookmark` became `branch` throughout the schema, the API, and the frontend.

`defaultRevision` is now required to be a fully-qualified remote-tracking ref (`refs/remotes/origin/main`). jj's `main@origin` had no ambiguity; in git, `origin/main` and `main` can resolve to different commits depending on what local branches exist, and silently starting a work item from a stale local branch is the kind of bug you find three commits later.

Three real defects surfaced while porting the tests, which is most of the value in this change:

The new v13 table definition was copied from v9 but dropped its `sessions` block, and `resetSchema` calls v13 - so every freshly created database failed to initialize with `no such table: sessions`. The sessions DDL is now its own function called from both the reset path and the v8-to-v9 migration.

The v12-to-v13 migration renamed `workspaces` to a temp table and rebuilt it. SQLite rewrites referencing foreign keys on `ALTER TABLE ... RENAME TO`, so `sessions.workspace_id` was repointed at `workspaces_v12` and then orphaned when that table was dropped, failing `foreign_key_check`. It is a column rename now (`ALTER TABLE ... RENAME COLUMN`), which preserves foreign keys, indexes, and rows without a rebuild.

`git diff` omits untracked files entirely, whereas jj's `@` auto-snapshotted them. Both review services gate on `resolveReviewRange`'s summary, so a workspace whose only change was a new file reported "No changes in the effective PR diff" and was never reviewed. `withUntrackedIntentToAdd` now stages untracked-but-not-ignored files with `git add -N` around *both* the change-detection gate and the diff read, then restores the index. Staging only the diff read - the first cut - still tripped the gate.

Session promote loses jj's implicit snapshot commit, so it pins `HEAD` up front and moves uncommitted work with `git stash push -u`, pinning `refs/stash` by SHA because the stash reflog is shared across every worktree of a repo.

The rebase QuickAction and the corresponding system-prompt guidance now check `gh stack view --json` first and use `gh stack sync` / `gh stack rebase --continue` for tracked stacks, falling back to `git rebase origin/<target>` plus `git push --force-with-lease` for standalone branches. Startup and `scripts/setup.sh` check for the `gh-stack` extension via `gh extension list` rather than `command -v`, since it is not a standalone binary.

## 2026-06-02 - Cleanup of merged/closed PRs runs every cycle again

The 2026-05-27 incremental-polling rewrite reintroduced the exact bug the 2026-05-13 changes had fixed: merged/closed PRs and their workspaces only got torn down on the 30-minute full sweep, and the manual "Sync now" button had quietly lost its forced full sweep, so it ran an ordinary incremental cycle that couldn't clean up at all. An `updated:>=` search can't distinguish "merged" from "not updated lately", which is why orphan cleanup was gated behind the full sweep.

Two fixes. `triggerPoll` (the Sync now path) now passes `{ force: true }`, which forces a full sweep of both roles with the reviewer search included regardless of the active tab, so the button always returns authoritative, cleaned-up state. And every cycle now runs a cheap id-only enumeration (`OPEN_IDS_QUERY`, no reviews/comments/checks) to get a complete open-set per role. Stale role-flag clearing and orphan cleanup run off that set every cycle, so merged/closed PRs disappear within one poll interval instead of waiting up to half an hour.

The heavy incremental fetch, which is where the GraphQL point savings actually live, is untouched: it still only pulls full data for recently-updated PRs. The light enumeration only fires on incremental cycles (full sweeps reuse their own complete result) and costs one to a few scalar-only requests, so the cleanup fix doesn't claw back the load reduction. The 30-minute full sweep now only exists to refresh data on PRs whose `updatedAt` didn't move, e.g. CI finishing.

## 2026-05-28 - Serialize workspace create/destroy on the same id

A destroy fired while a create was still mid-flight could mark the DB row destroyed and run `jj workspace forget` before `jj workspace add` had finished. jj then ended up owning an orphan workspace the DB no longer tracked, and the next create attempt for the same PR failed with `Workspace named ... already exists`. We hit this on `chainguard-dev/ecosystems-rebuilder.js#1267`: a destroy landed 15 ms after the create's row insert (likely a double-click while the row was visible in the listing) and the retry 34 s later collided on the jj name.

`workspace.js` now keeps a per-id promise lock. `createWorkspace`, `createScratchWorkspace`, and `destroyWorkspace` all queue through it, including the initial `INSERT` and the destroyed-status `UPDATE`. The row only becomes visible once the create holds the lock, so any destroy issued against it queues behind the create instead of racing with it. The unique-active index still handles concurrent creates for the same PR.

## 2026-05-27 - Force-refresh handles merged/closed PRs by cleaning up and navigating back

The first cut of the Refresh button always upserted whatever GitHub returned, which meant clicking Refresh on a PR that had been merged between polls would silently re-create the row in the dashboard and leave its workspaces dangling. The direct `repository.pullRequest` query doesn't filter by `is:open`, so a merged PR comes back like any other open one.

The single-PR query now selects `state`, and `refreshSinglePR` short-circuits when it's `MERGED` or `CLOSED` - it runs the same `cleanupStalePR` path the poller's orphan cleanup uses (destroy active workspaces, drop sessions and their transcripts, delete the row), and returns `{removed: true, state}`. The route surfaces that to the frontend, which alerts the user and calls `onBack()` to return to the dashboard. MCP callers get the same shape so a rule that refreshes a PR after acting on it sees the terminal state instead of an orphaned-looking row.

## 2026-05-27 - Force-refresh a single PR on demand (button + MCP tool)

With incremental polling, the dashboard is mostly fresh on the things that changed recently, but a single PR you're staring at can still lag behind GitHub by up to 30 minutes if nothing else touched it. The PR detail page now has a Refresh button that pulls live state for that one PR, and the same path is exposed as the `refresh_pr` MCP tool.

`POST /api/prs/:id/refresh` runs a direct `repository.pullRequest` GraphQL query (not a search) so it costs roughly one PR's worth of points regardless of org size. The fetch covers the same field set as the bulk search query plus `bodyHTML`, so the cached rendered description on the detail view also updates. Existing role flags (`is_authored`, `is_review_requested`) are preserved - this is a refresh, not a role re-evaluation. After upserting, the route returns the same shape as `GET /api/prs/:id` so the frontend can replace its local state in one step.

The MCP tool is `ruleFireable: true` because there's a real use case for rules to refresh a PR right after they act on it (e.g. after retriggering checks the rule wants to see the new status without waiting for the next poll). Same dispatch shape as the existing PR-scoped tools, just a POST instead of a GET.

## 2026-05-27 - Incremental polling so most cycles only fetch recently-updated PRs

Even with the reviewer search gated behind the reviews tab, each poll cycle still re-fetched every open PR in the configured orgs. In a busy mono-org that's hundreds of PRs every five minutes, each with up to 50 reviews, 50 comments, and 30 inline check contexts. GraphQL points pile up fast and the rate limit shows up.

Each poll cycle now decides per role whether to do a full sweep or an incremental one. Incremental cycles append `updated:>=<lastSweep - 10min>` to the GitHub search, so the query only returns PRs that actually changed since we last looked. The 10 minute overlap is a buffer for clock skew and in-flight time so we don't drop a PR that updated right at the boundary. Full sweeps still run every 30 minutes per role so PRs that fell out of `is:open` (merged, closed, archived) get the role-flag and orphan cleanup that only a complete enumeration can do safely.

Per-role timestamps live in module-level `lastSweepAt` and `lastFullSweepAt` maps, advanced only after the fetch succeeds so a failed cycle replays its window on the next attempt instead of silently dropping updates. Stale role-flag cleanup is gated on `authorFull` / `reviewerFull` because the incremental result set only contains updated PRs - clearing flags on everything else would mark the rest of the org as no-longer-authored. Orphan deletion still runs, but only when the included roles all did full sweeps in this cycle, since otherwise the flags can't be trusted to reflect the current GitHub state.

Switching into the reviews tab when reviewer data is older than 30 minutes still triggers a full reviewer sweep on the manual sync, since `lastFullSweepAt.reviewer` will be either null or stale. Adding or removing a target via the dashboard also forces the next cycle to be a full sweep so the new org's open PRs land immediately instead of waiting for the next half hour.

## 2026-05-27 - Skip the review-requested GitHub search when nobody is on the reviews tab

The review-requested queue in a busy org has way more PRs than the authored queue, and each poll cycle was running both searches every time. On the authored tab that's wasted work, the user only sees authored data, and the cycle still has to wait for the slow review-requested search to finish before declaring sync complete.

Each browser tab now generates a stable `clientId` (kept in sessionStorage) and POSTs `{clientId, tab}` to `/api/active-tab` on mount, on tab change, and on a 60s heartbeat. The server tracks one entry per client with a 5-minute TTL, so closed browser tabs eventually stop counting. The poller checks `hasReviewsViewer()` before each cycle, and when nobody is on the reviews tab it skips both the GraphQL search and the per-role stale-flag cleanup. Orphan deletion is also skipped on those cycles, since an authored PR that's still review-requested but happens to fall out of the authored search shouldn't get its workspace torn down based on a half-refreshed picture.

Switching into the reviews tab posts the new tab and then fires `/api/sync/trigger`, so the data refreshes immediately instead of waiting for the next interval tick. Multiple browser tabs are tracked independently, so one window on authored and one on reviews still pulls both searches.

## 2026-05-26 - Add a "Review requests" tab alongside the authored PR dashboard

Patrol previously only surfaced PRs that the signed-in user authored (`author:@me`). To make patrol a place to do review work too, the dashboard now has two tabs: "My PRs" and "Review requests". They're visually distinct (blue accent vs amber accent, with PR counts in each tab) so the two surfaces don't visually blur even though the table underneath has the same shape.

Each PR row tracks two role flags (`is_authored`, `is_review_requested`) and a single row can carry both. The poller runs two GraphQL searches per cycle (one per role) in parallel and merges results by PR id; stale cleanup clears the per-role flag, and a row only gets deleted (with workspace teardown) once both flags are 0. That keeps the data model honest about a PR that you authored AND were requested to review on, it appears in both tabs from the same row.

`GET /api/prs?role=author|reviewer` filters per tab. No role defaults to `author`, which preserves the existing MCP `list_prs` behaviour without any tool changes. The migration backfills `is_authored=1` on every existing row so nothing disappears on first start after the upgrade.

Tab state lives in the URL hash (`#/` vs `#/reviews`) and switching tabs resets the in-page filters and sort, which is the simplest behaviour that doesn't carry surprising state across tabs. Scratch workspaces (which are author-side artefacts) only show on the authored tab.

Out of scope for this slice: review actions (approve, request changes, comment), team-requested reviews, and any review-specific MCP tools. Those come in follow-up changes once the data surface proves itself.

## 2026-05-22 - Make `frontend/` a pnpm workspace so root install covers both packages

A returning contributor ran `pnpm install` then `pnpm start` and got `sh: vite: command not found` because `frontend/` was a sibling package, not a workspace, so root install never populated `frontend/node_modules`. Setup docs assumed you'd remember to run `pnpm run setup` (which did the separate `pnpm --filter` install), but plain `pnpm install` looks like it should be enough and silently isn't.

Added `pnpm-workspace.yaml` listing `frontend`, dropped the explicit `pnpm --filter claude-patrol-frontend install` from `scripts/setup.sh` (root install now does both via the workspace), and updated CLAUDE.md + README to reflect that routine `pnpm install` covers both packages once xterm.js is vendored.

We still can't make `pnpm install` do everything on a fresh clone without violating the no-install-hooks policy: the vendored xterm.js is a git clone + npm build (not a pnpm dep), and pnpm install on a fresh tree would fail anyway because `frontend/`'s `file:../vendor/xterm.js` paths don't exist yet. So `pnpm run setup` stays as the first-time bootstrap. After that, `pnpm install` is enough.

Also added an early guard in `scripts/build-if-stale.sh`: if `frontend/node_modules` is missing when `pnpm start` runs, bail with a clear message pointing at `pnpm install` or `pnpm run setup` instead of letting vite fail with `command not found`.

## 2026-05-22 - Fix `pnpm start` under macOS bash 3.2

`scripts/start-loop.sh` runs under `set -u` and expands `"${args[@]}"` on the first iteration. macOS ships bash 3.2.57, which treats an empty array under nounset as unbound and aborts before node ever starts. Guarded the expansion with a length check so the empty case calls node with no extra args.

## 2026-05-22 - destroyWorkspace tears down nested compose stacks + startup sweep for orphans

`dockerComposeDown` only matched `docker-compose.yml`/`compose.yml` at workspace root, so repos with nested compose files (e.g. ecosystems-rebuilder.js at `infra/local/docker-compose.yaml`) silently skipped teardown and accumulated volumes/networks across every destroy. Replaced the root check with a walker that finds all four canonical filenames anywhere in the tree (skipping node_modules, .git, .jj, .next, dist, build) and tears down each from its own directory. Dropped the basename-fallback for missing compose files because the basename was almost never the real compose project name.

Added `detectStaleComposeStacks` + `pruneStaleComposeStacks` and a fire-and-forget call on server startup. Lists `docker compose ls -a --format json`, flags stacks whose first ConfigFiles path lives under `workspace_base_path` but no longer exists, and tears each down via `docker compose -p <name> down -v --remove-orphans` (works without the original compose file since compose finds resources by project label).

## 2026-05-20 - Run Now queues behind a busy session, surfaces errors in the UI

Clicking Run Now on a PR whose session was mid-turn looked silently broken: the rule fired, dispatch threw `session_busy`, `fireRule` recorded `status: 'error'` on the run row, the route returned that row with HTTP 200, and the frontend's `runRuleManually` (which only throws on `!res.ok`) returned cleanly. No feedback, no prompt sent.

Two changes:

1. `ensureSessionAndSend` takes a `waitForBusy` flag. When set and the resolved session is in `working` state, it awaits `waitForFirstIdle` (capped at 15 min) instead of letting `dispatchToSession` throw. `manualRunRule`'s PR-trigger path passes `waitForBusy: true`; the natural-trigger path leaves it off so the busy-as-cooldown-retry contract is preserved. Run-all stays fail-fast too - it's parallel fire-and-forget and waiting per PR would serialize it.

2. The frontend `runRuleManually` now treats a returned `run.status === 'error'` as a thrown error so `RuleControls` surfaces it next to the button.

Diagnostic improvement folded in: when dispatch throws, the dispatcher attaches the resolved `session_id` to the error and `dispatchClaude` records it on the run row. Before, a `session_busy` error left `rule_runs.session_id` NULL even though we knew exactly which session was busy.

## 2026-05-19 - Manual "Run Now" consumes `consume_on: trigger` subscriptions

A manual rule run is a hard trigger - the user clicking "Run Now" should leave the same state behind as the natural event firing. The natural path in `handlePrChanged` consumes `consume_on: trigger` subscriptions before firing (so until-next-trigger semantics hold even when `where` doesn't match), but `manualRunRule` skipped that step. Result: subscribing a PR to a `consume_on: trigger` rule and then running it manually would leave the subscription armed, so the next natural trigger would fire the rule again.

`manualRunRule` now mirrors the same delete: if `requires_subscription` and `consume_on === 'trigger'` and a subscription exists for this `(rule, pr)`, drop it before the fire. `consume_on: fire` was already correct - `fireRule` consumes on success regardless of how it was invoked. Permanent subscriptions (no `consume_on`) are deliberately left in place; they're meant to stand.

Same fix applied to `runRuleForAll` (the bulk surface behind `/api/rules/:id/run-all`). Same reasoning: a bulk hard trigger should consume what a natural trigger would consume, otherwise every PR it fires against keeps its subscription armed for the next real event.

## 2026-05-13 - Explicit `pnpm run setup` for new contributors

New contributors hit a wall: after `pnpm install` at the root, `pnpm start` failed with `sh: vite: command not found` because `frontend/node_modules` was never installed and `vendor/xterm.js` was never cloned. There was also no obvious single command to drive the rest of setup - users had to read the script list and discover `setup:xterm` themselves.

Fix: one explicit `pnpm run setup` command that runs after `pnpm install`. It (1) clones and builds vendored xterm.js if missing, (2) `cd frontend && pnpm install`, and (3) fixes the node-pty spawn-helper executable bit on macOS. Idempotent.

Why not `preinstall`/`postinstall` hooks: install hooks run silently on every `pnpm install` (including transitively when this package is a dependency, in CI, etc.) and are a well-known supply-chain footgun. An explicit setup command is harder to miss - and `pnpm start` is now noisy about its prerequisites - without ceding any visibility.

Also removed the redundant xterm existence check from `start`/`watch` (setup is the only place that handles it now), and added a `build` script so `pnpm run build` does what you'd expect. CLAUDE.md and README.md call the new command out at the top of the onboarding section.

## 2026-05-13 - Every poll cycle does a full sweep + stale cleanup

Followup on the earlier merged-PR fix: scheduled polls also need to drop merged/closed rows, not just the manual sync button. The earlier change only fixed `triggerPoll`; scheduled polls were still incremental and only ran cleanup every 30 minutes.

Removed the incremental fetch path entirely (`since` filtering, `FULL_SYNC_INTERVAL_MS`, `lastFullSyncAt`, the `complete` flag). `author:@me` keeps the result set small enough that pagination rarely matters, and the incremental optimization is what created the cleanup-skip bug class. Every `pollOnce` now fetches all open PRs for the configured targets and runs stale cleanup against that seen-set.

## 2026-05-13 - Manual sync forces full sweep so merged PRs disappear

`POST /api/sync/trigger` was running an incremental poll, and stale-row cleanup only runs at the end of a full sweep (`complete=true`). If the user hit "sync" within 30 minutes of the previous full sync, the incremental fetch would early-terminate, `complete` would be `false`, and merged/closed PRs would stay on the dashboard until the next periodic full sync.

`triggerPoll` now passes `{ forceFull: true }` to `pollOnce`, which bypasses the `since` filter and guarantees the cleanup branch runs. Scheduled polls still use the periodic full-sync cadence; only the manual button is affected.

## 2026-05-12 - "First reaction" column on the PR table

Adds a column next to "Updated" showing the weekday hours from PR creation to the first non-author, non-bot review or comment. Greyed out with a `+` suffix while still pending. Drafts show `-` (clock doesn't start).

Backend was previously only fetching reviews. The GraphQL query now also pulls `comments(first: 50)`, and both `reviews` and `comments` carry the author's `__typename` so bot filtering doesn't rely on the `[bot]` suffix convention alone. A new `comments` JSON column on `prs` stores them; `formatPR` parses them and the poller upsert writes them.

Frontend computes the metric from the existing PR payload, so no extra round trip. Weekend hours don't accrue, matching the analytics script.

Related side-effect: the reviews query went from `reviews(last: 10)` to `reviews(first: 50)`. The "last in iteration wins" loop in `deriveReviewStatus` still picks the latest state per reviewer for any PR with ≤50 total reviews (essentially all of them); PRs with more than 50 reviews could in theory have stale state pickup, but it hasn't happened in practice and the dual-field complexity isn't worth it yet.

## 2026-05-12 - pr-first-interaction-trend analytics script

Standalone Python script at `scripts/pr-first-interaction-trend.py` that pulls every PR you've authored in a given GitHub org or repo and plots the rolling time-to-first-human-interaction. Uses `gh api graphql` so auth is whatever `gh` already has.

Run-time shape:

- `uv run --script` with PEP 723 inline deps (matplotlib only) so nothing leaks into system Python.
- Required scope: exactly one of `--org` or `--repo`. No hardcoded org name in the source.
- `--since YYYY-MM-DD` filters the display window but keeps earlier history loaded as a smoother baseline.
- Drafts are skipped. PRs that were drafts before becoming reviewable start the clock at the latest ready-for-review event, not at PR creation.
- Weekend hours don't accrue (Sat/Sun count as zero) so the metric reflects actual workdays.
- Currently-open PRs with no human interaction count as if reviewed now (blue triangles), so they grow over time.
- Closed/merged PRs with no human interaction are excluded.
- Visible activity gaps (>`--gap-days` calendar days between consecutive PRs) are shaded grey and break the rolling line.
- The smoothed trend is a single-pass forward+backward EWMA. `--smoothing 0.10` is the default; outliers create visible bumps that decay back into the data instead of permanently lifting the line. `--outlier-power N` (default 1) optionally biases the aggregation upward.

The script generates a single PNG; nothing about the plot defaults references the user.

## 2026-05-08 - System prompt: inter-session messaging workflow (lt#16)

Appended a "Talking to other sessions" section to `src/patrol-system-prompt.md` so spawned Claudes know the new tools exist and the patterns to use them. Documents the dispatch-then-wait flow, the busy-retry pattern, the self-target restriction, and the "current turn" semantics of `wait_for_idle` (it doesn't wait for background subagents, `run_in_background` Bash, or autonomous loops).

Hyphens only, no em-dashes (per global writing-style preference). Tone matches the existing prompt: brief and project-specific.

Closes the lt#4 umbrella. Six commits, one per step. The full chain works end-to-end: spawn a session and Claude can list other sessions, send a prompt to one of them, and wait for the response.

## 2026-05-08 - wait_for_idle MCP tool (lt#15)

Companion to `send_prompt_to_session`. Blocks until the target session's current TUI turn quiesces. The `since` anchor (typically `dispatched_at` from a recent send) makes the check race-safe: predicate is `lastWorkingAt >= since && lastIdleAt > lastWorkingAt && activityState === 'idle'`. Combined with the lt#12 setState ordering lock, listeners observing the `session-state idle` event always see consistent fields, so the snapshot taken inside the event handler reflects the transition that just fired.

Snapshot fast-path: if the predicate is already satisfied at handler entry, returns immediately with the existing timestamps. Otherwise subscribes to `appEvents` `session-state`, resolves on the first `idle` event that satisfies the predicate, rejects on `exited`, rejects on timeout. Listeners are removed on every exit path.

Defaults: timeout 30 minutes, min 1, max 120. Returns `{ ok: true, idle_at: ISO, working_duration_ms }` on success or `{ ok: false, error: <code>, message }` on `no_session` / `session_detached` / `session_exited` / `timeout`.

Detached and killed sessions are rejected immediately. The dispatcher already refuses to send to detached targets, so anything `wait_for_idle` is asked to watch should be either active in memory or genuinely gone.

The contract is "current turn", not "all spawned work done." Background subagents, `run_in_background: true` Bash, and autonomous loops continue past the parent's turn end. Documented in the tool description; the system-prompt update in lt#16 will reinforce.

Verified: `pnpm test` passes (8/8). End-to-end live verification (busy-retry pattern, real send-then-wait round trips) requires the system prompt to land first so a fresh Claude session knows to use the tool; that's lt#16.

Added a small read-only getter `getSessionSnapshot(sessionId)` to `pty-manager.js` so the handler can sample current state without touching the private `sessions` map.

## 2026-05-08 - send_prompt_to_session MCP tool (lt#14)

The actual feature: a running Claude can send a prompt to another Claude session. New `send_prompt_to_session` MCP tool. The handler is a thin adapter: it forwards the four target modes (`session_id`, `pr_id`, `workspace_id`, `global`), `prompt`, `create_if_missing` (default true), and the caller's identity from `ctx.callerSessionId` to `ensureSessionAndSend` from lt#12. The dispatcher owns targeting validation, resolution, the self-target check, the busy check, and the send.

Errors are returned as `{ ok: false, error: <code>, message }` (codes from the dispatcher: `no_target`, `multiple_targets`, `no_session`, `no_workspace`, `session_detached`, `self_target`, `session_busy`). Successes return `{ ok: true, session_id, workspace_id, dispatched_at }`. `dispatched_at` is the input to `wait_for_idle.since`.

`ruleFireable: false`: rules have `dispatch_claude` for this; the MCP tool is for Claude callers.

Verified: `pnpm test` passes (8/8). Syntax-checked. Live verification waits until lt#15 lands so the busy-retry pattern is testable end-to-end.

## 2026-05-08 - list_sessions MCP tool (lt#13)

A calling Claude needs to know what sessions exist before it can target one with `send_prompt_to_session`. New `list_sessions` MCP tool returns active sessions with workspace context (pr_id, repo, bookmark, path), activity state from `getSessionStates()`, and started_at. Detached sessions are excluded because the dispatcher rejects them as targets (lt#4 design lock); listing them would invite the caller to pick something it cannot then send to. `is_global` is a derived convenience field (workspace_id === null) so callers don't have to special-case the null check.

Single SELECT with a LEFT JOIN against workspaces. Activity state is layered in via `Map(getSessionStates())`. `ruleFireable: false`: read-only inspection has no business firing from rules.

The `branch` field is named `bookmark` because that's what Patrol's workspaces table calls the jj bookmark; for git-bookmarked workspaces the two are equivalent.

Verified: `pnpm test` passes (8/8). Syntax-checked.

## 2026-05-08 - Extract dispatcher + activity timestamps + 10s idle threshold (lt#12)

The "ensure workspace + ensure session + wait first idle + write prompt" flow was tangled inside `rules.js` `dispatchClaude`. The upcoming `send_prompt_to_session` MCP tool (lt#14) needs the same flow. Extracted into `src/dispatcher.js` with one entry point: `ensureSessionAndSend({ session_id?, pr_id?, workspace_id?, global?, prompt, autoCreate?, callerSessionId? })`. Resolves any of the four target modes, runs the busy check, force-sets working state for the deterministic `wait_for_idle.since` anchor, writes the prompt, returns `{ session_id, workspace_id, dispatched_at }`.

Self-target check lives in the dispatcher: if `callerSessionId` matches the resolved target, it throws `self_target`. Detached sessions are rejected with `session_detached` per the lt#4 design lock. All errors carry `.code` for stable machine-readable branching.

Rules engine `dispatchClaude` is now a thin caller. `session_busy` is preserved as a plain `Error` so the existing cooldown/retry path keeps working. Workspace id is pre-resolved into the rule_run row when an active workspace already exists (so a `session_busy` failure still records workspace_id for diagnosis); when autoCreate has to make one, the row gets the id from the dispatcher's return value.

Activity timestamps land on the session entry: `lastWorkingAt`, `lastIdleAt`. Set inside `attachPtyToTmux`'s closure by a unified `transitionTo(state)` helper (timestamp first, then state, then emit, locked order so listeners observing the `session-state` event always see consistent fields). New `entry.markWorking()` lets the dispatcher force-set working at dispatch time. Empirically (lt#17) the TUI echo on prompt write is structurally a LARGE_OUTPUT so the natural detector trips working anyway, but the deterministic anchor is worth a few lines.

`IDLE_THRESHOLD_MS` bumped from 5s to 10s. Probe data (lt#17) shows max mid-turn gap of 1.36s during a 15s silent tool call. 10s gives 7x safety margin against false-positive idle. Side effects: `session.idle` rule trigger fires later (no production rules use it), `waitForFirstIdle` boot path takes slightly longer to fire on real idle but still has 3x headroom against its 30s timeout, UI activity badges flap less.

Cleanup: removed `sendPromptToSession` and `writeToSession` exports from `pty-manager.js`. The first is no longer called (rules engine routes through the dispatcher now). The second was already dead. Both were public exports but nothing in the codebase referenced them.

Verified: `pnpm test` passes (8/8). Syntax-checked.

## 2026-05-08 - Per-session MCP URLs + caller identity plumbing (lt#11)

The MCP endpoint was a single shared `POST /mcp`. Tool handlers had no way to know which Claude session was calling, so any caller-aware tool would have to trust the calling Claude to pass its own session id as a tool arg. Brittle in principle and a blocker for the inter-session messaging work in lt#4.

Now: `POST /mcp/:sessionId`. Each session writes its own MCP config file at session-spawn time (`tmpdir()/patrol-mcp-${id}.json`) pointing at its own URL. The route handler validates the session id against the sessions table (404 if no row, or no `active`/`detached` row), and passes `callerSessionId` into `createMcpServer(app, ctx)`. Per-tool handlers receive `ctx` as a third arg (`mcpHandler(app, args, ctx)`, `dispatch(args, ctx)`). No tool uses it yet; existing handlers ignore it.

Pure plumbing. No tool semantics change.

`paths.mcpConfigPath()` is gone, along with the shared `~/.local/share/claude-patrol/.patrol-mcp.json` file. The `clean` command no longer touches it. Per-session files in tmpdir leak on session exit; matches existing `patrol-prompt-${id}.txt` behavior. If cleanup ever matters, do it as a startup tidy pass, not on `proc.onExit` (that fires on graceful preserve-sessions shutdown too, and would delete configs for sessions still alive in tmux).

Reattach behavior: `reattachOrphanedSessions` doesn't touch per-session configs. The files in tmpdir survive across restarts, and `--reattach` pins the port to the previous instance, so the configs remain valid for the live claude processes inside tmux. No code change needed there.

Live-session impact: clean break. Claude CLI reads `--mcp-config` once at spawn. Sessions started before this commit have `--mcp-config` pointing at the old shared file with URL `/mcp`, but the server now responds only at `/mcp/:sessionId`. Those live sessions lose MCP tools until they're killed and restarted. Consistent with prior pty/WS shape changes (`fcb99ce`, `ebf502f`).

Verified: `pnpm test` passes (8/8). Module imports cleanly. Syntax-checked all edited files.

## 2026-05-04 - Subscription lifetime: consume_on replaces one_shot (close lt#1)

`one_shot: true` only consumed a subscription on a successful fire. PRs whose state moved away from the rule's `where` (e.g. CI passes after being subscribed to a fail-only rule) kept the subscription forever and would later fire on an unrelated trigger event - the gap that lt#1 captured. Bulk-subscribe made it worse: subscribe a fleet of pending-CI PRs and you guarantee a long tail of stale subscriptions.

`one_shot: boolean` is gone. New `consume_on: 'fire' | 'trigger'` field, both options imply `requires_subscription: true`. Omit for permanent subscriptions.

- `consume_on: 'fire'` - exact old `one_shot: true` behavior. Subscription consumed only on a successful fire. Standing watch (e.g. auto-rebase on conflict).
- `consume_on: 'trigger'` - subscription consumed on the next `rule.on` event for the PR, whether or not `where` matched and whether or not the fire succeeded. Trial-once watch (e.g. retrigger CI on the next finalization, then stop).
- (omitted) - permanent subscription, fires on every match.

Consumption sites:
- `'fire'`: in `fireRule`'s success path (renamed from the old one_shot branch).
- `'trigger'`: in `handlePrChanged`, deleted before the `where` check so a fire-error doesn't preserve the subscription. The trigger event itself is what consumes it.

UI labels updated: dashboard `TriggerableRuleItem` shows "Subscription (until fire)" / "Subscription (until next trigger)" / "Subscription (permanent)". `RuleControls.jsx` shows "Armed (fires once)" or "Armed (next trigger only)" badges. Bulk-subscribe confirm dialog tailors its lifetime warning per mode.

User config migrated: all three rules in `~/.config/claude-patrol/config.json` (retrigger-on-fail, rebase-on-conflict, review-on-ready) now use `consume_on: "fire"`. README rule schema docs updated to match. No legacy `one_shot` field anywhere; rules referencing it would fail validation.

## 2026-05-04 - Fix: WS race + silent drops (close lt#3)

`handleInvestigateFailures` previously did `setTimeout(() => sendTerminalCommand(...), 500)` after creating a session. The 500ms was hopeful - it had to cover React render, Terminal mount, and WS handshake. Slow tab or slow tmux startup → command silently dropped, no log, no UI feedback. The recently-fixed parseWsMessage regression hid behind exactly this silent-drop pattern.

Two changes:
- `sendTerminalCommand` now returns boolean and `console.warn`s when called against a closed WS. Silent drops are gone.
- New `whenWsOpen(wsRef, timeoutMs)` polls every 50ms up to a deadline (default 5s) and returns the open WS or null. `handleInvestigateFailures` uses it; if the WS doesn't come up in time, the user gets an alert telling them to refresh.

QuickActions wiring through `TerminalCard.handleSendCommand` also uses `whenWsOpen` (2s) to handle the case where the user clicks a quick action while the WS is still CONNECTING (e.g. just-reattached session). No alert there - just silently waits up to 2s, falls through to the console.warn in `sendTerminalCommand` if it never comes up.

## 2026-05-04 - Refactor: WS message types own their own validation (close lt#2)

Yesterday's `prompt-submit` regression came from a structural problem: `parseWsMessage` was a whitelist on one side of `pty-manager.js` and the message handler was a switch on the other. Adding a type meant updating both lists; the f2436f3 commit only updated one and the resulting silent-drop wasn't caught until a user reported it.

Single source of truth now: `WS_MESSAGE_HANDLERS` is a record of `{ type: { validate, handle } }`. New `dispatchWsMessage(raw, entry, ctx)` parses, looks up the entry, validates, and dispatches in one pass. Adding a message type means adding one entry - structurally impossible to add a handler without validation or vice versa. The `attachSession` WS message hook collapses to a one-liner that just calls `dispatchWsMessage`.

Added `src/pty-manager.test.js` (the project's first test file) covering the dispatch + validation matrix: each documented type round-trips correctly, malformed JSON / missing fields / wrong types are rejected. Run with `pnpm test`. Future message types added without test coverage will at least force the author to look at the test file.

The `parseWsMessage` export is gone. Nothing else in the codebase imported it.

## 2026-05-04 - Fix: parseWsMessage was dropping prompt-submit messages

User reported "Investigate failures button doesn't work anymore." Root cause: the f2436f3 refactor that introduced the `prompt-submit` WS message type added a handler arm in `attachSession`'s message switch (`src/pty-manager.js:490`) but did not update the validator at `src/pty-manager.js:438`. `parseWsMessage` whitelists `input` and `resize`; `prompt-submit` returned `null` and the handler short-circuited at `if (!msg) return` before reaching the new arm. Every frontend `sendTerminalCommand` call (Investigate failures, every QuickActions button) was silently dropped.

One-line fix: add `if (msg.type === 'prompt-submit' && typeof msg.text === 'string') return msg;` to the validator. Verified by sending a marker prompt-submit through a real WS connection and watching the marker text echo back in the PTY output.

The structural risk - validator and handler are two independently-maintained lists of message types - is captured in `claude-patrol#2` for a follow-up cleanup. The brittle 500ms `setTimeout` and silent-failure UX in `handleInvestigateFailures` (which hid this regression from earlier detection) is `claude-patrol#3`.

## 2026-05-04 - Rules: bulk subscribe ("subscribe all matching") via API, MCP, and UI

Companion to the existing bulk-fire surface. New `POST /api/rules/:id/subscribe-all` opts every PR matching a subscription rule's `where` clause into that rule, without firing anything. Use case: "subscribe every conflicted PR to auto-rebase from now on" without the destructive blast radius of `run-all` with `subscribe: true`.

Same three surfaces as bulk-fire:
- HTTP: `POST /api/rules/:id/subscribe-all` (no body).
- MCP: `subscribe_rule_for_all_matching_prs` (`ruleFireable: false`).
- UI: a second button "Subscribe all matching" appears next to "Run for all matching" in the dashboard's Trigger dropdown, but only for rules with `requires_subscription: true`.

Response shape: `{ subscribed: [{pr_id}], already_subscribed: [{pr_id}], skipped: [{pr_id, reason}] }`. Counts are race-safe because `subscribeRule` now returns a `created` boolean from the `INSERT ... ON CONFLICT DO NOTHING` row count, so concurrent calls don't double-count newly-inserted vs already-existing rows.

Validation: rejects unknown rules and rules without `requires_subscription`. The redundant PR-trigger check from the first draft is gone since the rule loader already gates `requires_subscription` to PR triggers.

Known gap (filed as `claude-patrol#1` in the local ticket store): subscriptions only clear on a successful fire (`one_shot`). PRs whose state diverges so the `where` clause stops matching keep the subscription forever and may fire on a later trigger event. Bulk-subscribe makes this more pronounced. The confirm dialog warns users until the planned `until_fire` / `until_trigger` lifetime modes land.

## 2026-05-04 - Split rule activity from rule triggers in the summary bar

Two dropdowns now where there was one:

- **Rule activity** (existing, scoped down): shows bad rules + recent runs. Label switches between "N bad rules", "N running rules", and "N recent rule runs" based on what's most relevant. Hidden when there's no activity.
- **Trigger rules** (new): lists every rule that's auto-fireable against PRs (PR-trigger, not manual) with a "Run for all matching" button per rule. Label is "Trigger rule(s)". Hidden when there's nothing to trigger.

The previous single dropdown mixed rule definitions, errors, and runs - clicking it to "see what fired recently" surfaced rule definitions that needed scrolling past, and clicking it to "fire this rule on all PRs" surfaced runs that didn't matter. Splitting them by intent (observation vs action) keeps each dropdown short and obvious.

Internal cleanup: dead `kind: 'def'` branch removed from `RuleItem`. New `TriggerableRuleItem` owns the bulk-fire UI.

## 2026-05-04 - Single source of truth for prompt-submit timing; remove per-PR bulk-fire button

Two related changes.

The prior fix solved the "Enter not pressed" bug by mirroring the frontend's split-write pattern in a new `sendPromptToSession` helper on the backend. That left two parallel implementations of the same pattern: frontend `sendTerminalCommand` and backend `sendPromptToSession`. Either could drift and re-introduce the bug.

Structural fix: a new `prompt-submit` WebSocket message type. The frontend stops doing the split client-side and just sends `{ type: 'prompt-submit', text }`. The server-side WS handler unpacks it via the same internal `submitPromptToEntry(entry, text)` helper that `sendPromptToSession` calls. The split logic and timing constant (`PROMPT_SUBMIT_DELAY_MS = 100`) live in exactly one place. Future entry points (CLI, MCP raw-input tool, Electron) using either the WS protocol or the server-side helper get the correct behavior automatically.

Side effect: `sendTerminalCommand` shrinks from a setTimeout-based two-message sender to a one-line WS dispatch. The frontend no longer carries split-timing knowledge.

Second change: the "Run for all matching" button on the PR detail's Rules section is gone. Bulk-fire is a global concern - it doesn't belong attached to a specific PR. The dashboard summary's Rules dropdown is the canonical place; the per-PR view keeps only Subscribe/Unsubscribe and Run now (which scopes to that PR).

## 2026-05-04 - Rules: dispatch_claude split-write to match the frontend's submit pattern

User reported that an auto-rebase fire landed the prompt in Claude's input field but never pressed Enter, leaving the rule_run in success state with nothing happening. The bug: `dispatchClaude` did `writeToSession(id, prompt + '\r')` in one write, which the TUI can swallow while it's still painting the input field.

The frontend's `sendTerminalCommand` already does this correctly: write the text, wait 100ms, then write `\r` as a separate message. Mirroring that on the backend.

New `sendPromptToSession(sessionId, prompt, { delay = 100 })` in `pty-manager.js`. Strips trailing `\r` from input, writes the text, awaits the delay, writes `\r`. Returns false if the session went away between the two writes. `dispatchClaude` now calls this instead of doing the concatenated single write.

`writeToSession` stays unchanged - it's still the raw byte writer. Anything that needs the "send a prompt to Claude" semantic should use `sendPromptToSession`.

## 2026-05-04 - Rules: bulk fire ("run for all matching") via API, MCP, and UI

The "I want auto-rebase to fire on all 12 conflicted PRs right now, without manually arming each one" use case. New `POST /api/rules/:id/run-all` endpoint scans every PR, applies the rule's `where` clause as a filter, and fires the rule against each match.

Body knobs:
- `subscribe: true` - when the rule has `requires_subscription`, auto-subscribe matching PRs first. Combined with `one_shot: true`, this becomes "one-time fire on every match"; subscriptions are consumed on success.
- `force: true` - bypass cooldown AND the subscription gate. Use sparingly.

Fires are kicked off as fire-and-forget in parallel server-side - the endpoint returns immediately with `{ fired: [{pr_id, run_id}], skipped: [{pr_id, reason}] }`. Caller watches the existing `rule-run` SSE event for progress. `fireRule` now accepts a pre-assigned `ctx._id` so the bulk path can return run ids before the runs complete.

Same surface available from three places:
- HTTP: `POST /api/rules/:id/run-all`
- MCP: new `run_rule_for_all_matching_prs` tool (`ruleFireable: false` - admin only, no recursion)
- UI: "Run for all matching" button alongside the per-PR "Run now" button on PR detail. For requires_subscription rules the button asks "auto-subscribe and fire?" before submitting; otherwise just confirms cooldown still applies per-PR.

Refused for non-PR triggers (session.idle has no notion of "all matching") with a clear error.

Verified end-to-end: 19-PR repo, two rules. Default mode skipped one PR for cooldown and one for not_subscribed. `subscribe: true` auto-armed and fired the unsubscribed one. `force: true` bypassed cooldown and fired both. Run rows landed in the DB with the exact ids the endpoint returned.

## 2026-05-04 - Rules: three new PR triggers (mergeable.changed, labels.changed, draft.changed)

The poller has been emitting `pr-changed` events with `changes.mergeable`, `changes.labels`, and `changes.draft` since plan 17, but the rules engine only consumed `changes.ci_status`. This commit unlocks the rest.

Three new triggers in the `on` enum:
- `mergeable.changed` - fires when a PR's mergeable status transitions (MERGEABLE / CONFLICTING / UNKNOWN). Filter via `where: { mergeable: 'CONFLICTING' }` for the typical "auto-rebase on conflict" case.
- `labels.changed` - fires when labels are added or removed. Combine with `where: { labels: ["foo"] }` to fire only when the post-change label set still contains the target.
- `draft.changed` - fires on draft to ready transitions and back.

All three are PR triggers (carry pr.id, support the same `where` fields as `ci.finalized`). The schema is generalized via a `PR_TRIGGERS` set so adding more later is one entry. `requires_subscription`, `manual`, `one_shot`, and the cooldown machinery all work uniformly across PR triggers.

`handlePrChanged` now collects matched triggers into an array and dispatches each rule whose `on` is in the set. A single `pr-changed` event with multiple changed fields can fire multiple rules in one tick.

Frontend `RuleControls` shows rules for any PR trigger now, not just `ci.finalized`. Empty-state messaging updated to match.

User config gets the auto-rebase-on-conflict rule alongside auto-retrigger-on-fail. Both are `requires_subscription: true, one_shot: true`.

Verified end-to-end: a `mergeable.changed` rule with `requires_subscription` correctly fires only for subscribed PRs and only when the new mergeable value matches the where clause. `trigger: 'mergeable.changed'` populated correctly on the rule_run row.

## 2026-05-04 - Rules: one_shot flag consumes subscription on success

Adds a `one_shot: true` rule field. When a one-shot rule auto-fires successfully, the underlying `rule_subscriptions` row is deleted automatically - the next trigger won't fire for that PR until the user clicks Arm again. Failed runs leave the subscription alone so the next trigger gets another shot.

Schema rejects `one_shot` without `requires_subscription` (the subscription is what gets consumed) and surfaces it via a clear field-path error at load time.

UI tweaks: when a one-shot rule is currently armed, the badge reads `"Armed (fires once)"` and the button reads `"Arm"` instead of `"Subscribe"`. After the rule fires and the subscription is consumed, the panel live-refreshes via the `rule-run` SSE event - the badge flips to `"Not subscribed"` without the user needing to reload.

Verified end-to-end: a one-shot rule with a subscribed PR fires once on the next matching transition (rule_run row goes from `running` to `success`), the subscription disappears (`/api/rules/:id/subscriptions` returns `[]`), and the dashboard log carries `[rules] one_shot consumed subscription: rule=... pr=...`.

## 2026-05-04 - Per-PR rule scoping: manual flag and local subscriptions

Two opt-out paths for rules so they don't fire on every matching PR by default. Both stay local to patrol's DB - no GitHub state involved.

`manual: true` (rule field) disables auto-fire entirely. The rule still loads, validates, and shows up in `GET /api/rules`, but the only path to fire it is `POST /api/rules/:id/run`. Used for templates you fire deliberately.

`requires_subscription: true` (rule field) gates auto-fire on a per-PR opt-in. New `rule_subscriptions(rule_id, pr_id, created_at)` table stores the subscriptions. The auto-fire path checks `isSubscribed(rule.id, pr.id)` between the where match and the cooldown check. Schema rejects `requires_subscription` on `session.idle` triggers (sessions are ephemeral, no stable key to subscribe by) and rejects the `manual + requires_subscription` combo as redundant.

Three new API endpoints: `POST/DELETE /api/rules/:id/subscribe` with `{pr_id}` body, `GET /api/rules/:id/subscriptions`, plus `GET /api/prs/:pr_id/rule-subscriptions` for the cross-lookup the PR detail UI needs. Subscribe checks that the rule exists and has `requires_subscription: true`, that the PR exists in the DB, and uses `INSERT ... ON CONFLICT DO NOTHING` so it's idempotent.

UI: a new `RuleControls` component shows up on the PR detail view between the Workspace section and the terminal. Lists every `ci.finalized` rule with its scope status (Subscribed / Not subscribed / Auto on all / Manual only). For `requires_subscription` rules, a Subscribe/Unsubscribe button toggles the row. For all of them, a "Run now" button fires the rule manually with `force=true` (bypass cooldown). Five frontend API helpers wired through the existing pattern.

Verified end-to-end: a `requires_subscription` rule does NOT fire when its PR is unsubscribed (count of rule_runs stays 0 after a simulated CI transition), and DOES fire after subscribing (count goes to 1, status `success`). Schema correctly rejects the bad combinations. Frontend builds clean.

This closes the "I don't want these to run willy-nilly" gap from the open-ended discussion. Combined with the `auto-retrigger-on-fail` example rule in the README, the typical workflow is: write the rule once, subscribe specific PRs from the dashboard, the rule retriggers their failed checks automatically.

## 2026-05-04 - Rules engine second review pass: bad link, listener cap, dead code

Follow-up after a fresh review of the merged engine + UI. Four small fixes.

`DashboardSummary.RuleItem` linked to `#/session/<session_id>` for runs that had a session attached, but no such hash route exists in the frontend (only `#/pr/...` and `#/workspace/...`). Clicking just appended a stale URL fragment with no view change. Replaced with `#/pr/<pr_id>` when a PR is set, else `#/workspace/<workspace_id>` - sessions are viewable nested inside those views anyway.

`appEvents` and `pollerEvents` now call `setMaxListeners(0)`. Each `/api/events` SSE connection adds one listener per forwarded event type; with 6 forwarded events, the default cap of 10 starts warning around 10 dashboard tabs. The cap was preventive noise, not a real leak guard - request-close handlers still detach listeners, so memory hygiene still works.

`cooldownOk` no longer takes a `force` parameter (always called from paths that already short-circuit when the user passes `force=true`) and no longer falls back via `?? 10` (the zod schema's `.default(10)` already applies, so a validated rule always has the field set).

`cooldown_key` is now stripped from the public face of `rule_runs` - SSE payloads, `GET /api/rules/runs` results, and the manual-run POST response. It's an internal cooldown-bucket hash, not something dashboard consumers should see or rely on. A small `toPublic(row)` helper centralizes the projection.

Verified: server boots cleanly, `/api/rules/runs` no longer carries `cooldown_key` (grep returns 0 matches in the response), frontend builds cleanly, max-listener counts read as `0` (uncapped) on both emitters.

## 2026-05-04 - Rules engine review pass: enum constraints, mid-flight events, UI

Follow-up to the rules engine commit, addressing the gaps surfaced in review.

`ci_status` and `mergeable` fields in `where` predicates now constrain to enums (`pass`/`fail`/`pending` and `MERGEABLE`/`CONFLICTING`/`UNKNOWN`). A typo'd `"success"` is now rejected at rule load time with a field-path error instead of silently never matching. Same shape works as a scalar or array.

`dispatchClaude` now emits `rule-run` SSE events after each in-flight update (workspace assignment, session assignment), not just at start and end. The dashboard panel can now show what the rule is actually doing while it runs. Persisted rows update in lockstep via a small `updateRunRow(runRow, patch)` helper.

`cooldown_key '*'` fallback removed from both `handleSessionIdle` and `manualRunRule` for `session.idle` triggers. v1 always has a `sessionId`, so the fallback was unreachable.

`trigger_sync` registry entry no longer sends a `body: {}` - matches the original tool's wire format (no body, no content-type header). Same change applied to the `/api/sync/trigger` calls inside `wait_for_checks`'s mcpHandler.

`formatPR` import in `rules.js` is now static, dropping the `await import('./pr-status.js')` cargo-cult inside `manualRunRule`.

UI surface landed: `frontend/src/hooks/useRuleRuns.js` mirrors `useTasks` (initial fetch + SSE `rule-run` subscription, sorted with running first, 30min completed-TTL). `DashboardSummary` gets a "Rules" dropdown next to "Tasks" - shows rule count, running count, recent runs, and bad-rule entries with their error message. Run items link to the resulting session transcript when `session_id` is set, or the PR detail view when `pr_id` is.

TUI surface: each rule load error is now logged via `console.warn`, which the existing TUI patches to render as a `WRN` line in the log panel. The dashboard's bad-rule entries carry the same content for users not in the terminal.

README has a new `## Rules` section: example config, trigger reference, predicate field table with valid values, action types, lifecycle (cooldown, live-reload, restart reconciliation), known limitations, and the manual-fire endpoint.

End-to-end re-verified after the changes: enum rejection works (`ci_status: "success"` shows up as a `where.ci_status: Invalid input` error in `GET /api/rules` and as a `WRN` line in the server log), mid-flight `rule-run` events fire as actions progress, frontend builds cleanly with the new hook and panel, manual fire still works against a real failing PR.

## 2026-05-04 - Rules engine: declarative reactions to PR-state transitions

Lands the feature the five precursors were paving the way for. Rules live in `config.json` under `"rules": [...]`, each with `id`, `on` (`'ci.finalized' | 'session.idle'`), optional flat `where` predicate, and a sequential `actions` chain. Two action types: `mcp` (any rule-fireable tool from the actions registry) and `dispatch_claude` (resolves the PR's workspace, spawns Claude if no session exists, waits for the first `'idle'` via `waitForFirstIdle`, then writes `prompt + '\r'` through `writeToSession`).

Triggers come from the precursors directly: `ci.finalized` is derived from a `pr-changed` event with `changes.ci_status.to ∈ {'pass', 'fail'}` (plan 17 emits these), and `session.idle` is just the existing `appEvents 'session-state'` filtered to `state === 'idle'`. No internal cache, no warmup pass, downtime transitions caught for free because `prev` lives in the DB.

Validation is per-rule via zod with `.superRefine` for cross-field checks: rejects `dispatch_claude` on `session.idle` triggers (loop trap), rejects `mcp` actions targeting unknown tools, mcp-only tools, or `ruleFireable: false` tools. Bad rules surface in `getRuleLoadErrors()` without blocking valid ones - the existing config-reload path stays simple because `cfg.rules` is a passthrough.

Persistence: new `rule_runs` table indexed by `(rule_id, cooldown_key, started_at)`. Cooldown bucket is `pr_id ?? session_id ?? workspace_id` (in v1 every trigger has at least one). On startup, stale `'running'` rows reconcile to `'error'` with `error: 'server_restarted'`. The `appEvents 'rule-run'` event piggybacks on plan 14's array-driven SSE registration as a one-line addition.

API: `GET /api/rules`, `GET /api/rules/runs?limit&rule_id&pr_id`, `POST /api/rules/:id/run` with `{pr_id?, session_id?}` body and `?force=true` for cooldown bypass. The manual route synthesizes the same `predCtx`/`tmplCtx` shapes the trigger handlers produce.

Verified end-to-end against the real server: a config with one valid rule + two invalid rules (`list_prs` as mcp action, `dispatch_claude` on `session.idle`) loads with 1 rule active and 2 errors visible in `GET /api/rules`. A `pr-changed` event flowing from a simulated CI transition fires the rule automatically. Manual `POST /api/rules/:id/run` works against a real PR, persists the run row, and `trigger_sync` action runs successfully end-to-end.

Templating substitutes `{{pr.<field>}}` and `{{session.<field>}}` recursively over both `prompt` strings and `mcp` `args`. Substitution runs **before** zod validation of args so a missing field collapses to empty string and the schema check produces a clear error rather than passing the literal `{{...}}` through.

Frontend hook + dashboard panel deferred for a follow-up - the API is the contract, the UI is a thin consumer.

## 2026-05-04 - Poller emits pr-changed events with field-level diff

Precursor to plan 18 (rules engine). The poller already does `INSERT OR REPLACE` for every PR each cycle, but the only signal downstream consumers got was a coarse `'sync'` event with a count. The rules engine needs to know *which* PRs transitioned and on *what* fields. Without poller-side diffing, every consumer would have to maintain its own in-memory cache and a warmup pass to avoid spurious initial fires - and downtime transitions would still be lost.

`upsertPRs` now SELECTs the prev row inside the transaction, runs the upsert, computes a diff against a fixed watched set (`ci_status` derived via `deriveCIStatus`, `mergeable`, `labels` as added/removed sets, `draft`), and buffers a `{ id, prev, changes }` entry per changed PR. After the transaction commits, each entry is re-read via a new `getPrById` prepared statement and run through `formatPR` before emitting `pollerEvents.emit('pr-changed', { pr, prev, changes })`. New PRs (no prev row) emit nothing - that's initial state, not a transition.

Two correctness rules: SELECT inside the transaction (no race between read and write), emit only after COMMIT (a rolled-back upsert must not fire events for changes that didn't persist).

The rules engine becomes a stateless consumer: no cache, no warmup. Downtime transitions are caught for free because `prev` comes from the DB, which retains pre-shutdown state. Verified end-to-end by mutating a known-pass PR's `checks` JSON to non-final and triggering a sync - exactly one `pr-changed` fired with `{ci_status: {from: 'pending', to: 'pass'}}`.

`'sync'` event keeps firing as before. `pr-changed` is internal-only; no SSE bridge in v1.

## 2026-05-04 - Replace hand-rolled config validation with zod schema

Precursor to plan 18 (rules engine). `src/config.js` had a hand-rolled `validate(cfg)` that walked a `REQUIRED_FIELDS` table, asserted types per field, and ran `OWNER_REPO_RE.test(...)` over each `poll.repos` entry. Errors were one-line strings. Adding `rules` would mean another nested validator block in the same file, which conflicts with how the rules engine wants to validate its own array per-rule.

The new `configSchema` is a top-level zod object with `.passthrough()` so unknown sections survive untouched. `cfg.rules` (and any other future passthrough section) lands in the loaded config without being centrally validated, which keeps the `watchConfig` reload path tolerant: a single bad rule no longer rejects the entire config. `loadConfig` runs `configSchema.safeParse`, formats the issue list with field paths, and throws a multi-line error on failure. Defaults move into the schema; path expansion over `PATH_FIELDS` and `Object.freeze` stay where they were.

The `repos` schema declares `symlinks` as `z.array(z.string()).optional()` to match how `src/workspace.js` actually consumes the field. The plan example showed `{source, target}` objects; the real code reads relative paths.

Verified parity by loading the existing user config before and after. Same keys, same values, same defaults filled in. Passthrough confirmed by injecting `rules: [{ id: "x" }]` into the config and observing it round-trip through `loadConfig`. Server boots cleanly on a scratch port with the new validator.

## 2026-05-04 - Refactor SSE registration to be array-driven

Precursor to plan 18 (rules engine). The `/api/events` SSE handler in `src/server.js` used to register each forwarded event by hand. Five event types meant five handler definitions, five `.on(...)` calls, and five `.removeListener(...)` calls on close. Adding a sixth (`rule-run` for the rules engine) would mean three more boilerplate sites for a one-line change in intent.

A new module-level `SSE_EVENTS` array now drives registration. Each entry is `{ name, emitter, payload? }`. The `payload` transformer is optional and only `local-change` uses it, since that event emits a constant `{}` regardless of producer args. The handler loop `.map`s over the array on connect, the close handler iterates the same list to unsubscribe.

Pure refactor. Same event names, same payload shapes, same replay-on-connect for `session-state` and `gh-rate-limit`. Verified by booting the server on a scratch port and confirming a fresh SSE connection still receives the `gh-rate-limit` snapshot.

## 2026-05-04 - Expose writeToSession and waitForFirstIdle from pty-manager

Precursor to plan 18 (rules engine). The rules engine needs to inject prompts into a freshly-spawned Claude session from server-side code, so two PTY-state primitives move out of the WebSocket handler into named exports.

`writeToSession(sessionId, text)` lifts the existing `entry.proc.write(...)` call out of the WS `'input'` handler so non-WS callers can write raw text to a session's PTY. Returns `false` if the session is not in the active map. The WS handler keeps its own special-case path for kitty CSI-u sequences via `tmux send-keys` - that's irrelevant for server-side prompts.

`waitForFirstIdle(sessionId, timeoutMs)` subscribes to the `session-state` event on `appEvents` and resolves on the first `'idle'` payload for the given session. If the session is already idle, it resolves immediately. Rejects if the session exits, isn't found, or the timeout elapses (default `BOOT_TIMEOUT_MS_DEFAULT = 30_000`). The rules engine will use this to wait for Claude to finish booting before writing a prompt - writing too early would dump the text into the boot screen and lose it.

`appEvents` is now imported alongside `emitSessionState` from `./app-events.js`.

## 2026-05-04 - Extract MCP tool dispatch into a shared registry

Precursor to the rules engine. Each MCP tool used to be a hand-written `server.tool(...)` wrapper containing both the schema and the argument-to-`app.inject()` translator. The rules engine needs the same dispatch logic addressable by tool name, so the per-tool metadata moves into `src/actions.js` as `actionRegistry`. `src/mcp-server.js` becomes a thin loop over the registry.

Each entry has either a simple `dispatch(args) -> { method, path, body? }` (the rules-callable path) or an `mcpHandler(app, args) -> result` (for tools that need pre-call validation, multi-call composition, or filesystem reads). `retrigger_checks` carries both: rules see the simple POST, MCP runs the `require_all_final` pre-check first. Tools without a `dispatch` (`get_session_history`, `get_session_transcript`, `wait_for_checks`) are MCP-only by design.

`ruleFireable` flag rejects read-only tools (`list_*`, `get_*`) at the rule layer; `invokeAction` enforces it. `summarizePR` moves to `actions.js` next to the `list_prs` entry that uses it via `transform`. Behavior preserved end-to-end: all 15 tools still register, every tool I spot-checked through the MCP transport returns the same shape as before.

## 2026-05-03 - Remove the workspace summarizer entirely

The recap-based summarizer from earlier today was already a thin wrapper, but even that's gone now. No more workspace-level summary panel anywhere - users who want a recap can run /recap inside their session and read it in the terminal directly. Eliminating the feature also retires the SSE event, the MCP tools, the route, the pty-manager idle timer, and a fair amount of dead transcript-parsing code that had been left in place pending exactly this decision.

Removed:
- `src/summarizer.js` deleted.
- `getWorkspaceConversationText`, `extractConversation`, and `getLatestAwaySummary` (added yesterday) gone from `src/transcripts.js`. `parseTranscript`, `findSessionJsonl`, `archiveTranscript`, `claudeProjectDirForWorkspace`, `resolveSessionJsonlPath`, and `getOrCreateTranscriptSummary` stay - the session-history route still uses them.
- `summaryTimer`, `SUMMARY_IDLE_MS`, and the three idle/exit timers calling `scheduleSummary` removed from `src/pty-manager.js`. Idle detection itself stays (still drives session-state SSE).
- `emitSummaryUpdated` removed from `src/app-events.js`; the `summary-updated` SSE event removed from `src/server.js`.
- `POST /api/workspaces/:id/summarize` route removed.
- `summarize_workspace` and `get_workspace_summary` MCP tools removed.
- `generateWorkspaceSummary` API helper, `SummaryMarkdown` + `formatInline` renderers, the entire summary section in `WorkspaceDetail.jsx`, the `summary-updated` SSE listener, the `summaryPreview` row in `ScratchWorkspaces.jsx`, and the corresponding CSS classes (`summaryHeader`, `summaryContent`, `summaryHeading`, `summaryParagraph`, `summaryList`, `summaryCode`, `summaryMeta`, `summaryEmpty`, `refreshBtn`, `summaryPreview`).

Schema-side: `workspaces.summary` and `workspaces.summary_updated_at` columns stay on existing DBs but are no longer added to fresh ones. Dropping a column in SQLite is destructive and not worth the migration friction; the columns are dead data on old DBs and will eventually wash out.

PR-side summary generation (`generatePRSummariesBatch` in `src/poller.js`) is unaffected. That's a separate path summarizing PR descriptions from GitHub - not touched here.

## 2026-05-03 - Workspace summaries from Claude's own /recap, scratch-only

The workspace summarizer used to call `claude --print --model haiku` with up to 80KB of transcript text on every idle, debounced and content-hashed. It now scans the JSONL transcripts for the most recent `{type: "system", subtype: "away_summary"}` entry - Claude Code's own /recap output - and writes its content verbatim into `workspaces.summary`. Zero Haiku calls, zero prompt engineering, higher-quality output (the recap was generated by the in-session model for the user's own consumption rather than by an outside summarizer).

Coverage trade-off acknowledged: only ~18% of patrol-workspace transcripts on this machine currently carry a recap (Claude Code only emits `away_summary` after ~75min idle gaps or an explicit `/recap`). Sessions that never trip that threshold show "No recap yet. Run /recap inside the Claude session to generate one." The Refresh button now picks up the latest recap from disk instead of triggering a model call.

Storage and rendering scoped to scratch workspaces (`pr_id IS NULL`). PR-bound workspaces draw their context from the linked PR; the summary panel is hidden in `WorkspaceDetail` and the route returns 400 if you try to summarize one. Existing summary rows on adopted workspaces are left in the DB but not refreshed or rendered.

Code-wise: `summarizer.js` shrinks from a Haiku-driven incremental updater (debounce, content hash, `runTask` integration, prompt builder) to a thin wrapper around `getLatestAwaySummary` in `transcripts.js`. The transcript-extraction path (`getWorkspaceConversationText`) is no longer used anywhere and could be removed in a follow-up; left in place for now in case other callers appear.

## 2026-05-03 - Cut Claude + gh spend across summary, diff, log, and prompt paths

Five structural changes that reduce both Claude API and gh API costs. None of these change observable behavior in normal use; they trim work that was being repeated unnecessarily.

1. **Batched PR summaries.** The poller used to fan-out one `claude --print --model haiku` process per PR with a changed body. On a fresh sync that was N spawns for N open PRs. Now `generatePRSummariesBatch` collects them into chunks of 20 and asks Haiku to emit `### <id> ###`-delimited one-line summaries in a single call. One spawn replaces N spawns; the prompt overhead amortizes across the batch. Steady-state cycles with 0-3 changed bodies still work fine through the same code path.

2. **Workspace summary skips trivial deltas.** `generateSummary` already debounces 5 minutes and content-hashes the new transcript text. It now also skips *incremental* updates when the new text is shorter than 500 chars - a brief prompt + reply doesn't shift the executive summary enough to justify a Haiku call. First-time summaries still run regardless of size.

3. **`/api/prs/:id/diff` cached for 60s by `updated_at`.** Same pattern as the comments cache. Detail-view click-thrash on a stable PR no longer re-pulls up to 100KB per click. Separate cache maps for full and name-only since the frontend asks for both.

4. **Failed-job logs cached for the process lifetime by job id.** Logs for completed/failed CI jobs are immutable - the conclusion is final, the bytes don't change. The check-logs route now consults a 200-entry FIFO cache keyed by `${org}/${repo}/${jobId}` before paying for the multi-megabyte fetch. Re-opening a failed PR's detail panel becomes a pure DB lookup after the first fetch.

5. **Patrol system prompt trimmed from 6.9KB to 2.1KB.** Roughly 70% of the prompt was duplicating what the MCP tool descriptions already say (when to call `list_prs`, what `get_pr_diff name_only` does, how `retrigger_checks` matches names, etc.) or giving Claude generic advice it already has (how to launch parallel subagents, that subagents don't see parent context). The trimmed prompt keeps only what the tool layer can't carry: jj-vs-git invariants, the bookmark-after-rebase rule, main/master protection, the "complete the rebase end-to-end" intent, the subagent permission posture (`bypassPermissions`), and the "ask before destroying workspaces" preference. Every byte saved here gets paid back on every message in every PTY-spawned Claude session, so this is the single highest-leverage Claude-cost change in this batch.

## 2026-05-03 - Cut gh API load on the poll path

Five changes to the polling layer that together drop steady-state gh API usage by something like an order of magnitude for typical multi-org users:

1. **Skip the cycle while rate-limited.** `pollOnce` now bails early when `getGhRateLimitState()` says we're limited and a known reset is still in the future. Without a known reset we still attempt one call per interval so we can detect recovery and re-fetch the reset window. Stops the loop from re-tripping a secondary rate limit by hammering an already-throttled token.

2. **Drop `bodyHTML` from the poll query, fetch lazily.** `bodyHTML` is large and only used on the detail view. It's now omitted from the bulk search query and fetched on first detail-view open via a small per-PR query (`fetchPRBodyHtml`), then cached in the existing `body_html` column. The cache is invalidated in the poller whenever the plain `body` changes - if the description is the same the previously-rendered html is still valid.

3. **`sort:updated-desc` + early termination.** The search query is now sorted newest-first, and `fetchPRs` stops paginating as soon as a page's oldest PR is older than `max(stored updated_at) - 60s`. For users with one open page of PRs this is a no-op; for users with many open PRs it turns multi-page polls into single-page polls in the steady state.

4. **One search per cycle instead of one per target.** Multiple `org:` / `repo:` qualifiers are OR'd by GitHub search, so all configured targets fold into a single GraphQL call per cycle. Results are split back to per-org / per-repo buckets in JS for stale-row cleanup. For an N-org user that's N calls collapsed to 1 every 600 seconds.

5. **In-memory cache for `/api/prs/:id/comments`.** Three paginated REST calls fired on every detail-view open before; now keyed by `pr_id` + `updated_at` with a 60s TTL and a 200-entry cap. Click-thrashing across PRs no longer hits the API.

#3 and #4 cooperate: when an incremental cycle terminates early it didn't see all open PRs, so stale-row cleanup is skipped that cycle. A full sweep is forced at least every 30 minutes (and on target-set changes) to keep cleanup correct.

## 2026-05-03 - Surface gh rate-limit state in the UI

Five changes to the polling layer that together drop steady-state gh API usage by something like an order of magnitude for typical multi-org users:

1. **Skip the cycle while rate-limited.** `pollOnce` now bails early when `getGhRateLimitState()` says we're limited and a known reset is still in the future. Without a known reset we still attempt one call per interval so we can detect recovery and re-fetch the reset window. Stops the loop from re-tripping a secondary rate limit by hammering an already-throttled token.

2. **Drop `bodyHTML` from the poll query, fetch lazily.** `bodyHTML` is large and only used on the detail view. It's now omitted from the bulk search query and fetched on first detail-view open via a small per-PR query (`fetchPRBodyHtml`), then cached in the existing `body_html` column. The cache is invalidated in the poller whenever the plain `body` changes - if the description is the same the previously-rendered html is still valid.

3. **`sort:updated-desc` + early termination.** The search query is now sorted newest-first, and `fetchPRs` stops paginating as soon as a page's oldest PR is older than `max(stored updated_at) - 60s`. For users with one open page of PRs this is a no-op; for users with many open PRs it turns multi-page polls into single-page polls in the steady state.

4. **One search per cycle instead of one per target.** Multiple `org:` / `repo:` qualifiers are OR'd by GitHub search, so all configured targets fold into a single GraphQL call per cycle. Results are split back to per-org / per-repo buckets in JS for stale-row cleanup. For an N-org user that's N calls collapsed to 1 every 600 seconds.

5. **In-memory cache for `/api/prs/:id/comments`.** Three paginated REST calls fired on every detail-view open before; now keyed by `pr_id` + `updated_at` with a 60s TTL and a 200-entry cap. Click-thrashing across PRs no longer hits the API.

#3 and #4 cooperate: when an incremental cycle terminates early it didn't see all open PRs, so stale-row cleanup is skipped that cycle. A full sweep is forced at least every 30 minutes (and on target-set changes) to keep cleanup correct.

## 2026-05-03 - Surface gh rate-limit state in the UI

When the `gh` CLI hits a rate limit during polling, the poller used to log the error and the next sync just looked stuck. Nothing told the user why PRs stopped updating. The poller now sniffs both REST stderr ("API rate limit exceeded", "exceeded a secondary rate limit") and the GraphQL response shape (`errors[].type === "RATE_LIMITED"`), records a server-wide rate-limit state, and emits a new `gh-rate-limit` event on the existing app event bus. On detection it also fires a one-shot `gh api rate_limit` lookup (that endpoint is exempt from rate limiting per GitHub) to get the reset timestamp; once the next gh call succeeds the state clears and a follow-up event is emitted. The SSE stream broadcasts the event and replays the current state on connect, so a fresh tab knows it's throttled. AppShell renders a red banner above the existing update banner with the `gh` error text and a live "resets in Xm Ys" countdown when known. Rate-limited errors no longer trigger the retry+backoff loop in `ghGraphql` - they fail fast via a dedicated `RateLimitedError` so we don't waste three more attempts on something that won't recover for minutes.

## 2026-05-03 - "Rebase onto X" quick-action: resolve conflicts and push on green

The "Rebase onto $base" button in `QuickActions` only told Claude to fetch and run `jj rebase -d <base>@origin`. If the rebase landed cleanly it was fine, but with conflicts Claude would stop after marking them and never push, leaving the user to finish by hand. Extended the button's command string to spell out the rest of the flow: resolve any conflicts via `jj status` + edit + `jj squash` (without pausing to ask), run the project's test suite, then move the bookmark and `jj git push` only if tests pass. Failing tests halt before the push and get reported instead.

## 2026-04-30 - Restart-via-wrapper-loop instead of detached respawn

Clicking "Restart now" in the web UI left the TUI broken when running interactively under `pnpm start`. The old flow rebuilt the frontend, called `destroyTui()`, spawned a `detached: true` child with `stdio: 'inherit'`, then `process.exit(0)` after 500 ms. The fatal step was the parent exiting: `pnpm` saw its child die and exited too, so the user's shell reclaimed the terminal and started drawing its prompt while the orphaned new node process - in its own session, no controlling TTY - tried to render a TUI on top of it. Two processes fighting for the same terminal, raw mode toggling between them, stdin going to the shell. Looked "borked" because it was.

Fix: keep the foreground process group alive across the restart. `pnpm start` now ends in `bash scripts/start-loop.sh`, a tiny while-loop that runs `node src/index.js`, and on exit code 42 adds `--reattach` and runs again. `restartServer()` no longer spawns anything - it builds the frontend, tears down the TUI, and `process.exit(42)`. The wrapper holds the TTY the whole time, so the shell never gets a chance to draw a prompt mid-restart. Watch mode (`src/watch.js`) supervises its child differently but had the same exit-code gap, so it now treats 42 as "relaunch with --reattach" too.

Port stickiness used to ride on `restartServer()` passing `--port <currentPort>` to the spawned child so the in-process MCP URL stayed valid. With the wrapper there's no good way to pass that. Instead, `startServer()` now treats `--reattach` without an explicit `--port` as a signal to read the previous instance's port from the PID file and pin to it (sticky-retry through the overlap window) - same end result, simpler chain of custody.

## 2026-04-30 - Maximized terminals leave the app header visible

Maximizing a terminal (TerminalCard overlay or GlobalTerminal drawer) used `fixed inset-0`, which painted over the AppShell header and stranded users on whatever page the terminal was attached to - the only way back to the dashboard was Escape, Cmd+Enter, or the Restore button. Cheap fix: the overlay now starts below the header instead of at the top of the viewport. AppShell measures the actual header element with a ResizeObserver and publishes its height as a `--app-header-height` CSS variable on `<html>`, which the two overlay rules (`shared.terminalOverlay`, `GlobalTerminal.maximized`) read via `top: var(--app-header-height, 0px)`. ResizeObserver instead of a hardcoded number so the update banner / future header changes don't require a CSS edit.

## 2026-04-30 - In-process HTTP MCP server, port-stable restarts

The patrol MCP server was a stdio child of every Claude session. With 10-20 active sessions that meant 10-20 `node mcp-server.js` processes, each holding ~30-50 MB and a frozen `PATROL_PORT` env var captured at spawn time. After a Patrol restart on a different port, every existing child kept fetching the old port, every tool call returned `ECONNREFUSED`, and `/mcp` still showed "connected" because the stdio child itself was alive. Hard to diagnose, easy to misread as "Claude can't connect."

Replaced the stdio shape with an in-process HTTP MCP endpoint mounted at `POST /mcp` in the Patrol Fastify app. `src/mcp-server.js` now exports `createMcpServer(app)` which builds an `McpServer` whose tool handlers call routes via `app.inject()` instead of HTTP loopback. The new MCP config writes `{type: "http", url: "http://127.0.0.1:<port>/mcp"}`, so spawned Claude sessions connect to the live Patrol server directly. One server, no extra processes, no port to go stale.

Restart needed two follow-ups: the URL still embeds the port, so a Patrol restart on a different port would invalidate every running Claude session's MCP config. `restartServer()` now reads the current port from the PID file and passes `--port <currentPort>` to the spawned `--reattach` instance, and `startServer()` treats an explicit `--port` as sticky - retrying the same port for up to 5 seconds across the overlap window with the dying old process instead of bumping. tmux session reattach is unchanged; what's new is that the MCP endpoint comes back at the same URL the existing sessions are already calling.

Verified end to end: HTTP probe lists 17 tools and round-trips `list_prs` and `list_workspaces`; 10 concurrent clients complete in 76 ms total against a single Patrol server; Claude with the new HTTP config calls `mcp__patrol__list_workspaces` and returns the right count; killing a server while a sticky-port replacement is starting takes ~2 s for the new instance to bind, after which MCP responds normally.

## 2026-04-30 - Remove stale root `public/` and ignore it

The repo had an untracked `public/` folder at the project root with hashed Vite build artifacts (`assets/index-*.js`, `assets/index-*.css`) from late April. Nothing serves it: `src/server.js` registers `@fastify/static` against `frontend/dist`, and Vite's source assets live at `frontend/public/`. The root folder was leftover from an earlier layout where build output landed there. Deleted it and added `/public/` to `.gitignore` so a stray build can't recreate the confusion.

## 2026-04-29 - Don't pause mid-rebase to ask about conflicts

A rebase session ended with the subagent saying "Your scoped instruction was just fetch + rebase, so I stopped here. Want me to resolve the conflicts and continue, or leave the workspace in this state for manual inspection?" - which is the wrong default. A user asking to rebase a CONFLICTING PR is asking for the conflicts to be resolved; pausing to ask defeats the entire point. Tightened the rebase section of `patrol-system-prompt.md` to spell out that "rebase the PR" includes conflict resolution and that the model should only stop on genuinely ambiguous conflicts (and even then propose a resolution rather than asking open-ended). Updated the parallel-rebase subagent example to match - the previous version put conflict handling in a trailing "if there are conflicts" sentence after a single `&&`-chained command line, which read as optional cleanup rather than part of the job.

## 2026-04-29 - Fix retrigger_checks substring filter against workflow-prefixed names

A real session showed Claude run `wait_for_checks`, see "2 failed (both smith-bench)", call `retrigger_checks(check_name: "smith-bench")`, and get `retriggered: 0` back - then fall back to retriggering without the filter. Root cause: DB check names come from GraphQL via `extractChecks` which prefixes with the workflow name (`"smith-bench / @adobe/css-tools@4.4.4"`), but `fetchFreshFailedChecks` returns raw GitHub REST names with no prefix (`"@adobe/css-tools@4.4.4"`). The retrigger handler only filtered against REST names, so a workflow-name substring matched zero entries even though `get_pr`/`wait_for_checks` showed the prefixed form. The handler now filters against both name sources (preferring REST when it matches, falling back to DB) and, when the substring matches nothing, returns `available_failed_checks` listing every failed check name plus a hint pointing at the matrix-variant naming quirk - giving Claude enough info to self-correct without an extra round-trip. Updated the MCP tool description and `patrol-system-prompt.md` to call out the dual matching surface and the recovery path.

## 2026-04-29 - Wrap remaining async ops as tasks

Extended task tracking to the four candidates noted in the previous entry: `summarizer.generateSummary`, `POST /api/workspaces/cleanup`, `createWorkspace` / `createScratchWorkspace`, and `POST /api/sessions/:id/promote`. The summarizer wraps only the actual `claude --print` call (after debounce/no-content/hash-unchanged bailouts) so the dropdown only shows real work, not skipped runs. The cleanup endpoint creates a parent task labeled with the filter (e.g. "Cleanup 3 workspaces (ci=fail)") so bulk teardown is visible alongside the individual destroy children. Workspace create wraps the post-DB-insert work (jj init, jj add, init commands), keeping the existing rollback semantics on failure. Promote wraps the entire scratch-creation + jj squash + transcript copy + session resume flow as one task so the user sees progress for what is otherwise a multi-step background op.

Verified end to end: hitting `POST /api/workspaces/:id/summarize` against a real workspace produced a `task-update` running event, then a success event 13 seconds later, both with full context attached.

## 2026-04-29 - Tasks dropdown for async background ops

Added a small in-memory task registry (`src/tasks.js`) for surfacing long-running async operations to the UI: `createTask` / `completeTask` plus a `runTask(opts, fn)` wrapper that captures returned warnings and converts thrown errors into task errors. Tasks emit a `task-update` SSE event, and a new `GET /api/tasks` returns the current snapshot (running first, then most recently completed; pruned after 5 minutes or 50 entries). Wrapped `destroyWorkspace`'s post-mark cleanup in `runTask` so users see "Destroy <name>" with status (Running / Done / Warnings / Failed) and any collected warnings. The registry is observability-only and is not persisted - on restart, the slate is empty, which is fine since the underlying ops complete regardless.

Frontend: a `useTasks()` hook seeds from `/api/tasks` and merges in `task-update` SSE events. `DashboardSummary` shows a third `StatDropdown` next to workspaces and sessions ("N running tasks" or "N recent tasks"), hidden entirely when there are no tasks.

**Other candidates worth wrapping next, found while spelunking:** (1) `summarizer.generateSummary` - calls Claude haiku, runs auto on 5-min idle and on session exit, currently invisible; (2) `workspace.cleanup` (`POST /api/workspaces/cleanup`) which destroys multiple workspaces by filter and would benefit most from progress reporting; (3) `createWorkspace` / `createScratchWorkspace`, especially when `initCommands` runs `pnpm install` or similar; (4) `session.promote`, which moves a global session into a scratch workspace.

## 2026-04-29 - Unblock event loop during workspace destroy

Workspace destroy used `rmSync` with `recursive: true` to remove the workspace directory. For workspaces with `node_modules` or other large trees, that synchronous walk pinned the Node.js event loop for several seconds, so every other API request (including `GET /api/workspaces?type=scratch` from the dashboard) stalled. The dashboard appeared to "lose" scratch workspaces because the fetch couldn't return until destroy was finished. Switched `destroyWorkspace` and `rollbackWorkspace` to `rm` from `node:fs/promises` so the directory removal yields, and moved `emitLocalChange()` inside `destroyWorkspace` right after the DB row is marked destroyed - the UI now drops the workspace from active lists immediately rather than after filesystem cleanup completes.

## 2026-04-28 - Docker Compose cleanup on workspace destroy and rollback

Extracted a shared `dockerComposeDown` helper that both `destroyWorkspace` and `rollbackWorkspace` call. Previously, `rollbackWorkspace` didn't touch Docker at all, so if `initCommands` started a compose stack and a later step failed, containers were orphaned. The helper also falls back to project-name-based cleanup when the compose file is missing but containers still exist - Docker tracks projects independently of the file on disk.

## 2026-04-27 - Visual separation between multiple stack groups

When the PR table showed multiple stacks, they rendered as one continuous block - the purple left border ran unbroken across both stacks with only a nearly-invisible 2px/30%-opacity top border between them. Replaced the old `stackBoundary` border with a separator row that creates a clear visual gap between stack groups (and between stacked and non-stacked sections). Stack view toggle still correctly hides all stack visual treatment when off.

## 2026-04-23 - Markdown copy respects stacked PR grouping

The "copy as markdown" button now nests stacked PRs by depth when stack view is active. Each stack group is separated by a blank line, and child PRs are indented under their parents. Non-stacked PRs remain flat. When stack view is off, output is unchanged.

## 2026-04-22 - Summarizer: brief executive summaries instead of verbose reports

Replaced the structured multi-section summary prompt (Purpose/Key Decisions/Current State headers, 300 words) with a 1-3 sentence executive summary format. No headers, no bullets - just a plain paragraph a busy person can glance at.

## 2026-04-22 - Fix summarizer: drop --bare flag, add diagnostic logging

The summarizer was calling `claude --print --model haiku --bare` which fails with "Not logged in" because `--bare` strips authentication context. Removed the `--bare` flag so the CLI inherits the user's auth session. Also added console.log to every silent bail-out path in `generateSummary`, `scheduleSummary`, and `getWorkspaceConversationText` - previously all skip/failure conditions returned null with zero logging.

## 2026-04-21 - Branch stack detection and stack view

Added detection of stacked branches (where a PR's base branch is another open PR's head branch). Backend now fetches `baseRefName` from GitHub GraphQL, stores it as `base_branch` in the DB, and computes stack relationships (parent, children, depth, root) across all PRs in the same repo. The main PR table shows a git-branch icon next to stacked PRs, with tree-like indentation when stack view is active. A purple "Stacks" toggle in the filter bar reorders PRs so each stack appears grouped together (base first, children in depth order). The PR detail page shows a purple banner for stacked PRs with clickable links to parent and child PRs. All state (stack view toggle) persists in the URL hash.

## 2026-03-17 - Navigate back immediately on workspace destroy

Previously clicking "Destroy" blocked the UI on the workspace detail page until the full teardown completed (killing sessions, docker cleanup, jj forget, directory removal). Now the frontend navigates back to the homepage immediately and the destroy runs in the background. The workspace list shows up right away.

## 2026-03-17 - Filter TUI status-bar output from activity detection

Claude Code's own TUI status bar (PR status, update notifications) produces periodic pty output even when idle at a prompt. This caused false working->idle cycles that reset the "dismissed" state, making sessions flip from "Idle" to "Waiting" repeatedly. Fix: strip ANSI escape sequences and only count data events with >= 10 printable characters as activity moments. Also raised MOMENT_THRESHOLD from 2 to 3 and LARGE_OUTPUT from 150 to 500 to further reduce sensitivity to small updates.

## 2026-03-17 - Disable tmux status bar to fix false activity detection

Tmux's status bar refreshes every 15 seconds by default, producing terminal output that the activity detector interprets as real work. This caused dismissed "Idle" sessions to cycle through working -> idle, clearing the dismissal and showing "Waiting" again. Fix: set `status off` on every patrol tmux session at creation time (both `createSession` and `createResumedSession`), and also during reattach for sessions created before this fix.

## 2026-03-16 - Stack and Box layout components

Created Stack and Box components under `frontend/src/components/ui/`. Stack handles all flex+gap layout (horizontal/vertical, alignment, justification, wrapping). Box handles padding, borders, border-radius, and backgrounds - absorbing the recurring card/panel pattern. Migrated 32 files across the frontend, replacing ~42 pure-layout CSS classes with Stack elements, ~10 card/container classes with Box, and slimming ~20 mixed classes by extracting their flex+gap into Stack wrappers. Consolidated fractional gap values (gap-0.5, gap-1.5, gap-2.5) to whole numbers. Net result: ~170 lines of CSS deleted, layout intent expressed directly in JSX.

## 2026-03-16 - Button and Badge component library

Created reusable Button and Badge components under `frontend/src/components/ui/`. Migrated 30+ scattered button class definitions across 9 CSS modules to the shared Button component (supports size, variant, dark mode, filled mode). Migrated 15+ badge class definitions to the shared Badge component (supports 10 colors, optional border, pulse animation). Refactored StatusBadge to use Badge internally and deleted its CSS module. Net result: ~175 lines of CSS removed, ~50 lines of component code added.

## 2026-03-16 - Simplify idle/working detection

Rewrote the session activity tracking from scratch. Was: two boolean flags (`notifiedIdle`/`notifiedActive`), two SSE event types (`session-idle`/`session-active` with `exited` flag), three frontend Sets (`idleSessions`/`idleWorkspaces`/`workingWorkspaces`), plus dead code (`dismissIdle`, `idleSessions`). Now: single `state` enum (`'working'|'idle'`), single `session-state` SSE event, single `Map<workspaceId, state>` on the frontend.

Key behaviors preserved: 30s idle threshold, 200-byte burst detection to filter tmux status bar redraws, optimistic "Working" on reattach with idle timer correction, state cleared on SSE reconnect, idle badge suppressed when user is viewing the workspace.

## 2026-03-16 - Fix idle detection false positives

Guard idle badge with `has_session` so it only renders when there's a running session. Clear client-side idle state on SSE reconnect. Increase idle threshold from 5s to 30s. PRTable cell derives display from accessor's cached sort value.

## 2026-04-20 - Fix summarizer to discover all JSONL transcripts + MCP summary tools

**Summarizer bug fix:** `gatherNewTranscripts` previously only found JSONL files linked to DB-tracked sessions, missing any sessions started outside patrol (e.g. direct `claude` CLI usage in the workspace directory). Fixed to scan the entire Claude project directory for all `.jsonl` files, using DB sessions only as a supplementary source for archived transcripts that live outside the project dir. Files are sorted by mtime so older transcripts come first. For incremental updates, the mtime cutoff still applies - only files modified since the last summary are read.

**MCP tools:** Added `get_workspace_summary` (read the current summary for a workspace) and `summarize_workspace` (trigger generation/regeneration) to the patrol MCP server.

## 2026-04-20 - Auto-generated workspace summaries

Scratch workspaces now get continuously updated summaries of what has been discussed, planned, and implemented. Summaries are generated by calling `claude --print --model haiku --bare` with session transcript content piped via stdin.

**Triggers:** Summary generation fires after 5 minutes of continuous session idle and on session exit. Manual refresh available via API and UI button. If the session becomes active again during the 5-minute countdown, the timer is cancelled.

**Cost control:** Five layers prevent unnecessary API calls: (1) 5-minute idle threshold before triggering, (2) incremental transcript reading - only JSONL files modified since `summary_updated_at` are read, not the full history, (3) SHA-256 content hash skips the Claude call if new transcript content is identical to what was last processed, (4) 5-minute debounce between runs, (5) concurrency guard prevents parallel summarization for the same workspace. The prompt for incremental updates sends only the existing summary + new conversation text, not the entire conversation history.

**Conversation-only extraction:** The summarizer uses the shared `parseTranscript()` function (extracted from the transcript API route into `src/transcripts.js`) which parses JSONL, simplifies content blocks, and tags `isHuman` messages. The summarizer then filters to only genuine human messages and assistant text blocks - all tool_use, tool_result, thinking blocks, and system-injected user messages are dropped. This drastically reduces input tokens since a typical session is 90%+ tool calls by volume.

**Backend:** New `src/summarizer.js` module uses the shared transcript parser, builds a prompt with existing summary + only new conversation text, and spawns Claude in non-interactive mode. Results stored in new `summary` and `summary_updated_at` columns on the workspaces table. New SSE event `summary-updated` pushes changes to the frontend. New endpoint `POST /api/workspaces/:id/summarize` for manual trigger. Refactored `simplifyContent`, `parseTranscript`, `resolveSessionJsonlPath`, and `claudeProjectDirForWorkspace` out of `routes/sessions.js` into shared `src/transcripts.js`.

**Frontend:** Summary card displayed in WorkspaceDetail with markdown rendering (headings, bold, code, lists). Refresh button for on-demand regeneration. Summary preview snippet in ScratchWorkspaces list. Auto-updates via SSE.

**MCP:** Added `get_session_history` and `get_session_transcript` tools to the patrol MCP server.

## 2026-03-13 - Global terminal in cmd-k command palette

When the global terminal has an active session, it appears as a "Global Terminal" entry in cmd-k with a green "active session" pill. Selecting it opens/focuses the global terminal drawer. GlobalTerminal reports session state up via `onSessionChange` callback.

## 2026-03-13 - Filter escape-only PTY output from idle detection

Tmux sends cursor positioning, show/hide, status-line redraws, and OSC title sequences through the PTY even when nothing meaningful is happening. These escape sequences were resetting the idle timer and causing false idle/active cycling. Added `hasPrintableContent()` that strips ANSI escape sequences and only counts output as activity if printable characters remain.

## 2026-03-13 - Fix stale idle indicators + idle badge in PR table

Idle state was never cleared when sessions exited or were killed - `proc.onExit` cleared the timer but didn't emit `session-active`, and `killSession` for detached sessions had no idle cleanup at all. Fixed both paths. Also added an amber "Idle" badge to the PR table's Local column and shortened the label from "Needs attention" to "Idle".

## 2026-03-13 - Browser notifications for idle terminal sessions

Server-side idle detection tracks output silence per session and emits SSE events (`session-idle`, `session-active`) with workspace context. Frontend hook (`useIdleNotification`) fires browser notifications when any session goes idle and the tab is hidden. Bell icon button in the header for notification permission. Idle sessions surface as "Needs attention" pills in the cmd-k command palette, sorted to the top. Dismisses automatically when the session resumes output or when the user navigates to the PR/workspace.

## 2026-03-13 - CLI attach command

New `claude-patrol attach [id]` subcommand that lists active sessions and attaches directly to the backing tmux session. Auto-selects when only one session exists, supports partial ID matching, and shows workspace context for multi-session selection.

## 2026-03-13 - Terminal UX improvements

- Cmd+Enter keyboard shortcut to toggle terminal maximize (shown in button label)
- Fix terminal sizing on cmd-k navigation by scheduling a post-layout fit via requestAnimationFrame

## 2026-03-12 - Promote global terminal to scratch workspace

New feature to promote a running global terminal session into a proper scratch workspace. Backend endpoint `POST /api/sessions/:id/promote` creates a jj workspace, moves uncommitted changes via `jj squash`, copies Claude session files to the new project dir, kills the old session, and restarts Claude with `--resume` in the workspace directory. Frontend adds a "Promote" button in the global terminal header with inline repo/branch form. Navigation redirects to the new workspace detail page after promotion.

## 2026-03-12 - Interactive setup wizard via web UI

Replaced the "edit JSON manually" first-run experience with a 3-step web wizard for configuring poll targets and interval. Accessible via Settings button for reconfiguration.

**What changed:**
- `src/config.js` - removed empty poll target validation, added `isConfigured()` and `getConfigPath()` exports
- `src/index.js` - server starts with empty config instead of exiting, conditional poller start, emits `local-change` SSE on config change, updates TUI header on config change
- `src/routes/config.js` - added `needs_setup` to GET response, added POST `/api/config` endpoint for writing config
- `src/routes/setup.js` (new) - backend endpoints for GitHub account/repo discovery via `gh` CLI (`/api/setup/accounts`, `/api/setup/repos`)
- `src/server.js` - registered setup routes
- `src/poller.js` - tracks `lastTargetsKey` to skip immediate re-poll when only interval changes
- `frontend/src/App.jsx` - setup mode detection, `#/setup` hash route, Settings button prop
- `frontend/src/components/SetupMode/SetupMode.jsx` (new) - 3-step wizard: accounts (checkboxes with avatars) -> repos (all/pick per account with lazy-loaded lists) -> settings (preset interval buttons + custom input). Pre-populates from existing config.
- `frontend/src/components/SetupMode/SetupMode.module.css` (new) - step indicator, preset buttons, settings card styles
- `frontend/src/components/AppShell/AppShell.jsx` - added Settings button with sliders icon
- `frontend/src/lib/api.js` - added `saveConfig()`, `fetchSetupAccounts()`, `fetchSetupRepos()`
- `frontend/src/hooks/usePRs.js` - re-fetches config on `local-change` SSE events, sets countdown directly to new interval

**Why:**
- First-run required editing JSON by hand - not a real onboarding experience. The wizard discovers GitHub accounts/repos via `gh` on the backend and presents checkboxes in the browser. Reconfiguration is accessible from the dashboard header at any time.

## 2026-03-12 - Fix xterm.js rendering: WebGL renderer, Unicode 15 graphemes, stale session cleanup

Added xterm.js addons to fix emoji rendering gaps and improve terminal performance. Also fixed stale sessions surviving server restarts.

**What changed:**
- `frontend/package.json` - added `@xterm/addon-unicode-graphemes` and `@xterm/addon-webgl` (vendored local packages)
- `frontend/src/components/Terminal/Terminal.jsx` - load UnicodeGraphemesAddon (Unicode 15 with grapheme cluster support for proper emoji width), WebglAddon (GPU-accelerated rendering with custom box-drawing glyphs), added `allowProposedApi` and `rescaleOverlappingGlyphs` terminal options
- `src/pty-manager.js` - `cleanupOrphanedSessions()` now also cleans `'detached'` sessions (previously only `'active'`), preventing stale sessions from persisting across server restarts
- `src/index.js` - added `--port` CLI flag to override config port and skip single-instance check

**Why:**
- xterm.js defaults to Unicode 6 width tables where emoji are single-cell-wide, creating visible gaps between characters in the Claude crab mascot. The unicode-graphemes addon provides Unicode 15 tables with proper double-width emoji and ZWJ sequence support.
- The DOM renderer has known limitations with glyph rendering. The WebGL renderer is GPU-accelerated and produces tighter, cleaner cells.
- The stale session bug caused terminals to show reconnect loops after server restarts because `cleanupOrphanedSessions()` only cleaned `'active'` sessions while the frontend queries both `'active'` and `'detached'`.


## 2026-03-12 - Switch from ghostty-web to xterm.js (GitHub master)

Replaced `ghostty-web` with `@xterm/xterm` + `@xterm/addon-fit` built from the xterm.js GitHub master branch. The latest npm release (6.0.0) is from December 2024 with 15+ months of unreleased fixes on master, so we vendor-build from source.

**What changed:**
- `scripts/setup-xterm.sh` (new) - clones xterm.js repo into `vendor/xterm.js`, runs `npm install` + `npm run setup` (tsgo + esbuild). Disables corepack strict mode so npm works inside our pnpm-managed repo.
- `frontend/package.json` - swapped `ghostty-web` for `file:` refs to `@xterm/xterm` and `@xterm/addon-fit` pointing at `vendor/xterm.js`
- `frontend/src/components/Terminal/Terminal.jsx` - replaced ghostty-web imports with xterm.js, removed async WASM `init()` wrapper (xterm.js needs none), added CSS import, added `attachCustomKeyEventHandler` for Shift+Enter (`\x1b[13;2u` kitty protocol sequence)
- `package.json` - added `setup:xterm` script, inlined vendor check into `start`/`watch` commands
- `src/watch.js` - vite output now forwarded to server via IPC so it renders inside the TUI instead of corrupting it. Spawns vite directly from `node_modules/.bin` instead of via `npx` (avoids npm config warnings).
- `src/index.js` - added IPC message listener for watch.js log forwarding, distinct exit code (78) for "already running" so watch mode exits cleanly instead of showing a crash message
- `.gitignore` - added `vendor/`

**Why:**
- ghostty-web is pre-1.0 and had rendering quirks. xterm.js is the industry standard with a larger ecosystem.
- The npm release is stale, but master has active development. Vendor-building pins us to a known commit and keeps builds reproducible.
- Shift+Enter is needed for Claude Code's multi-line input. xterm.js doesn't distinguish it from Enter by default - the custom key handler sends the CSI u sequence that Claude expects.

## 2026-03-12 - Watch mode with session-safe backend reloading

Added backend file watching to `pnpm watch`. When a `.js` file in `src/` changes, the server restarts with `--reattach` mode that preserves active terminal sessions instead of killing them.

**What changed:**
- `src/pty-manager.js` - added `reattachOrphanedSessions()` that finds surviving tmux sessions and re-attaches node-pty to them instead of killing them
- `src/index.js` - `--reattach` flag skips PID check, calls reattach instead of cleanup, and doesn't kill sessions on shutdown
- `src/watch.js` - watches `src/*.js` files with debouncing, restarts server with `--reattach` on changes, handles crashes gracefully
- `frontend/src/components/Terminal/Terminal.jsx` - WebSocket auto-reconnect with exponential backoff (500ms-4s), shows [Connection lost] / [Reconnected] messages in terminal

**Why:**
- Editing backend code while a Claude session is running would kill the session on server restart. The tmux sessions are independent processes that survive - we just need to re-attach to them. The browser terminal auto-reconnects to the new server and gets the replay buffer.

## 2026-03-12 - Session Transcript Persistence

Added the ability to capture, archive, and view Claude Code JSONL transcripts for patrol sessions.

**What changed:**
- `src/utils.js` - extracted `toClaudeProjectKey()` from workspace.js for shared use
- `src/paths.js` - added `transcriptsDir()` for transcript storage at `~/.local/share/claude-patrol/transcripts/`
- `src/db.js` - added `claude_project_dir` and `transcript_path` columns to sessions table
- `src/transcripts.js` (new) - `findSessionJsonl()` matches JSONL files by mtime window, `archiveTranscript()` copies them to patrol's storage
- `src/pty-manager.js` - stores `claude_project_dir` at session creation, archives transcript on session exit (with 500ms delay for flush)
- `src/workspace.js` - archives all session transcripts before Claude project folder deletion in `destroyWorkspace()`
- `src/routes/sessions.js` - `GET /api/sessions/:id/transcript` parses and returns simplified conversation entries, `GET /api/sessions/history` returns killed sessions
- `src/poller.js` - deletes archived transcript files when cleaning up stale PRs
- `frontend/src/lib/api.js` - `fetchSessionHistory()` and `fetchSessionTranscript()` wrappers
- `frontend/src/components/TranscriptViewer/` (new) - conversation viewer with search, thinking toggle, collapsible tool calls
- `frontend/src/components/PRDetail/PRDetail.jsx` - "Past Sessions" section with lazy-loaded history and inline transcript viewing
- `frontend/src/components/WorkspaceDetail/WorkspaceDetail.jsx` - same session history section

**Why:**
- Terminal ring buffers get garbage collected when sessions end, and Claude project folders get deleted with workspaces. Without archiving, all session context is lost.
- Claude Code's JSONL files contain structured conversation data (tool calls, outputs, thinking blocks) - far more useful than raw ANSI terminal bytes.
- Transcripts are archived on session exit and again before workspace destruction as a safety net.

## 2026-03-09T21:57:00 - Plan 01: Config and GitHub Ingestion

Implemented the core backend: config loading with live-reload, SQLite database with `node:sqlite` (Node 24 built-in), and GitHub PR poller via `gh api graphql`.

**What changed:**
- `src/config.js` - config loading, validation with predicate functions, `fs.watchFile` live-reload, path expansion at load time
- `src/db.js` - SQLite setup with WAL mode, all three table schemas (prs, workspaces, sessions) with CHECK constraints on status columns
- `src/poller.js` - GitHub GraphQL polling with pagination, concurrent org fetching via `Promise.allSettled`, transaction-wrapped upserts, cached prepared statements, bulk stale PR deletion
- `src/utils.js` - shared `expandPath` utility for tilde expansion
- `src/index.js` - entry point wiring config, db, and poller together

**Why:**
- Foundation for the PR dashboard. Everything else builds on this data layer.
- Used `node:sqlite` instead of `better-sqlite3` to avoid native addon builds.
- Poller uses `gh api graphql` to reuse existing `gh auth` - no separate token management.

## 2026-03-09T22:15:00 - Plan 02: API and Frontend

Added Fastify REST API and React frontend with a filterable PR dashboard.

**What changed:**
- `src/server.js` - Fastify setup with CORS, SSE endpoint (with `reply.hijack()`), static file serving with SPA fallback
- `src/routes/prs.js` - GET /api/prs with query filtering, GET /api/prs/:id with proper 404, derived CI/review status
- `src/routes/sync.js` - POST /api/sync/trigger
- `src/routes/config.js` - GET /api/config (non-sensitive fields only)
- `frontend/` - React + Vite + Tailwind v4 + TanStack Table
- Components: AppShell, PRTable, FilterBar, StatusBadge - all with CSS modules using `@reference "tailwindcss"` for Tailwind v4 compatibility
- `frontend/src/hooks/usePRs.js` - SSE-driven auto-refresh
- `frontend/src/lib/time.js` - shared relative time formatter
- `frontend/src/lib/api.js` - fetch wrappers

**Why:**
- Serves the cached PR data through a dashboard UI with live updates via SSE.
- Filter bar derives options from the dataset, no extra endpoint needed.

## 2026-03-09T22:40:00 - Plan 03: Workspace Manager

Added jj workspace creation/destruction tied to PRs, with symlink setup and Docker cleanup.

**What changed:**
- `src/workspace.js` - create/destroy workspace logic with insert-first concurrency guard (unique partial index on active workspaces), symlink setup, sequential destroy with warnings
- `src/routes/workspaces.js` - POST/GET/DELETE /api/workspaces endpoints
- `src/db.js` - added unique partial index `idx_workspaces_active_pr` to prevent concurrent creation for the same PR
- `src/server.js` / `src/index.js` - wired workspace routes and config propagation

**Why:**
- Workspaces are the bridge between the PR dashboard and Claude sessions. Each workspace is a jj workspace checked out to the PR's branch with symlinks for Claude memory and other config.

## 2026-03-09T23:10:00 - Plan 04: Terminal Bridge

Added PTY session management with WebSocket streaming and xterm.js frontend.

**What changed:**
- `src/pty-manager.js` - PTY lifecycle via node-pty, fixed-size RingBuffer for replay (50KB, zero-alloc appends), WebSocket message validation, orphaned session cleanup on startup
- `src/routes/sessions.js` - POST/GET/DELETE /api/sessions + WebSocket upgrade at /ws/sessions/:id
- `frontend/src/components/Terminal/` - xterm.js wrapper with WebSocket connection, auto-resize via ResizeObserver
- `frontend/src/components/GlobalTerminal/` - collapsible drawer at bottom of UI, creates global session on first open
- `frontend/vite.config.js` - added WebSocket proxy for dev mode
- `src/server.js` - registered @fastify/websocket plugin and session routes

**Why:**
- Terminal bridge lets users interact with Claude CLI sessions directly from the dashboard. The ring buffer enables reattaching to running sessions with output history.

## 2026-03-10T00:00:00 - Plan 05: Integration

Wired workspace and session management into the PR dashboard. Added PR detail view, quick actions, startup validation, and health checks.

**What changed:**
- `src/startup.js` - validates gh, jj, claude CLI availability and gh auth before starting
- `src/health.js` - periodic checks (60s) verify session PIDs alive and workspace dirs exist, runs immediately on start
- `src/index.js` - added startup validation and health check wiring
- `frontend/src/App.jsx` - hash-based routing for PR detail view, DashboardSummary integration
- `frontend/src/components/DashboardSummary/` - summary stats bar (PR count, workspace count, session count, sync time)
- `frontend/src/components/PRDetail/` - full PR detail view with metadata, checks, reviews, labels. Parallel data loading for PR + workspaces.
- `frontend/src/components/WorkspaceControls/` - create/destroy with confirmation dialog
- `frontend/src/components/QuickActions/` - sends commands to terminal via WebSocket (rebase, lint fix, custom)
- `frontend/src/components/Terminal/` - added external wsRef prop so QuickActions can send commands
- `frontend/src/lib/api.js` - expanded with workspace/session/PR CRUD functions

**Why:**
- Completes the full flow: PR table -> PR detail -> create workspace -> Claude session with quick actions. Startup validation prevents a half-working server.

## 2026-03-10 - Four feature batch: button fix, merge status, poll config, stale cleanup

### Feature 1: "Open in Claude" button persists after workspace creation
One-line fix in PRDetail.jsx - removed the `!workspace` guard so the button shows whenever there's no active session. The handler already checks for existing workspace before creating one.

### Feature 2: Auto-cleanup workspaces for merged/closed PRs
When the poller detects PRs that are no longer open, it now destroys their workspaces (kill sessions, docker down, jj forget, rm directory, Claude memory cleanup) before deleting the DB rows. Split into two phases: sync (transaction for upserts) then async cleanup (workspace destruction + stale row deletion).

### Feature 3: Merge/conflict status on dashboard and detail page
- Added `mergeable` field to GraphQL query and DB schema (migration via ALTER TABLE)
- New StatusBadge variants for merge status: Clean (green), Conflict (red), Unknown (gray)
- "Merge" column added to PR table, merge status badge on PR detail page

### Feature 4: Config supports `poll.orgs` + `poll.repos` + `poll.interval_seconds`
Restructured config from flat `orgs`/`poll_interval_seconds` to nested `poll` object. Supports org-level and individual repo-level polling. Repo-level polls are skipped if the repo's org is already polled. Stale deletion is scoped per-org or per-repo. Backward-compatible migration handles legacy config format.

**Files changed:** PRDetail.jsx, PRTable.jsx, StatusBadge.jsx/css, poller.js, db.js, config.js, routes/sync.js, routes/config.js, index.js, config.json, config.example.json

## 2026-03-11 - Plan 11: Scratch Workspaces

Decoupled workspaces from PRs so users can start new work without an existing PR. A "scratch workspace" picks a repo, names a branch, and creates a jj workspace. When a PR is created from that branch, the poller auto-adopts the workspace into the PR flow.

**What changed:**
- `src/db.js` - made `pr_id` nullable, added `repo` column, SQLite table recreation migration for existing DBs
- `src/workspace.js` - new `createScratchWorkspace()` function, extracted shared `runPostCreateSetup()` helper, fixed `destroyWorkspace()` to derive repo path from `workspace.repo` for scratch workspaces
- `src/poller.js` - new `adoptScratchWorkspaces()` runs after each sync, matches scratch workspace branch+repo to newly-synced PRs, cached prepared statements
- `src/routes/workspaces.js` - extended POST to accept `{repo, branch}` for scratch creation, added `type` filter to GET, added GET `/:id` endpoint, fixed LEFT JOIN for repo filter
- `src/mcp-server.js` - new `create_scratch_workspace` MCP tool
- `frontend/src/lib/api.js` - new `createScratchWorkspace()`, `fetchWorkspace()`, `fetchScratchWorkspaces()` functions
- `frontend/src/App.jsx` - hash routing for `#/workspace/:id`, scratch workspace list on dashboard, "New Work" form with repo selector and branch input
- `frontend/src/components/WorkspaceDetail/` - new component for scratch workspace detail view with terminal session management

**Why:**
- Previously all workspaces required an existing PR. This makes the tool useful for greenfield work where you want to start coding before opening a PR.

## 2026-03-11 - Plan 12: Switch from xterm.js to ghostty-web

Replaced `@xterm/xterm` + `@xterm/addon-fit` with `ghostty-web` (v0.4.0) for the terminal emulator component. ghostty-web uses Ghostty's Zig parser compiled to WASM, providing the same xterm.js-compatible API surface with canvas-based rendering.

**What changed:**
- `frontend/package.json` - swapped `@xterm/xterm` and `@xterm/addon-fit` for `ghostty-web`
- `frontend/src/components/Terminal/Terminal.jsx` - replaced xterm.js imports with ghostty-web, added async WASM init with cancellation flag pattern, removed `letterSpacing` option (not supported, was 0 anyway), removed xterm CSS import

**Why:**
- ghostty-web renders to a canvas element, which avoids xterm.js's DOM-heavy rendering. The API surface we use is small (Terminal, FitAddon, onData, onResize, write, focus, dispose) and fully supported by ghostty-web. Pre-1.0 caveat acknowledged - the risk is low given our limited API usage.

## 2026-03-11 - Add maximize buttons to terminal windows

Added a maximize/restore toggle to both the GlobalTerminal drawer and WorkspaceDetail terminal card. When maximized, the terminal fills the entire viewport (fixed positioning, z-index 40). Restore via the button or Escape key.

**What changed:**
- `frontend/src/components/GlobalTerminal/GlobalTerminal.jsx` - added `maximized` state, maximize/restore toggle button in header bar, Escape key listener, conditional `.maximized` CSS class that replaces `.drawer` positioning, hides resize handle when maximized, close button also un-maximizes
- `frontend/src/components/GlobalTerminal/GlobalTerminal.module.css` - new `.maximized` class (fixed inset-0 z-40), `.maximizeButton` styled as neutral gray pill
- `frontend/src/components/WorkspaceDetail/WorkspaceDetail.jsx` - added `maximized` state, maximize button next to Kill Session, full-viewport overlay with header bar showing workspace name, Escape key listener. Also fixed pre-existing bug: Terminal was receiving `sessionId` prop (which it ignores) instead of `wsUrl`
- `frontend/src/components/WorkspaceDetail/WorkspaceDetail.module.css` - new `.maximizeButton`, `.terminalOverlay`, `.overlayHeader`, `.overlayTitle`, `.overlayContent`, `.terminalContainer` (400px explicit height for card-embedded terminal) classes

**Why:**
- Terminal windows were constrained to a drawer or card with no way to focus on a single session. Maximizing fills the browser window so you can work in the terminal without the surrounding dashboard chrome.
- Default terminal height increased from 400px to 600px (both GlobalTerminal and WorkspaceDetail) for better usability.
- Workspace terminal is now resizable via a drag handle, matching the GlobalTerminal's existing resize behavior.

## 2026-03-11 - Extract shared hooks and CSS module

Consolidated duplicated patterns across frontend components into shared hooks and a shared CSS module. Reduced CSS bundle from 94.7KB to 89.1KB.

**What changed:**
- `frontend/src/hooks/useEscapeKey.js` - extracted from GlobalTerminal + WorkspaceDetail
- `frontend/src/hooks/useResizeHandle.js` - extracted from GlobalTerminal + WorkspaceDetail, unified delta calculation (was inconsistent between the two), returns `handleProps` spread object
- `frontend/src/hooks/useClickOutside.js` - extracted from DashboardSummary + FilterBar
- `frontend/src/hooks/useSyncEvents.js` - extracted SSE listener from PRDetail + WorkspaceDetail
- `frontend/src/styles/shared.module.css` - consolidated ~20 CSS classes duplicated across PRDetail, WorkspaceDetail, and GlobalTerminal (card, headerCard, backButton, sectionTitle, identityRow, killSessionButton, maximizeButton, destroyButton, openButton, terminalHeader/Actions/Overlay, resizeHandle/Grip/dragOverlay, loading, error)
- `frontend/src/components/PRDetail/` - imports shared styles, removed ~60 lines of duplicated CSS
- `frontend/src/components/WorkspaceDetail/` - imports shared hooks + styles, removed ~90 lines of duplicated CSS/JS
- `frontend/src/components/GlobalTerminal/` - uses useEscapeKey + useResizeHandle hooks
- `frontend/src/components/DashboardSummary/` - uses useClickOutside hook
- `frontend/src/components/FilterBar/` - uses useClickOutside hook

**Why:**
- The same CSS classes and JS patterns were copy-pasted across 3-5 components. Extracting them into shared modules means one source of truth for button styles, layout patterns, and behavioral hooks.

## 2026-03-12 - Fix functional gaps and add FUTURE-IDEAS.md

Three bug fixes and a documentation file.

**What changed:**
- `FUTURE-IDEAS.md` - documents three deferred features (notification/alerting, session transcript persistence, automation loop) with enough context to act on later
- `src/poller.js` - `ghGraphql()` now retries up to 3 times with exponential backoff (1s/2s/4s) on transient failures (non-zero exit codes, spawn errors). JSON parse errors are not retried. All callers (`fetchPRs`, `fetchRemainingChecks`) benefit automatically.
- `src/pty-manager.js` - `createSession()` now deduplicates workspace sessions the same way it already did for global sessions. Creating a second session for the same workspace returns the existing one instead of spawning a conflicting Claude Code instance.
- `frontend/src/components/PRDetail/PRDetail.jsx` - `CheckRow` now renders all failed job logs from a workflow run instead of only the first. When a run has multiple jobs, each gets a label above its log viewer.

**Why:**
- The poller was fragile against transient GitHub API errors - a single 502 or rate limit would leave PR data stale for an entire poll interval.
- Nothing prevented multiple concurrent Claude sessions in the same worktree, which could cause conflicting edits.
- Multi-job workflow failures only showed the first job's log, hiding the other failures.

## 2026-08-19 - Add provider-aware agent sessions

Added an explicit Claude or Codex provider to each session. New Codex sessions launch in the selected workspace with Patrol's session-scoped MCP endpoint and system instructions. Session creation, MCP dispatch, and global sessions now preserve the provider and reject attempts to reuse a live target with the other provider. Schema v8 adds the provider without deleting v7 session data; older databases keep the existing v7 reset policy. Claude-only transcripts and global-session promotion now reject Codex sessions instead of implying support.

This makes provider choice durable at the process and database boundaries before the UI exposes the selector. It also lets either agent send prompts to a missing Claude or Codex target through Patrol MCP.

## 2026-08-19 - Generalize inverse-provider reviews

Replaced the Codex-specific review route, lifecycle coordinator, SSE event, and app context with provider-neutral peer-review contracts. Claude sessions still reserve Codex reviews, while Codex sessions now reserve Claude reviews through a new `review_with_claude` Patrol MCP tool. The Claude reviewer receives Patrol's immutable `jj` diff over stdin and runs non-interactively with safe mode, no persistence, `dontAsk`, and only Read, Glob, and Grep tools. Provider capability checks now cover both authenticated CLIs.

This keeps the user-triggered reservation and delivery guarantees in one coordinator while making the reviewer a strict inverse of the live session provider. Shared range resolution also removes the prior Codex ownership from provider-neutral diff preparation.

## 2026-08-19 - Add the shared agent provider selector

Added one browser-wide Claude or Codex preference, stored in local storage with Claude as the first-run default. PR workspaces, scratch workspaces, the global terminal header, the global drawer, and command-palette global launch now use that preference for new sessions. Live sessions display and retain their recorded provider until killed. The review control reads the presenter provider from the session and labels, checks, and requests the inverse reviewer. Codex session history remains visible but no longer offers the unsupported Claude transcript viewer, and Codex global sessions omit Claude-only promotion.

This puts provider choice at every launch entry point without pretending a live TUI can switch providers. Capability polling moved into the provider context so review readiness is shared instead of threaded through unrelated components.

## 2026-08-19 - Label the provider form control

Added a stable form-control name to the shared agent provider selector. Chrome DevTools now recognizes every rendered selector as an identified form field while the existing accessible label remains unchanged.

## 2026-08-19 - Restore PR metadata contrast

Darkened PR status labels and update timestamps from gray 400 to gray 500. This raises their contrast on white backgrounds above the WCAG AA threshold without changing the surrounding layout.

## 2026-08-19 - Integrate provider choice into launch buttons

Replaced the separate provider selects with split action buttons. The main segment still opens or starts the selected agent, while an adjacent chevron opens the native Claude or Codex picker. PR, scratch, and global launch controls now use the same interaction, and live global sessions keep the provider segment locked to the running agent.

## 2026-08-19 - Style the provider menu

Replaced the browser-native provider options with an application-styled menu. Claude and Codex now have distinct marks, secondary CLI labels, hover and focus states, a selected checkmark, dark-mode treatment, click-outside dismissal, Escape handling, and arrow-key navigation.
