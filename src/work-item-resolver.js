import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { buildCodexEnvironment } from './codex-capability.js';
import { sanitizePublicText } from './public-errors.js';
import { execFile } from './utils.js';

export const RESOLVER_TIMEOUT_MS = 120_000;
export const RESOLVER_MAX_MCP_CALLS = 16;
export const RESOLVER_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const RESOLVER_MAX_FINAL_BYTES = 256 * 1024;

const RESULT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    repositories: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32 },
  },
  required: ['title', 'summary', 'repositories'],
  additionalProperties: false,
});

const resultSchema = z
  .object({
    title: z.string(),
    summary: z.string(),
    repositories: z.array(z.string()).min(1).max(32),
  })
  .strict();

function resolverError(code, message, cause) {
  const error = new Error(sanitizePublicText(message), cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function tomlString(value) {
  return JSON.stringify(value);
}

export function resolverInput(reference, config, workProvider) {
  return `${JSON.stringify({
    trusted_instructions: config.resolver.instructions,
    trusted_requirements: [
      'Use the configured MCP server to resolve the supplied reference.',
      `Successfully call at least one enabled MCP tool before returning: ${config.resolver.server.enabled_tools.join(', ')}.`,
      'Do not guess the title, summary, or repository selection when the reference content is unavailable.',
    ],
    untrusted_reference: reference,
    requested_work_provider: workProvider,
    candidate_repositories: config.repositories,
    output_contract: RESULT_SCHEMA,
  })}\n`;
}

export function buildClaudeResolverArgs(config) {
  const server = config.resolver.server;
  const allowedTools = server.enabled_tools.map((tool) => `mcp__${server.name}__${tool}`);
  const mcpConfig = JSON.stringify({
    mcpServers: {
      [server.name]: { type: 'http', url: server.url },
    },
  });
  return [
    '--print',
    '--input-format',
    'text',
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    JSON.stringify(RESULT_SCHEMA),
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    // No --tools: passing it at all makes the CLI deny the allowlisted MCP tool
    // under `dontAsk`. The allowlist below plus createToolInspector are what
    // restrict the resolver to the configured MCP tool.
    '--allowedTools',
    ...allowedTools,
    // `dontAsk` denies MCP tools outright, ignoring --allowedTools and any
    // permissions.allow rule, so every resolve fails. `auto` honours the
    // allowlist below; createToolInspector still aborts on anything else.
    '--permission-mode',
    'auto',
    '--no-chrome',
    '--disable-slash-commands',
    '--setting-sources',
    '',
  ];
}

const CODEX_DISABLED_FEATURES = Object.freeze([
  'apps',
  'browser_use',
  'computer_use',
  'goals',
  'hooks',
  'image_generation',
  'in_app_browser',
  'memories',
  'multi_agent',
  'plugins',
  'shell_tool',
  'skill_mcp_dependency_install',
  'skill_search',
  'tool_suggest',
  'unified_exec',
  'view_image',
  'workspace_dependencies',
]);

export function buildCodexResolverArgs(config, cwd, outputSchemaPath) {
  const server = config.resolver.server;
  // Config validation restricts MCP names to TOML bare-key characters. Quoting
  // this segment makes current Codex versions treat the quotes as part of the
  // server name instead of TOML syntax.
  const serverKey = `mcp_servers.${server.name}`;
  const args = [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--skip-git-repo-check',
    '--strict-config',
    '--json',
    '--sandbox',
    'read-only',
    '--output-schema',
    outputSchemaPath,
    '--cd',
    cwd,
    '--config',
    'approval_policy="never"',
    '--config',
    'web_search="disabled"',
    '--config',
    `${serverKey}.url=${tomlString(server.url)}`,
    '--config',
    `${serverKey}.required=true`,
    '--config',
    `${serverKey}.enabled_tools=${JSON.stringify(server.enabled_tools)}`,
  ];
  for (const feature of CODEX_DISABLED_FEATURES) args.push('--disable', feature);
  args.push('-');
  return args;
}

function utf8(buffer, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    throw resolverError('invalid_provider_output', `${label} was not valid UTF-8`, error);
  }
}

function jsonLines(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw resolverError('invalid_provider_output', 'Resolver returned malformed JSONL', error);
    }
  }
  return events;
}

function parseFinalObject(value) {
  if (value && typeof value === 'object') {
    let encoded;
    try {
      encoded = JSON.stringify(value);
    } catch (error) {
      throw resolverError('invalid_provider_output', 'Resolver final value was not serializable JSON', error);
    }
    if (Buffer.byteLength(encoded, 'utf8') > RESOLVER_MAX_FINAL_BYTES) {
      throw resolverError('resolver_output_limit', 'Resolver final message exceeded the size limit');
    }
    return value;
  }
  if (typeof value !== 'string') throw resolverError('invalid_provider_output', 'Resolver returned no final value');
  if (Buffer.byteLength(value, 'utf8') > RESOLVER_MAX_FINAL_BYTES) {
    throw resolverError('resolver_output_limit', 'Resolver final message exceeded the size limit');
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw resolverError('invalid_provider_output', 'Resolver final value was not JSON', error);
  }
}

