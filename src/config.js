import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, renameSync, rmSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { configPath, dataDir, defaultDbPath } from './paths.js';
import { expandPath } from './utils.js';

const CONFIG_PATH = configPath();

const PATH_FIELDS = ['db_path', 'workspace_base_path', 'work_dir', 'global_terminal_cwd'];

const OWNER_REPO_RE =
  /^(?!\.{1,2}\/)(?![^/]+\/\.{1,2}$)[^\s/\\\u0000-\u001f\u007f-\u009f]+\/[^\s/\\\u0000-\u001f\u007f-\u009f]+$/u;
const MCP_NAME_RE = /^[A-Za-z0-9_-]+$/;
const MCP_TOOL_RE = /^[A-Za-z0-9_.-]+$/;

function hasAllowedResolverUrl(value) {
  try {
    if (value !== value.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || host.startsWith('127.');
  } catch {
    return false;
  }
}

const repoConfigSchema = z
  .object({
    symlinks: z.array(z.string()).optional(),
    initCommands: z.array(z.string()).optional(),
    defaultRevision: z.string().trim().min(1).optional(),
  })
  .strict();

const workItemsSchema = z
  .object({
    repositories: z
      .array(z.string().regex(OWNER_REPO_RE, 'must be "owner/repo" format'))
      .min(1)
      .max(32)
      .refine((items) => new Set(items).size === items.length, 'must contain unique repositories'),
    resolver: z
      .object({
        provider: z.enum(['claude', 'codex']).optional(),
        server: z
          .object({
            name: z.string().min(1).max(64).regex(MCP_NAME_RE),
            transport: z.literal('http'),
            url: z.string().refine(hasAllowedResolverUrl, 'must be HTTPS or loopback HTTP'),
            enabled_tools: z
              .array(z.string().min(1).max(128).regex(MCP_TOOL_RE))
              .min(1)
              .max(16)
              .refine((items) => new Set(items).size === items.length, 'must contain unique tool names'),
          })
          .strict(),
        instructions: z
          .string()
          .trim()
          .min(1)
          .refine((value) => Buffer.byteLength(value, 'utf8') <= 16 * 1024, 'must be at most 16 KiB'),
      })
      .strict(),
  })
  .strict();

export const configSchema = z
  .object({
    port: z.number().int().positive().default(3000),
    host: z.string().min(1).default('127.0.0.1'),
    db_path: z.string().optional(),
    workspace_base_path: z.string().default('~/.claude-patrol/workspaces'),
    work_dir: z.string().default('~/.claude-patrol/workspaces'),
    global_terminal_cwd: z.string().optional(),
    default_session_provider: z.enum(['claude', 'codex']).default('claude'),
    symlink_memory: z.boolean().default(false),
    poll: z
      .object({
        interval_seconds: z.number().int().min(5).default(30),
        orgs: z.array(z.string()).default([]),
        repos: z.array(z.string().regex(OWNER_REPO_RE, 'must be "owner/repo" format')).default([]),
      })
      .default({ interval_seconds: 30, orgs: [], repos: [] }),
    security: z
      .object({
        auth_token: z.string().min(16).optional(),
        allowed_origins: z.array(z.string().url()).default([]),
      })
      .default({ allowed_origins: [] }),
    automation: z
      .object({
        concurrency: z.number().int().min(1).max(16).default(2),
      })
      .default({ concurrency: 2 }),
    repos: z.record(z.string().regex(OWNER_REPO_RE, 'must be "owner/repo" format'), repoConfigSchema).optional(),
    work_items: workItemsSchema.optional(),
    // pass-through for unknown keys (rules array etc.)
  })
  .passthrough()
  .superRefine((config, ctx) => {
    for (const repo of config.work_items?.repositories ?? []) {
      const repoConfig = config.repos?.[repo];
      if (!repoConfig) {
        ctx.addIssue({ code: 'custom', path: ['work_items', 'repositories'], message: `missing repos.${repo}` });
      } else if (!repoConfig.defaultRevision) {
        ctx.addIssue({
          code: 'custom',
          path: ['repos', repo, 'defaultRevision'],
          message: 'is required for work-item repositories',
        });
      }
    }
  });

/**
 * Ensure a config file exists. If not, write a starter template and return false.
 * @returns {boolean} true if config exists, false if template was written
 */
export function ensureConfig(path = CONFIG_PATH) {
  if (existsSync(path)) return true;

  const template = {
    port: 3000,
    workspace_base_path: '~/.claude-patrol/workspaces',
    work_dir: '~/.claude-patrol/workspaces',
    poll: {
      interval_seconds: 30,
      orgs: [],
      repos: [],
    },
  };
  writeConfigAtomic(path, template);
  return false;
}

/**
 * Check whether the config has any poll targets configured.
 * @param {Record<string, unknown>} cfg
 * @returns {boolean}
 */
export function isPollConfigured(cfg) {
  return (cfg?.poll?.orgs?.length ?? 0) > 0 || (cfg?.poll?.repos?.length ?? 0) > 0;
}

export function isWorkItemsConfigured(cfg) {
  return Boolean(cfg?.work_items);
}

export function isConfigured(cfg) {
  return isPollConfigured(cfg) || isWorkItemsConfigured(cfg);
}

/**
 * Get the resolved config file path.
 * @returns {string}
 */
export function getConfigPath() {
  return CONFIG_PATH;
}

/** Read and validate configuration data and expand filesystem paths. */
export function parseConfig(parsed) {
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid config:\n${issues}`);
  }
  const cfg = result.data;

  // Default db_path if not set
  if (!cfg.db_path) {
    cfg.db_path = defaultDbPath();
  }

  for (const field of PATH_FIELDS) {
    if (cfg[field]) {
      if (field === 'db_path' && !cfg[field].startsWith('~') && !isAbsolute(cfg[field])) {
        // Relative db_path resolves against dataDir, not CWD
        cfg[field] = resolve(dataDir(), cfg[field]);
      } else {
        cfg[field] = expandPath(cfg[field]);
      }
    }
  }

  return Object.freeze(cfg);
}

export function loadConfig(path = CONFIG_PATH) {
  const raw = readFileSync(path, 'utf8');
  return parseConfig(JSON.parse(raw));
}

function writeConfigAtomic(path, value) {
  const temporaryPath = resolve(dirname(path), `.config.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * Validate, atomically persist, and publish a partial configuration update.
 * The raw on-disk object is merged so normalized absolute paths are never
 * written back over the user's portable path values.
 */
export function updateConfig(patch, path = CONFIG_PATH) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const mergeSection = (key) => {
    if (!Object.hasOwn(patch, key)) return raw[key];
    const value = patch[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return { ...(raw[key] ?? {}), ...value };
  };
  const merged = {
    ...raw,
    ...patch,
    poll: mergeSection('poll'),
    security: mergeSection('security'),
  };
  const normalized = parseConfig(merged);
  writeConfigAtomic(path, merged);
  setCurrentConfig(normalized);
  configEvents.emit('change', normalized);
  return normalized;
}

export const configEvents = new EventEmitter();

/** @type {Readonly<Record<string, unknown>> | null} */
let currentConfig = null;

/**
 * Get the current config. Routes import this instead of holding their own copy.
 * @returns {Readonly<Record<string, unknown>>}
 */
export function getCurrentConfig() {
  return currentConfig;
}

/**
 * Set the current config. Called once at startup and on each config change.
 * @param {Readonly<Record<string, unknown>>} cfg
 */
export function setCurrentConfig(cfg) {
  currentConfig = cfg;
}

/**
 * Watch config file for changes. Emits 'change' on configEvents with the new config.
 */
export function watchConfig() {
  unwatchConfig();
  watchFile(CONFIG_PATH, { interval: 1000 }, () => {
    try {
      const cfg = loadConfig();
      if (currentConfig && JSON.stringify(cfg) === JSON.stringify(currentConfig)) return;
      configEvents.emit('change', cfg);
      console.log('[config] Reloaded config');
    } catch (err) {
      console.warn(`[config] Invalid config change ignored: ${err.message}`);
    }
  });
}

/**
 * Stop watching the config file.
 */
export function unwatchConfig() {
  unwatchFile(CONFIG_PATH);
}
