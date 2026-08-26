import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { isConfigured, isPollConfigured, isWorkItemsConfigured, parseConfig } from './config.js';
import { providerSetup } from './provider-setup.js';
import { resolveWorkspaceRevision, sourceRepositoryPath } from './workspace.js';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'patrol-work-item-config-'));
  temporaryDirectories.push(directory);
  return directory;
}

function workItemConfig(overrides = {}) {
  return {
    poll: { orgs: [], repos: [] },
    repos: { 'acme/widgets': { defaultRevision: 'main@origin' } },
    work_items: {
      repositories: ['acme/widgets'],
      resolver: {
        server: {
          name: 'work-reference',
          transport: 'http',
          url: 'https://mcp.example.test/readonly',
          enabled_tools: ['get_issue'],
        },
        instructions: 'Resolve the reference using read-only project data.',
      },
    },
    ...overrides,
  };
}

test('a work-item-only configuration passes the application gate', () => {
  const config = parseConfig(workItemConfig());
  assert.equal(config.default_session_provider, 'claude');
  assert.equal(isPollConfigured(config), false);
  assert.equal(isWorkItemsConfigured(config), true);
  assert.equal(isConfigured(config), true);
});

test('default_session_provider accepts supported providers and rejects other values', () => {
  assert.equal(parseConfig(workItemConfig({ default_session_provider: 'codex' })).default_session_provider, 'codex');
  assert.throws(() => parseConfig(workItemConfig({ default_session_provider: 'other' })), /default_session_provider/);
});

test('work-item configuration rejects ambiguous repositories and unsafe resolver settings', () => {
  assert.throws(
    () =>
      parseConfig(workItemConfig({ work_items: { ...workItemConfig().work_items, repositories: ['acme/missing'] } })),
    /missing repos\.acme\/missing/,
  );
  assert.throws(
    () => parseConfig({ ...workItemConfig(), repos: { 'acme/widgets': {} } }),
    /defaultRevision.*required/s,
  );
  assert.throws(
    () =>
      parseConfig({
        ...workItemConfig(),
        work_items: {
          ...workItemConfig().work_items,
          resolver: {
            ...workItemConfig().work_items.resolver,
            server: { ...workItemConfig().work_items.resolver.server, url: 'http://mcp.example.test/readonly' },
          },
        },
      }),
    /HTTPS or loopback HTTP/,
  );
  for (const url of [' https://mcp.example.test/readonly', 'https://mcp.example.test/read\nonly']) {
    assert.throws(
      () =>
        parseConfig({
          ...workItemConfig(),
          work_items: {
            ...workItemConfig().work_items,
            resolver: {
              ...workItemConfig().work_items.resolver,
              server: { ...workItemConfig().work_items.resolver.server, url },
            },
          },
        }),
      /HTTPS or loopback HTTP/,
    );
  }
  assert.throws(
    () =>
      parseConfig({
        ...workItemConfig(),
        work_items: {
          ...workItemConfig().work_items,
          resolver: {
            ...workItemConfig().work_items.resolver,
            server: {
              ...workItemConfig().work_items.resolver.server,
              url: 'https://token:secret@mcp.example.test/readonly',
            },
          },
        },
      }),
    /HTTPS or loopback HTTP/,
  );
  assert.throws(
    () =>
      parseConfig({
        ...workItemConfig(),
        work_items: {
          ...workItemConfig().work_items,
          resolver: {
            ...workItemConfig().work_items.resolver,
            server: { ...workItemConfig().work_items.resolver.server, enabled_tools: ['get_issue', 'get_issue'] },
          },
        },
      }),
    /unique tool names/,
  );
  for (const repository of ['../widgets', 'acme/..', 'acme/bad\nInjected policy', 'acme\\widgets']) {
    assert.throws(
      () =>
        parseConfig({
          ...workItemConfig(),
          repos: { [repository]: { defaultRevision: 'main@origin' } },
          work_items: { ...workItemConfig().work_items, repositories: [repository] },
        }),
      /owner\/repo/,
    );
  }
});

test('provider setup keeps the resolver URL in one shell argument', () => {
  const parsed = parseConfig({
    ...workItemConfig(),
    work_items: {
      ...workItemConfig().work_items,
      resolver: {
        ...workItemConfig().work_items.resolver,
        server: {
          ...workItemConfig().work_items.resolver.server,
          url: "https://mcp.example.test/it's-readonly?scope=issues&mode=read",
        },
      },
    },
  });
  const setup = providerSetup(parsed);
  assert.equal(
    setup.claude.resolver_mcp_commands[0],
    `claude mcp add --transport http --scope user work-reference 'https://mcp.example.test/it'"'"'s-readonly?scope=issues&mode=read'`,
  );
  assert.equal(
    setup.codex.resolver_mcp_commands[0],
    `codex mcp add work-reference --url 'https://mcp.example.test/it'"'"'s-readonly?scope=issues&mode=read'`,
  );
});

test('source repositories must be jj repositories contained by work_dir', async () => {
  const root = temporaryDirectory();
  const workDir = join(root, 'work');
  const repository = join(workDir, 'acme', 'widgets');
  mkdirSync(repository, { recursive: true });
  execFileSync('jj', ['git', 'init', '--colocate', repository], { stdio: 'ignore' });
  const config = { work_dir: workDir };

  assert.equal(sourceRepositoryPath('acme/widgets', config), realpathSync(repository));
  const revision = await resolveWorkspaceRevision('acme/widgets', '@', config);
  assert.match(revision.commitId, /^[0-9a-f]{40,64}$/);

  const gitOnly = join(workDir, 'acme', 'git-only');
  mkdirSync(gitOnly, { recursive: true });
  assert.throws(
    () => sourceRepositoryPath('acme/git-only', config),
    (error) => error.code === 'jj_required',
  );

  const outside = join(root, 'outside');
  mkdirSync(join(outside, '.jj'), { recursive: true });
  symlinkSync(outside, join(workDir, 'acme', 'escape'));
  assert.throws(
    () => sourceRepositoryPath('acme/escape', config),
    (error) => error.code === 'unsafe_repository_path',
  );
});