// Internal CLI mechanisms rather than external capabilities: StructuredOutput
// satisfies --json-schema, and ToolSearch only loads tool schemas - the tool it
// then calls is still checked against the allowlist.
const CLAUDE_INTERNAL_TOOLS = new Set(['StructuredOutput', 'ToolSearch']);

function claudeToolName(block) {
  if (block?.type !== 'tool_use' || typeof block.name !== 'string') return null;
  return CLAUDE_INTERNAL_TOOLS.has(block.name) ? null : block.name;
}

export function parseClaudeResolverOutput(stdout, config) {
  const events = jsonLines(stdout);
  const allowed = new Set(
    config.resolver.server.enabled_tools.map((tool) => `mcp__${config.resolver.server.name}__${tool}`),
  );
  let calls = 0;
  let successfulCalls = 0;
  const pendingCallIds = new Set();
  let final = null;
  for (const event of events) {
    for (const block of event?.message?.content ?? []) {
      if (block?.type === 'tool_result' && block.is_error) {
        throw resolverError('resolution_failed', 'Configured MCP lookup failed');
      }
      if (
        block?.type === 'tool_result' &&
        typeof block.tool_use_id === 'string' &&
        pendingCallIds.delete(block.tool_use_id)
      ) {
        successfulCalls += 1;
      }
      const name = claudeToolName(block);
      if (!name) continue;
      calls += 1;
      if (!allowed.has(name))
        throw resolverError('resolver_tool_violation', `Resolver attempted disallowed tool ${name}`);
      if (typeof block.id === 'string') pendingCallIds.add(block.id);
    }
    if (event?.type === 'result') {
      if (event.is_error) throw resolverError('resolution_failed', 'Claude reported a resolver error');
      final = event.structured_output ?? event.result ?? null;
    }
  }
  if (calls > RESOLVER_MAX_MCP_CALLS) {
    throw resolverError('resolver_call_limit', 'Resolver exceeded the MCP call limit');
  }
  const parsedFinal = parseFinalObject(final);
  if (successfulCalls === 0) throw resolverError('resolution_failed', 'Resolver completed without an MCP lookup');
  return parsedFinal;
}

function codexToolIdentity(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'mcp_tool_call') {
    const server = item.server ?? item.server_name;
    const tool = item.tool ?? item.tool_name ?? item.name;
    return { server, tool };
  }
  if (['command_execution', 'web_search', 'browser', 'tool_call'].includes(item.type)) {
    return { server: '<builtin>', tool: item.type };
  }
  return null;
}

export function parseCodexResolverOutput(stdout, config) {
  const events = jsonLines(stdout);
  const server = config.resolver.server;
  const allowed = new Set(server.enabled_tools);
  let calls = 0;
  let successfulCalls = 0;
  const startedCallIds = new Set();
  let pendingAgentMessage = null;
  let finalAgentMessage = null;
  let completed = false;
  for (const event of events) {
    const item = event?.item;
    const tool = codexToolIdentity(item);
    if (tool) {
      if (tool.server !== server.name || !allowed.has(tool.tool)) {
        throw resolverError(
          'resolver_tool_violation',
          `Resolver attempted disallowed tool ${tool.server}/${tool.tool}`,
        );
      }
      const callId = typeof item.id === 'string' ? item.id : null;
      if (event?.type === 'item.started') {
        calls += 1;
        if (callId) startedCallIds.add(callId);
      }
      if (event?.type === 'item.completed') {
        if (!callId || !startedCallIds.delete(callId)) calls += 1;
        if (item.error || item.status === 'failed') {
          throw resolverError('resolution_failed', 'Configured MCP lookup failed');
        }
        successfulCalls += 1;
      }
    }
    if (event?.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
      pendingAgentMessage = item.text;
    }
    if (event?.type === 'turn.completed') {
      completed = true;
      finalAgentMessage = pendingAgentMessage;
    }
    if (event?.type === 'turn.failed' || event?.type === 'error' || item?.type === 'error') {
      throw resolverError('resolution_failed', 'Codex reported a resolver error');
    }
  }
  if (!completed) throw resolverError('invalid_provider_output', 'Codex did not complete the resolver turn');
  if (calls > RESOLVER_MAX_MCP_CALLS) {
    throw resolverError('resolver_call_limit', 'Resolver exceeded the MCP call limit');
  }
  const parsedFinal = parseFinalObject(finalAgentMessage);
  if (successfulCalls === 0) throw resolverError('resolution_failed', 'Resolver completed without an MCP lookup');
  return parsedFinal;
}

