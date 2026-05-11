/**
 * security.js — Phase 1 hardening
 *
 * Exports
 *   jailPath(root, userPath)   CVE-1: path traversal protection
 *   safeSpawn(cmd, args, opts) CVE-2: no-shell command execution
 *   redact(obj)                CVE-3: strip credentials from any value before logging
 *   validate(schema, data)     Input validation via Zod
 *   SCHEMAS                    Zod schemas for every public API surface
 */

import { resolve, normalize, relative, isAbsolute } from 'path';
import { spawn }                                     from 'child_process';
import { z }                                         from 'zod';

// ─── CVE-1: Path traversal protection ────────────────────────────────────────

/**
 * Resolve `userPath` relative to `root` and assert the result stays inside
 * `root`.  Throws if the resolved path escapes via `../` or absolute tricks.
 *
 * @param {string} root     Trusted base directory (absolute)
 * @param {string} userPath Untrusted path segment from user input
 * @returns {string}        Absolute path guaranteed to be inside root
 */
export function jailPath(root, userPath) {
  if (!root || typeof root !== 'string')    throw new SecurityError('jailPath: root must be a non-empty string');
  if (!userPath || typeof userPath !== 'string') throw new SecurityError('jailPath: userPath must be a non-empty string');

  const absRoot     = resolve(root);
  const absUserPath = isAbsolute(userPath)
    ? normalize(userPath)
    : resolve(absRoot, userPath);

  const rel = relative(absRoot, absUserPath);

  // relative() returns '' for identical paths, or starts with '..' when escaping
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new SecurityError(
      `Path traversal blocked: "${userPath}" resolves outside jail root "${absRoot}"`
    );
  }

  return absUserPath;
}

/**
 * Variant for checkpoint / skill-store paths: allows any absolute path but
 * enforces it must not be a sensitive system path.
 */
const BLOCKED_PREFIXES = ['/etc', '/proc', '/sys', '/dev', '/root', '/boot',
  'C:\\Windows', 'C:\\System'];

export function assertSafePath(p) {
  const abs = resolve(p);
  for (const blocked of BLOCKED_PREFIXES) {
    if (abs.startsWith(blocked)) {
      throw new SecurityError(`Blocked path: "${abs}" is in a protected system directory`);
    }
  }
  return abs;
}

// ─── CVE-2: Command injection prevention ─────────────────────────────────────

/**
 * Safe alternative to exec() / execSync().
 * Always uses spawn() with an explicit args array — never a shell string.
 * Returns a Promise<{ stdout, stderr, code }>.
 *
 * @param {string}   cmd        Executable name or absolute path
 * @param {string[]} args       Arguments array (NOT a shell string)
 * @param {object}   [opts]     Options forwarded to child_process.spawn
 */