function terminateProcessGroup(child) {
  if (child.exitCode !== null) return;
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const timer = setTimeout(() => {
    try {
      if (child.exitCode === null && child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else if (child.exitCode === null) child.kill('SIGKILL');
    } catch {
      // The process group is already gone.
    }
  }, 1000);
  timer.unref?.();
}

export function runLimitedProcess({
  command,
  args,
  cwd,
  env,
  input,
  inspectStdoutLine,
  spawnProcess = spawn,
  timeoutMs = RESOLVER_TIMEOUT_MS,
  maxOutputBytes = RESOLVER_MAX_OUTPUT_BYTES,
}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnProcess(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutLineBuffer = '';
    let total = 0;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const append = (chunks, chunk, inspect = false) => {
      if (settled) return;
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > maxOutputBytes) {
        terminateProcessGroup(child);
        finish(() => reject(resolverError('resolver_output_limit', 'Resolver output exceeded the size limit')));
        return;
      }
      chunks.push(buffer);
      if (inspect) {
        stdoutLineBuffer += buffer.toString('utf8');
        const lines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = lines.pop() ?? '';
        try {
          for (const line of lines) inspectStdoutLine?.(line);
        } catch (error) {
          terminateProcessGroup(child);
          finish(() => reject(error));
        }
      }
    };
    const timeout = setTimeout(() => {
      terminateProcessGroup(child);
      finish(() => reject(resolverError('resolver_timeout', 'Resolver timed out')));
    }, timeoutMs);
    child.once('error', (error) => {
      finish(() => reject(resolverError('provider_unavailable', `Could not start ${command}`, error)));
    });
    child.stdout.on('data', (chunk) => append(stdoutChunks, chunk, true));
    child.stderr.on('data', (chunk) => append(stderrChunks, chunk));
    child.once('close', (code) => {
      finish(() => {
        try {
          if (stdoutLineBuffer) inspectStdoutLine?.(stdoutLineBuffer);
        } catch (error) {
          reject(error);
          return;
        }
        const stdout = Buffer.concat(stdoutChunks);
        const diagnosticOutput = Buffer.concat([...stderrChunks, ...stdoutChunks]);
        if (code !== 0) {
          const diagnostic = sanitizePublicText(utf8(diagnosticOutput, 'Resolver diagnostic output'));
          const auth = /auth(?:entication|orization)?|oauth|log(?:ged)?\s*in|401|403/i.test(diagnostic);
          reject(
            resolverError(
              auth ? 'authentication_required' : 'resolution_failed',
              auth
                ? `${command} resolver authentication is required`
                : `${command} resolver exited with status ${code}`,
            ),
          );
          return;
        }
        resolvePromise(stdout);
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function createToolInspector(provider, config) {
  let callCount = 0;
  const startedCodexCallIds = new Set();
  const server = config.resolver.server;
  const allowedClaude = new Set(server.enabled_tools.map((tool) => `mcp__${server.name}__${tool}`));
  const allowedCodex = new Set(server.enabled_tools);
  return (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (provider === 'codex' && event?.type === 'item.completed' && event?.item?.type === 'error') {
      throw resolverError('resolution_failed', 'Codex reported a resolver error');
    }
    if (
      provider === 'claude' &&
      (event?.message?.content ?? []).some((block) => block?.type === 'tool_result' && block.is_error)
    ) {
      throw resolverError('resolution_failed', 'Configured MCP lookup failed');
    }
    const tools = [];
    if (provider === 'claude') {
      for (const block of event?.message?.content ?? []) {
        const name = claudeToolName(block);
        if (name) tools.push({ server: server.name, tool: name });
      }
    } else {
      const identity = codexToolIdentity(event?.item);
      if (identity) tools.push(identity);
    }
    for (const tool of tools) {
      const allowed =
        provider === 'claude'
          ? allowedClaude.has(tool.tool)
          : tool.server === server.name && allowedCodex.has(tool.tool);
      if (!allowed) {
        throw resolverError(
          'resolver_tool_violation',
          `Resolver attempted disallowed tool ${tool.server}/${tool.tool}`,
        );
      }
      let countCall = true;
      if (provider === 'codex') {
        if (event?.type === 'item.completed' && (event.item.error || event.item.status === 'failed')) {
          throw resolverError('resolution_failed', 'Configured MCP lookup failed');
        }
        const callId = typeof event?.item?.id === 'string' ? event.item.id : null;
        if (event?.type === 'item.started') {
          if (callId) startedCodexCallIds.add(callId);
        } else if (event?.type === 'item.completed' && callId && startedCodexCallIds.delete(callId)) {
          countCall = false;
        }
      }
      if (countCall) callCount += 1;
      if (callCount > RESOLVER_MAX_MCP_CALLS) {
        throw resolverError('resolver_call_limit', 'Resolver exceeded the MCP call limit');
      }
    }
  };
}

async function requireFlags(command, args, required, run = execFile) {
  let output;
  try {
    const result = await run(command, args, { timeout: 10_000, maxBuffer: 512 * 1024, encoding: 'utf8' });
    output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  } catch (error) {
    throw resolverError('provider_unavailable', `Could not inspect ${command} resolver support`, error);
  }
  const missing = required.filter((flag) => !output.includes(flag));
  if (missing.length) {
    throw resolverError('provider_unsupported', `${command} lacks required resolver flags: ${missing.join(', ')}`);
  }
}

async function requireCodexFeatures(run = execFile) {
  let output;
  try {
    const result = await run('codex', ['features', 'list'], {
      timeout: 10_000,
      maxBuffer: 512 * 1024,
      encoding: 'utf8',
    });
    output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  } catch (error) {
    throw resolverError('provider_unavailable', 'Could not inspect Codex resolver features', error);
  }
  const missing = CODEX_DISABLED_FEATURES.filter((feature) => !output.includes(feature));
  if (missing.length > 0) {
    throw resolverError('provider_unsupported', `codex lacks required resolver feature keys: ${missing.join(', ')}`);
  }
}

export function validateResolverResult(value, candidates) {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success)
    throw resolverError('invalid_provider_output', 'Resolver result did not match the output contract');
  if (parsed.data.title.includes('\0') || parsed.data.summary.includes('\0')) {
    throw resolverError('invalid_provider_output', 'Resolver result contained a NUL character');
  }
  const title = parsed.data.title.trim();
  if (!title || Buffer.byteLength(title, 'utf8') > 256) {
    throw resolverError('invalid_provider_output', 'Resolver title must contain 1 to 256 UTF-8 bytes');
  }
  if (Buffer.byteLength(parsed.data.summary, 'utf8') > 64 * 1024) {
    throw resolverError('invalid_provider_output', 'Resolver summary exceeded 64 KiB');
  }
  const repositories = parsed.data.repositories;
  if (new Set(repositories).size !== repositories.length) {
    throw resolverError('invalid_provider_output', 'Resolver returned duplicate repositories');
  }
  const allowed = new Set(candidates);
  const unknown = repositories.filter((repo) => !allowed.has(repo));
  if (unknown.length) {
    throw resolverError('invalid_provider_output', `Resolver returned unknown repositories: ${unknown.join(', ')}`);
  }
  return { title, summary: parsed.data.summary, repositories };
}

export function createWorkItemResolver({ run = execFile, spawnProcess = spawn } = {}) {
  return {
    async resolve({ reference, provider, workProvider = provider, config }) {
      const directory = mkdtempSync(resolve(tmpdir(), 'patrol-resolver-'));
      try {
        let command;
        let args;
        let environment;
        if (provider === 'claude') {
          await requireFlags(
            'claude',
            ['--help'],
            [
              '--allowedTools',
              '--disable-slash-commands',
              '--input-format',
              '--json-schema',
              '--mcp-config',
              '--no-chrome',
              '--no-session-persistence',
              '--output-format',
              '--permission-mode',
              '--print',
              '--allowedTools',
              '--setting-sources',
              '--strict-mcp-config',
              '--verbose',
            ],
            run,
          );
          command = 'claude';
          args = buildClaudeResolverArgs(config);
          environment = { ...process.env };
        } else if (provider === 'codex') {
          await requireFlags(
            'codex',
            ['exec', '--help'],
            [
              '--disable',
              '--cd',
              '--config',
              '--ephemeral',
              '--ignore-rules',
              '--ignore-user-config',
              '--json',
              '--output-schema',
              '--sandbox',
              '--skip-git-repo-check',
              '--strict-config',
            ],
            run,
          );
          await requireCodexFeatures(run);
          command = 'codex';
          const schemaPath = resolve(directory, 'output-schema.json');
          writeFileSync(schemaPath, JSON.stringify(RESULT_SCHEMA), { mode: 0o600 });
          args = buildCodexResolverArgs(config, directory, schemaPath);
          environment = buildCodexEnvironment();
        } else {
          throw resolverError('invalid_provider', `Unknown resolver provider: ${provider}`);
        }

        const output = await runLimitedProcess({
          command,
          args,
          cwd: directory,
          env: environment,
          input: resolverInput(reference, config, workProvider),
          inspectStdoutLine: createToolInspector(provider, config),
          spawnProcess,
        });
        const text = utf8(output, 'Resolver output');
        const value =
          provider === 'claude' ? parseClaudeResolverOutput(text, config) : parseCodexResolverOutput(text, config);
        return validateResolverResult(value, config.repositories);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}