export function safeSpawn(cmd, args = [], opts = {}) {
  // Guard: reject if any arg contains shell metacharacters
  const SHELL_METACHAR = /[;&|`$<>(){}!\n\r]/;
  for (const arg of args) {
    if (typeof arg !== 'string') throw new SecurityError(`safeSpawn: all args must be strings, got ${typeof arg}`);
    if (SHELL_METACHAR.test(arg)) throw new SecurityError(`safeSpawn: arg contains shell metacharacter: "${arg}"`);
  }

  return new Promise((resolve, reject) => {
    const stdout = [], stderr = [];
    // shell: false is the default but we make it explicit
    const child = spawn(cmd, args, { ...opts, shell: false });

    child.stdout?.on('data', d => stdout.push(d));
    child.stderr?.on('data', d => stderr.push(d));

    child.on('error', err => reject(new SecurityError(`safeSpawn failed for "${cmd}": ${err.message}`)));
    child.on('close', code => {
      const out = Buffer.concat(stdout.map(d => Buffer.isBuffer(d) ? d : Buffer.from(d))).toString();
      const err = Buffer.concat(stderr.map(d => Buffer.isBuffer(d) ? d : Buffer.from(d))).toString();
      resolve({ stdout: out, stderr: err, code });
    });
  });
}

// ─── CVE-3: Credential redaction ─────────────────────────────────────────────

const SENSITIVE_KEYS = new Set([
  'apikey', 'api_key', 'apiKey',
  'token', 'accesstoken', 'access_token', 'bearertoken', 'bearer_token',
  'password', 'passwd', 'secret', 'credential', 'credentials',
  'privatekey', 'private_key', 'signingkey', 'signing_key',
  'authorization', 'auth', 'x-api-key',
]);

const REDACTED = '[REDACTED]';

/**
 * Deep-clone and replace any sensitive field values with '[REDACTED]'.
 * Safe to pass to JSON.stringify / telemetry spans.
 *
 * @param {*} value  Any serialisable value
 * @returns {*}      Sanitised clone
 */
export function redact(value, _depth = 0) {
  if (_depth > 20) return value; // guard against circular-ish deep objects
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map(v => redact(v, _depth + 1));
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const lk = k.toLowerCase().replace(/[-_]/g, '');
    out[k] = SENSITIVE_KEYS.has(k) || SENSITIVE_KEYS.has(lk)
      ? REDACTED
      : redact(v, _depth + 1);
  }
  return out;
}

/**
 * Scrub a string for accidental credential leaks (Bearer tokens, Basic auth).
 */
export function redactString(str) {
  return str
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer [REDACTED]')
    .replace(/Basic\s+[A-Za-z0-9+/]+=*/g, 'Basic [REDACTED]')
    .replace(/(api[_-]?key[=:]\s*)([^\s&"']+)/gi, '$1[REDACTED]')
    .replace(/(sk-[a-zA-Z0-9]{20,})/g, '[REDACTED]');
}

// ─── Input validation schemas ─────────────────────────────────────────────────

const TIER        = z.enum(['haiku', 'sonnet', 'opus']);
const AGENT_ID    = z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i);
const FILE_PATH   = z.string().min(1).max(4096);
const TASK_STRING = z.string().min(1).max(32_768);
const BENCHMARK_ID = z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i);
const TIMEOUT_MS  = z.number().int().min(100).max(3_600_000).default(120_000);

export const SCHEMAS = {
  /** MasterAgent constructor options */
  masterOpts: z.object({
    agents:      z.array(z.object({
      id:      AGENT_ID,
      type:    z.string().min(1).max(32),
      tier:    TIER.optional(),
      model:   z.string().optional(),
      apiKey:  z.string().optional(),
    })).default([]),
    mcpServers:  z.array(z.object({
      name:      z.string().min(1).max(64),
      url:       z.string().url(),
      transport: z.enum(['http', 'ws', 'stdio']).default('http'),
    })).default([]),
    useSkills:   z.boolean().default(true),
    useCache:    z.boolean().default(true),
    useWorktree: z.boolean().default(true),
    checkpoint:  FILE_PATH.default('.swarm/checkpoints'),
    forceTier:   TIER.optional(),
    forceAgent:  AGENT_ID.optional(),
    timeout:     TIMEOUT_MS,
  }).passthrough(),

  /** run(task) argument */
  runTask: z.object({
    task: TASK_STRING,
  }),

  /** EvalHarness.run() suite argument */
  evalSuite: z.union([
    z.enum(['quick', 'full']),
    BENCHMARK_ID,
  ]),

  /** addBenchmark() argument */
  benchmark: z.object({
    id:          BENCHMARK_ID,
    category:    z.string().min(1).max(32),
    description: z.string().min(1).max(256),
    prompt:      TASK_STRING,
    judge:       z.function().args(z.string()).returns(z.number()),
  }),

  /** SkillStore.add() argument */
  skill: z.object({
    type:    z.enum(['rag', 'routing', 'tool', 'combo']),
    agentId: AGENT_ID.optional(),
    content: z.string().min(1).max(65_536),
    score:   z.number().min(0).max(1),
  }).passthrough(),

  /** CheckpointManager paths */
  checkpointDir: FILE_PATH,

  /** CLI run options */
  cliRunOpts: z.object({
    agent:    AGENT_ID.optional(),
    tier:     TIER.optional(),
    timeout:  TIMEOUT_MS,
    skills:   z.boolean().default(true),
    cache:    z.boolean().default(true),
    worktree: z.boolean().default(true),
  }).passthrough(),
};

/**
 * Validate `data` against `schema`. Returns parsed (coerced) data on success.
 * Throws a descriptive SecurityError on failure.
 *
 * @param {z.ZodType} schema
 * @param {*}         data
 * @returns {*}       Parsed data
 */
export function validate(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.errors
      .map(e => `${e.path.join('.')}: ${e.message}`)
      .join('; ');
    throw new SecurityError(`Validation failed — ${msg}`);
  }
  return result.data;
}

// ─── Error class ──────────────────────────────────────────────────────────────

export class SecurityError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'SecurityError';
  }
}
