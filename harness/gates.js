/**
 * Static confinement adapter for task-declared eligibility gates.
 *
 * Fail closed when the platform confinement primitive is unavailable or a safe
 * policy cannot be constructed — never run gate command strings bare.
 * Command strings are passed as exact literals to `/bin/sh -c` under confinement only.
 *
 * Oracle contract (commandless XOR declared command — never both):
 *   gate.oraclePath is relative to the suite oracles/ root only (path-contained).
 *   Harness builds a controlled argv command string from the script extension:
 *     .js/.mjs/.cjs → `node <absOraclePath>`
 *     .sh/.bash     → `bash <absOraclePath>`
 *   cwd = workspace; WORKSPACE_DIR is set to the absolute workspace path.
 *   Task-declared `command` (when present alone) is never rewritten — it runs as-is.
 *   Setting both command and oraclePath fails closed (execution_unavailable / INFRA_FAIL).
 *   Result oraclePath is set only when that exclusive path was executed under confinement.
 *
 * macOS: deny-default seatbelt — process-exec; reads only workspace/private-tmp/system
 *        toolchain roots (+ oracle path roots when executing oracles); writes only
 *        workspace + private tmp; network per task policy.
 * Linux: explicit ro-bind of system/toolchain roots only (never / or $HOME),
 *        writable workspace, private tmpfs, die-with-parent, network unshare when denied.
 *
 * Requirements evidence contract:
 *   substantiation "test"|"tests": require non-empty artifactRef (metadata only —
 *     not executed by evaluateRequirements) and a prior passed required gate
 *     named by evidenceGate (default "tests"). No silent bind to unrelated gates.
 *   substantiation "static" (and other non-test): require explicit evidenceGate,
 *     gate, or oraclePath metadata on the mustHave item binding to a prior passed
 *     gate — never name-substring heuristics on the substantiation keyword.
 *   artifactRef is declaration metadata only; pass/fail evidence is always the
 *     exact bound gate result, never "artifactRef was executed".
 */

import { spawn } from 'node:child_process';
import { access, constants, mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sha256Buffer } from './digest.js';
import {
  DEFAULT_CAPTURE_LIMIT,
  spawnControlled,
} from './invokers/spawn-controlled.js';
import { PathEscapeError, resolveUnder } from './paths.js';

/** Gates that are structural / non-command-executable without a command field. */
const STRUCTURAL_GATES = new Set(['baseline-diff', 'requirements']);

/** Protected path prefixes that baseline-diff rejects when modified. */
const PROTECTED_PATH_PREFIXES = Object.freeze([
  'test/',
  'tests/',
  'src/test/',
  '__tests__/',
  'scripts/',
  'oracle/',
  'oracles/',
  'baseline/',
]);

const EVIDENCE_TRUNCATE = 8192;
const DEFAULT_GATE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Always-present base keys for confined gate commands (minimal deterministic env).
 * Values are taken from the parent process when present; never full process.env.
 */
export const GATE_CORE_ENV_KEYS = Object.freeze(['PATH']);

/**
 * Optional platform keys included only when sandboxMode is not restrictive.
 * Still taken as names from parent — never invented secret values.
 */
export const GATE_PLATFORM_ENV_KEYS = Object.freeze([
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'USER',
  'LOGNAME',
  'TERM',
]);

/** Keys kept even under restrictive sandbox (tools often need a tmp/home). */
export const GATE_RESTRICTIVE_ENV_KEYS = Object.freeze([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
]);

/** Explicit system/toolchain roots candidates (missing paths skipped). */
export const SYSTEM_TOOLCHAIN_ROOTS = Object.freeze([
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/opt/homebrew',
  '/opt/local',
  '/Library/Developer/CommandLineTools',
  '/System/Library/Frameworks',
  '/System/Library/CoreServices',
  '/private/var/select',
  '/dev',
  '/proc',
  '/etc',
]);

/**
 * @typedef {object} ConfinementInfo
 * @property {boolean} available
 * @property {'sandbox-exec' | 'bwrap' | null} kind
 * @property {string | null} binary
 * @property {string} [reason]
 */

/**
 * @typedef {object} GateResult
 * @property {string} gate
 * @property {number} order
 * @property {boolean} required
 * @property {string | null} command
 * @property {number} expectedExitCode
 * @property {'passed' | 'failed' | 'skipped' | 'execution_unavailable' | 'structural'} status
 * @property {number | null} exitCode
 * @property {boolean} timedOut
 * @property {string} [stdoutDigest]
 * @property {string} [stderrDigest]
 * @property {string} [evidence]
 * @property {string} [infraFailure]
 * @property {'PASS' | 'FAIL' | 'INFRA_FAIL' | 'TIMEOUT' | null} classificationSignal
 * @property {string} [check]
 * @property {string} [oraclePath] exclusive oracle path executed under confinement
 * @property {boolean} [oracleExecuted] true only when oraclePath was the exclusive executed source
 */

/**
 * @param {unknown} sandboxMode
 * @returns {boolean}
 */
export function isRestrictiveSandboxMode(sandboxMode) {
  if (sandboxMode == null) return false;
  const s = String(sandboxMode).trim().toLowerCase();
  return (
    s === 'restrictive' ||
    s === 'strict' ||
    s === 'minimal' ||
    s === 'confined' ||
    s === 'deny'
  );
}

/**
 * @param {unknown} name
 * @returns {boolean}
 */
function isSafeEnvName(name) {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * Fixed non-sensitive names that envAllowlist may add beyond the base set.
 * Primary policy is this safe-name whitelist — not a credential denylist.
 */
export const GATE_SAFE_ALLOWLIST_NAMES = Object.freeze([
  'NODE_ENV',
  'CI',
  'FORCE_COLOR',
  'NO_COLOR',
  'TZ',
  'LANG',
  'LC_ALL',
]);

const GATE_SAFE_ALLOWLIST_SET = new Set(GATE_SAFE_ALLOWLIST_NAMES);

/** Constrained config vars: AICB_GATE_CFG_[A-Z0-9_]+ with safe value contract. */
export const GATE_CFG_NAME_RE = /^AICB_GATE_CFG_[A-Z0-9_]+$/;
/** Safe values for AICB_GATE_CFG_* (no URI schemes, cookies, shell metachar, spaces). */
export const GATE_CFG_VALUE_RE = /^[A-Za-z0-9._+/-]+$/;
export const GATE_CFG_VALUE_MAX_LEN = 128;

/**
 * Bounded identifier syntax for adapter reasonCode / outcome fields in ordinary
 * and exported records. Free-form text must not use this path (quarantine only).
 * @type {RegExp}
 */
export const BOUNDED_IDENTIFIER_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBoundedIdentifier(value) {
  return typeof value === 'string' && BOUNDED_IDENTIFIER_RE.test(value);
}

/**
 * Keep only bounded identifiers; free-form strings become null (fail closed).
 * @param {unknown} value
 * @returns {string | null}
 */
export function sanitizeBoundedIdentifier(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === '') return null;
  return isBoundedIdentifier(s) ? s : null;
}

/**
 * @param {unknown} name
 * @returns {boolean}
 */
export function isGateCfgEnvName(name) {
  return typeof name === 'string' && GATE_CFG_NAME_RE.test(name);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeGateCfgValue(value) {
  if (value == null) return false;
  const s = String(value);
  if (s.length === 0 || s.length > GATE_CFG_VALUE_MAX_LEN) return false;
  if (!GATE_CFG_VALUE_RE.test(s)) return false;
  // Reject JWT-shaped values even though base64url fits the charset.
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s)) return false;
  return true;
}

/**
 * Primary allowlist: name is either a fixed safe name or AICB_GATE_CFG_*.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isAllowlistedGateEnvName(name) {
  if (typeof name !== 'string' || !isSafeEnvName(name)) return false;
  if (GATE_SAFE_ALLOWLIST_SET.has(name)) return true;
  if (isGateCfgEnvName(name)) return true;
  return false;
}

/**
 * Secondary denylist: credential / capability-like names (defense in depth).
 * Primary admission is isAllowlistedGateEnvName — this never admits new names.
 *
 * Covers: API keys, tokens, secrets, passwords/passphrases, credentials,
 * private/access/secret keys, authorization/bearer, SSH_AUTH_SOCK, DB URLs,
 * cookies, JWTs, and common cloud/GitHub credential names.
 * Provider invoker env is unaffected (gates only).
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isCredentialLikeEnvKey(name) {
  if (typeof name !== 'string' || name.trim() === '') return false;
  const n = name.trim().toUpperCase();

  // Exact known credential / agent capability / connection-string names
  const EXACT = new Set([
    'SSH_AUTH_SOCK',
    'SSH_AGENT_PID',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_SECURITY_TOKEN',
    'AZURE_CLIENT_SECRET',
    'AZURE_CLIENT_ID',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GCLOUD_KEY_FILE',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'GITLAB_TOKEN',
    'NPM_TOKEN',
    'NODE_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'XAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'HUGGINGFACE_TOKEN',
    'HF_TOKEN',
    'AUTHORIZATION',
    'BEARER',
    'PASSWORD',
    'PASSPHRASE',
    'PASSWD',
    'SECRET',
    'CREDENTIALS',
    'CREDENTIAL',
    'DATABASE_URL',
    'DB_URL',
    'DSN',
    'CONNECTION_STRING',
    'MONGO_URL',
    'MONGODB_URI',
    'REDIS_URL',
    'COOKIE',
    'COOKIES',
    'HTTP_COOKIE',
    'JWT',
    'ID_TOKEN',
    'ACCESS_TOKEN',
    'REFRESH_TOKEN',
  ]);
  if (EXACT.has(n)) return true;

  // Substring / structural patterns (underscore-delimited credential vocabulary)
  if (
    /(?:^|_)(?:API_?KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|AUTH_TOKEN|BEARER|AUTHORIZATION)(?:_|$)/.test(
      n,
    )
  ) {
    return true;
  }
  if (/(?:^|_)(?:SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?)(?:_|$)/.test(n)) {
    return true;
  }
  if (/(?:^|_)TOKEN(?:_|$)/.test(n)) {
    return true;
  }
  // e.g. FOO_APIKEY, FOOAPIKEY as whole segments
  if (/(?:^|_)APIKEY(?:_|$)/.test(n)) {
    return true;
  }
  // DB / DSN / connection-string vocabulary
  if (
    /(?:^|_)(?:DATABASE_URL|DB_URL|DSN|CONNECTION_STRING|JDBC_URL|MONGO(?:DB)?_URL|REDIS_URL)(?:_|$)/.test(
      n,
    )
  ) {
    return true;
  }
  if (/(?:^|_)(?:COOKIE|JWT)(?:_|$)/.test(n)) return true;
  // Sentinel / harness test secrets and anything with SECRET in the name
  if (n.includes('SECRET')) return true;
  if (n.includes('PASSWORD') || n.includes('PASSPHRASE')) return true;
  if (n.endsWith('_CREDENTIALS') || n.endsWith('_CREDENTIAL')) return true;

  return false;
}

/**
 * Normalize envAllowlist to an ordered unique list under the **safe-name whitelist**.
 * Accepts array of names or object keys (values ignored — only names admitted).
 *
 * Primary policy: only GATE_SAFE_ALLOWLIST_NAMES or AICB_GATE_CFG_[A-Z0-9_]+.
 * Secondary: credential-like names still fail closed (defense in depth).
 *
 * @param {string[] | Record<string, unknown> | null | undefined} envAllowlist
 * @returns {string[]}
 */
export function normalizeEnvAllowlist(envAllowlist) {
  if (envAllowlist == null) return [];
  /** @type {string[]} */
  let names;
  if (Array.isArray(envAllowlist)) {
    names = envAllowlist.map(String);
  } else if (typeof envAllowlist === 'object') {
    names = Object.keys(envAllowlist).map(String);
  } else {
    throw new Error(
      'buildGateEnv: envAllowlist must be an array of names, object, null, or undefined',
    );
  }
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    if (!isSafeEnvName(n)) {
      throw new Error(
        `buildGateEnv: envAllowlist name "${n}" is not a valid environment variable identifier`,
      );
    }
    if (!isAllowlistedGateEnvName(n)) {
      throw new Error(
        `buildGateEnv: envAllowlist name "${n}" is not on the safe allowlist ` +
          `(only ${GATE_SAFE_ALLOWLIST_NAMES.join(', ')}, or AICB_GATE_CFG_[A-Z0-9_]+); fail closed`,
      );
    }
    // Secondary denylist — never admit credential/capability names even if
    // they somehow matched a prefix pattern (e.g. AICB_GATE_CFG_*_SECRET).
    if (isCredentialLikeEnvKey(n)) {
      throw new Error(
        `buildGateEnv: envAllowlist must not include credential/capability variable "${n}" (gates never receive secrets even when an arm requests them)`,
      );
    }
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Build a minimal deterministic environment for gate commands.
 *
 * Never copies full process.env. Composes:
 * - explicit small base (PATH + platform-required vars when not restrictive)
 * - arm envAllowlist under the **safe-name whitelist** contract only:
 *     fixed safe names (NODE_ENV, CI, …) or AICB_GATE_CFG_* with value contract
 *
 * Fail closed for anything else (DB URLs, JWTs, cookies, cloud/SSH credentials)
 * even when networkPolicy.allowed=true. Provider invoker env is separate.
 * Task YAML must never contribute environment.
 *
 * @param {object} [opts]
 * @param {string[] | Record<string, unknown> | null | undefined} [opts.envAllowlist]
 * @param {string | null | undefined} [opts.sandboxMode]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined> | null} [opts.parentEnv]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildGateEnv(opts = {}) {
  const parent =
    opts.parentEnv != null && typeof opts.parentEnv === 'object'
      ? opts.parentEnv
      : process.env;
  const restrictive = isRestrictiveSandboxMode(opts.sandboxMode);
  const baseKeys = restrictive
    ? GATE_RESTRICTIVE_ENV_KEYS
    : [...GATE_CORE_ENV_KEYS, ...GATE_PLATFORM_ENV_KEYS];

  /** @type {NodeJS.ProcessEnv} */
  const out = Object.create(null);

  for (const key of baseKeys) {
    // Base keys are never credential-like by construction (PATH/HOME/TMPDIR/…).
    if (isCredentialLikeEnvKey(key)) continue;
    if (
      Object.prototype.hasOwnProperty.call(parent, key) &&
      parent[key] != null &&
      parent[key] !== ''
    ) {
      out[key] = String(parent[key]);
    }
  }

  // PATH is required for toolchain discovery; provide a minimal Unix fallback.
  if (out.PATH == null || out.PATH === '') {
    if (parent.PATH != null && String(parent.PATH) !== '') {
      out.PATH = String(parent.PATH);
    } else if (process.platform === 'win32') {
      out.PATH = String(parent.Path || parent.PATH || '');
    } else {
      out.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    }
  }

  // Fail closed: normalizeEnvAllowlist throws on non-allowlisted / credential names.
  const allowlist = normalizeEnvAllowlist(opts.envAllowlist);
  for (const name of allowlist) {
    if (!isAllowlistedGateEnvName(name) || isCredentialLikeEnvKey(name)) {
      throw new Error(
        `buildGateEnv: refused non-allowlisted or credential-like envAllowlist name "${name}"`,
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(parent, name) &&
      parent[name] != null
    ) {
      const value = String(parent[name]);
      if (isGateCfgEnvName(name) && !isSafeGateCfgValue(value)) {
        throw new Error(
          `buildGateEnv: value for "${name}" fails AICB_GATE_CFG safe-value contract ` +
            `(max ${GATE_CFG_VALUE_MAX_LEN} chars, charset [A-Za-z0-9._+/-], no JWT-shaped values)`,
        );
      }
      out[name] = value;
    }
  }

  // Final belt-and-suspenders: never emit credential-like keys; drop any
  // non-base key that is not on the safe allowlist contract.
  const baseKeySet = new Set(baseKeys);
  for (const key of Object.keys(out)) {
    if (isCredentialLikeEnvKey(key)) {
      delete out[key];
      continue;
    }
    if (!baseKeySet.has(key) && !isAllowlistedGateEnvName(key)) {
      delete out[key];
    }
  }

  return out;
}

/**
 * Strip secret-bearing previews from gate results for ordinary result surfaces.
 * Keeps digests / status / evidence classification fields only.
 * @param {unknown} gateResults
 * @returns {unknown}
 */
export function sanitizeGateResultsForStorage(gateResults) {
  if (!Array.isArray(gateResults)) return gateResults;
  return gateResults.map((g) => {
    if (!g || typeof g !== 'object') return g;
    const {
      gate,
      order,
      required,
      command,
      expectedExitCode,
      status,
      exitCode,
      timedOut,
      stdoutDigest,
      stderrDigest,
      evidence,
      infraFailure,
      classificationSignal,
      check,
      oraclePath,
      oracleExecuted,
    } = /** @type {Record<string, unknown>} */ (g);
    /** @type {Record<string, unknown>} */
    const clean = {
      gate,
      order,
      required,
      command,
      expectedExitCode,
      status,
      exitCode,
      timedOut,
      classificationSignal,
    };
    if (stdoutDigest != null) clean.stdoutDigest = stdoutDigest;
    if (stderrDigest != null) clean.stderrDigest = stderrDigest;
    if (evidence != null) clean.evidence = evidence;
    if (infraFailure != null) clean.infraFailure = infraFailure;
    if (check != null) clean.check = check;
    // oraclePath is execution evidence only when exclusive path was run under confinement
    if (oraclePath != null && oracleExecuted === true) {
      clean.oraclePath = oraclePath;
      clean.oracleExecuted = true;
    }
    return clean;
  });
}

/**
 * @param {string} name
 * @returns {Promise<string | null>}
 */
async function findOnPath(name) {
  const pathEnv = process.env.PATH || '';
  const parts = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of parts) {
    const candidate = path.join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* continue */
    }
  }
  return null;
}

/**
 * Detect platform confinement primitive availability (does not execute gates).
 * @returns {Promise<ConfinementInfo>}
 */
export async function detectConfinement() {
  if (process.platform === 'darwin') {
    const binary = '/usr/bin/sandbox-exec';
    try {
      await access(binary, constants.X_OK);
      return { available: true, kind: 'sandbox-exec', binary };
    } catch {
      return {
        available: false,
        kind: null,
        binary: null,
        reason:
          'macOS sandbox-exec not found or not executable at /usr/bin/sandbox-exec',
      };
    }
  }

  if (process.platform === 'linux') {
    const binary = await findOnPath('bwrap');
    if (binary) {
      return { available: true, kind: 'bwrap', binary };
    }
    return {
      available: false,
      kind: null,
      binary: null,
      reason: 'Linux bubblewrap (bwrap) not found on PATH',
    };
  }

  return {
    available: false,
    kind: null,
    binary: null,
    reason: `no supported confinement primitive for platform "${process.platform}"`,
  };
}

/**
 * @param {string} text
 * @returns {{ digest: string, preview: string }}
 */
function digestAndPreview(text) {
  const s = text ?? '';
  const digest = sha256Buffer(Buffer.from(s, 'utf8'));
  const preview =
    s.length > EVIDENCE_TRUNCATE
      ? `${s.slice(0, EVIDENCE_TRUNCATE)}\n…[truncated ${s.length - EVIDENCE_TRUNCATE} chars]`
      : s;
  return { digest, preview };
}

/**
 * Escape a path for safe interpolation into a seatbelt profile literal/subpath.
 * @param {string} p
 * @returns {string}
 */
export function escapeSeatbeltPath(p) {
  return String(p)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '')
    .replace(/\n/g, '');
}

/**
 * Resolve existing system/toolchain roots (skip missing). Never includes $HOME.
 * @param {string[]} [candidates]
 * @returns {Promise<string[]>}
 */
export async function resolveExistingToolchainRoots(
  candidates = SYSTEM_TOOLCHAIN_ROOTS,
) {
  const home = path.resolve(os.homedir());
  /** @type {string[]} */
  const out = [];
  for (const c of candidates) {
    const abs = path.resolve(c);
    if (abs === home || abs.startsWith(home + path.sep)) {
      continue;
    }
    if (abs === '/' || abs === '') {
      continue;
    }
    try {
      const st = await stat(abs);
      if (st.isDirectory() || st.isFile()) {
        out.push(abs);
      }
    } catch {
      /* skip missing */
    }
  }
  // Always include directory of the node binary when available
  try {
    const nodeDir = path.dirname(process.execPath);
    if (
      nodeDir &&
      nodeDir !== '/' &&
      nodeDir !== home &&
      !nodeDir.startsWith(home + path.sep) &&
      !out.includes(nodeDir)
    ) {
      const st = await stat(nodeDir);
      if (st.isDirectory()) out.push(nodeDir);
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * Build a deny-default macOS seatbelt profile.
 * Reads only from workspace, private tmp, and explicit system/toolchain roots.
 * Writes only under workspace + private tmp. No unrestricted file-read*.
 *
 * @param {string} workspaceDir absolute
 * @param {string} privateTmp absolute
 * @param {boolean} networkAllowed
 * @param {string[]} [readRoots] existing toolchain roots
 * @returns {string}
 */
export function buildSeatbeltProfile(
  workspaceDir,
  privateTmp,
  networkAllowed,
  readRoots = [],
) {
  const ws = escapeSeatbeltPath(path.resolve(workspaceDir));
  const tmp = escapeSeatbeltPath(path.resolve(privateTmp));
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    // Workspace + private tmp reads/writes
    `(allow file-read* (subpath "${ws}"))`,
    `(allow file-read* (subpath "${tmp}"))`,
    `(allow file-write* (subpath "${ws}"))`,
    `(allow file-write* (subpath "${tmp}"))`,
    // Device nodes
    '(allow file-read* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper"))',
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper"))',
  ];
  for (const root of readRoots) {
    const abs = path.resolve(root);
    if (abs === '/' || abs === '') continue;
    const esc = escapeSeatbeltPath(abs);
    lines.push(`(allow file-read* (subpath "${esc}"))`);
  }
  if (networkAllowed) {
    lines.push('(allow network*)');
  } else {
    lines.push('(deny network*)');
  }
  const profile = `${lines.join('\n')}\n`;
  if (/\(allow default\)/.test(profile)) {
    throw new Error('refusing seatbelt profile containing (allow default)');
  }
  // Bare unrestricted (allow file-read*) without a filter is forbidden
  if (/(?:^|\n)\(allow file-read\*\)\s*(?:\n|$)/.test(profile)) {
    throw new Error('refusing unrestricted (allow file-read*) in seatbelt profile');
  }
  return profile;
}

/**
 * Whether a relative path is Poetic/harness bookkeeping (not meaningful edits).
 * @param {string} relPath
 * @returns {boolean}
 */
export function isBookkeepingPath(relPath) {
  const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return (
    norm === '.poetic' ||
    norm.startsWith('.poetic/') ||
    norm === '.aicb-workspace' ||
    norm.startsWith('.git/')
  );
}

/**
 * Whether a relative path is protected (tests/validators/oracles/etc.).
 * @param {string} relPath
 * @returns {boolean}
 */
export function isProtectedPath(relPath) {
  const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (isBookkeepingPath(norm)) return false;
  for (const prefix of PROTECTED_PATH_PREFIXES) {
    if (norm === prefix.slice(0, -1) || norm.startsWith(prefix)) {
      return true;
    }
  }
  if (/(^|\/)(check[-_].+|oracle[-_].+)$/i.test(norm)) {
    return true;
  }
  if (/(^|\/)oracles?\//i.test(norm)) {
    return true;
  }
  return false;
}

/**
 * Parse git status --porcelain / diff --name-only lines into relative paths.
 * @param {string} text
 * @returns {string[]}
 */
export function parseChangedPaths(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (/^[ MADRCU?!]{1,2}\s+/.test(line)) {
        const rest = line.slice(2).trim();
        if (rest.includes(' -> ')) {
          return rest.split(' -> ').pop().trim();
        }
        return rest.replace(/^"+|"+$/g, '');
      }
      return line;
    })
    .filter(Boolean);
}

/**
 * Filter out bookkeeping paths (.poetic/**, etc.).
 * Shared by baseline-diff and changed-file counting.
 * @param {string[]} paths
 * @returns {string[]}
 */
export function filterMeaningfulChangedPaths(paths) {
  return paths.filter((p) => p && !isBookkeepingPath(p));
}

/**
 * Count meaningful changed files from git status --porcelain output.
 * @param {string} porcelainText
 * @returns {number}
 */
export function countMeaningfulChangedFiles(porcelainText) {
  return filterMeaningfulChangedPaths(parseChangedPaths(porcelainText)).length;
}

/**
 * Evaluate baseline-diff: controlled git argv only; reject protected path edits.
 * @param {object} opts
 * @param {string} opts.workspaceDir
 * @param {Record<string, unknown>} opts.gate
 * @returns {Promise<GateResult>}
 */
export async function evaluateBaselineDiff({ workspaceDir, gate }) {
  const name = typeof gate.gate === 'string' ? gate.gate : 'baseline-diff';
  const order = typeof gate.order === 'number' ? gate.order : 1;
  const required = gate.required === undefined ? true : Boolean(gate.required);
  const check = typeof gate.check === 'string' ? gate.check : undefined;

  const status = await spawnControlled({
    command: 'git',
    args: ['-C', path.resolve(workspaceDir), 'status', '--porcelain'],
    timeoutMs: 15_000,
    captureLimit: DEFAULT_CAPTURE_LIMIT,
  });

  if (status.infraFailure || status.timedOut || status.exitCode !== 0) {
    return {
      gate: name,
      order,
      required,
      command: null,
      expectedExitCode: 0,
      status: 'execution_unavailable',
      exitCode: status.exitCode,
      timedOut: Boolean(status.timedOut),
      evidence: status.infraFailure || status.stderr || 'git status failed',
      infraFailure: status.infraFailure || 'git status unavailable',
      classificationSignal: 'INFRA_FAIL',
      check,
    };
  }

  const changed = filterMeaningfulChangedPaths(parseChangedPaths(status.stdout));
  const protectedHits = changed.filter((p) => isProtectedPath(p));

  if (protectedHits.length > 0) {
    return {
      gate: name,
      order,
      required,
      command: null,
      expectedExitCode: 0,
      status: 'failed',
      exitCode: 1,
      timedOut: false,
      evidence: `protected paths modified: ${protectedHits.join(', ')}`,
      classificationSignal: 'FAIL',
      check,
    };
  }

  return {
    gate: name,
    order,
    required,
    command: null,
    expectedExitCode: 0,
    status: 'passed',
    exitCode: 0,
    timedOut: false,
    evidence: `baseline-diff ok; ${changed.length} meaningful changed path(s), none protected`,
    classificationSignal: 'PASS',
    check,
  };
}

/**
 * Whether a prior gate result counts as a passed required-style success.
 * @param {Record<string, unknown>} g
 * @returns {boolean}
 */
function isPassedGateResult(g) {
  if (!g || typeof g !== 'object') return false;
  if (g.status === 'passed' || g.classificationSignal === 'PASS') return true;
  return false;
}

/**
 * Explicit evidence-gate name from a mustHave item (no substring heuristics).
 * @param {Record<string, unknown>} item
 * @returns {string | null}
 */
export function resolveItemEvidenceGateName(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.evidenceGate === 'string' && item.evidenceGate.trim()) {
    return item.evidenceGate.trim();
  }
  if (typeof item.gate === 'string' && item.gate.trim()) {
    return item.gate.trim();
  }
  return null;
}

/**
 * Find a prior gate result by exact gate name.
 * @param {Array<Record<string, unknown>>} prior
 * @param {string} gateName
 * @returns {Record<string, unknown> | undefined}
 */
function findPriorGateByName(prior, gateName) {
  return prior.find((g) => g && String(g.gate) === gateName);
}

/**
 * True when a prior gate result may substantiate an oraclePath binding:
 * exclusive oracle-path execution under confinement recorded oraclePath.
 * Rejects mixed/claimed paths without oracleExecuted (fail closed).
 *
 * @param {Record<string, unknown> | null | undefined} g
 * @param {string} oraclePathRel
 * @returns {boolean}
 */
export function isExclusiveOraclePathEvidence(g, oraclePathRel) {
  if (!g || typeof g !== 'object') return false;
  if (typeof g.oraclePath !== 'string') return false;
  const norm = String(oraclePathRel).replace(/\\/g, '/');
  if (g.oraclePath.replace(/\\/g, '/') !== norm) return false;
  // Require explicit exclusive-execution flag; unexecuted / mixed claims fail closed.
  if (g.oracleExecuted !== true) return false;
  return true;
}

/**
 * Find a prior oracle gate matching an explicit oraclePath metadata binding.
 * Only exclusive executed oraclePath evidence qualifies.
 * @param {Array<Record<string, unknown>>} prior
 * @param {string} oraclePathRel
 * @returns {Record<string, unknown> | undefined}
 */
function findPriorOracleByPath(prior, oraclePathRel) {
  return prior.find(
    (g) =>
      g &&
      String(g.gate) === 'oracle' &&
      isExclusiveOraclePathEvidence(g, oraclePathRel),
  );
}

/**
 * Evaluate requirements from prior ordered gate results via explicit evidence binding.
 *
 * - substantiation "test"|"tests": requires non-empty artifactRef (metadata only;
 *   not executed here) and a prior passed required gate named by evidenceGate
 *   (default "tests").
 * - substantiation "static" (and other non-test): requires explicit evidenceGate, gate,
 *   or oraclePath on the mustHave item binding to a prior passed gate.
 * - Never binds via substantiation-name substring matching.
 * - artifactRef is never treated as an executable command; a nonempty artifactRef
 *   does not imply it was run. Passed evidence is always the exact bound gate result.
 *
 * @param {object} opts
 * @param {Record<string, unknown>} opts.gate
 * @param {object} [opts.task]
 * @param {Array<Record<string, unknown>>} [opts.priorGateResults]
 * @returns {Promise<GateResult>}
 */
export async function evaluateRequirements({
  gate,
  task,
  priorGateResults = [],
}) {
  const name = typeof gate.gate === 'string' ? gate.gate : 'requirements';
  const order = typeof gate.order === 'number' ? gate.order : 1;
  const required = gate.required === undefined ? true : Boolean(gate.required);
  const check = typeof gate.check === 'string' ? gate.check : undefined;
  const prior = Array.isArray(priorGateResults) ? priorGateResults : [];

  const expected =
    task && typeof task === 'object' ? task.expectedOutcome : null;
  if (!expected || typeof expected !== 'object') {
    return {
      gate: name,
      order,
      required,
      command: null,
      expectedExitCode: 0,
      status: 'execution_unavailable',
      exitCode: null,
      timedOut: false,
      evidence:
        'requirements: expectedOutcome missing; cannot evaluate substantiation',
      infraFailure: 'requirements_evidence_unavailable',
      classificationSignal: 'INFRA_FAIL',
      check,
    };
  }

  const mustHave = Array.isArray(expected.mustHave) ? expected.mustHave : null;
  if (!mustHave || mustHave.length === 0) {
    return {
      gate: name,
      order,
      required,
      command: null,
      expectedExitCode: 0,
      status: 'execution_unavailable',
      exitCode: null,
      timedOut: false,
      evidence:
        'requirements: expectedOutcome.mustHave empty; cannot evaluate substantiation',
      infraFailure: 'requirements_evidence_unavailable',
      classificationSignal: 'INFRA_FAIL',
      check,
    };
  }

  /** @type {string[]} */
  const unsatisfied = [];
  /** @type {string[]} */
  const unavailable = [];

  for (const item of mustHave) {
    if (!item || typeof item !== 'object') {
      unsatisfied.push('(invalid mustHave item)');
      continue;
    }
    const id = item.id != null ? String(item.id) : '(no-id)';
    const substantiation = String(item.substantiation ?? '')
      .trim()
      .toLowerCase();
    const artifactRef =
      typeof item.artifactRef === 'string' ? item.artifactRef.trim() : '';
    const explicitGate = resolveItemEvidenceGateName(item);
    const itemOraclePath =
      typeof item.oraclePath === 'string' && item.oraclePath.trim()
        ? item.oraclePath.trim()
        : null;

    if (!substantiation) {
      unavailable.push(
        `${id}: missing substantiation; cannot map to a gate result`,
      );
      continue;
    }

    if (substantiation === 'test' || substantiation === 'tests') {
      // Tests evidence contract: artifactRef is declared metadata only (not executed
      // here); pass/fail is the prior gate named by evidenceGate (default "tests").
      if (!artifactRef) {
        unavailable.push(
          `${id}: substantiation=test requires non-empty artifactRef metadata (not executed by requirements; bound gate supplies evidence)`,
        );
        continue;
      }
      const evidenceName = explicitGate || 'tests';
      const bound = findPriorGateByName(prior, evidenceName);
      if (bound && bound.required !== false && isPassedGateResult(bound)) {
        continue;
      }
      if (bound && bound.status === 'failed') {
        unsatisfied.push(
          `${id}: evidenceGate "${evidenceName}" failed (substantiation=test; artifactRef metadata=${artifactRef})`,
        );
      } else if (bound && bound.status === 'execution_unavailable') {
        unavailable.push(
          `${id}: evidenceGate "${evidenceName}" execution_unavailable`,
        );
      } else {
        unavailable.push(
          `${id}: no passed required gate "${evidenceName}" for substantiation=test (artifactRef metadata only=${artifactRef})`,
        );
      }
      continue;
    }

    // Static / oracle / other non-test: explicit metadata only — no substring heuristics.
    if (!explicitGate && !itemOraclePath) {
      unavailable.push(
        `${id}: substantiation="${substantiation}" requires explicit evidenceGate, gate, or oraclePath metadata`,
      );
      continue;
    }

    /** @type {Record<string, unknown> | undefined} */
    let bound;
    /** @type {string} */
    let bindLabel;

    if (itemOraclePath) {
      bound = findPriorOracleByPath(prior, itemOraclePath);
      // Also accept a named gate only when it carries exclusive oracle execution evidence.
      if (!bound && explicitGate) {
        const byName = findPriorGateByName(prior, explicitGate);
        if (byName && isExclusiveOraclePathEvidence(byName, itemOraclePath)) {
          bound = byName;
        }
      }
      if (!bound && !explicitGate) {
        // Fall back: any prior result with exclusive executed oraclePath evidence.
        bound = prior.find((g) =>
          isExclusiveOraclePathEvidence(g, itemOraclePath),
        );
      }
      bindLabel = `oraclePath=${itemOraclePath}`;
    } else {
      bound = findPriorGateByName(prior, /** @type {string} */ (explicitGate));
      bindLabel = `evidenceGate=${explicitGate}`;
    }

    if (bound && bound.required !== false && isPassedGateResult(bound)) {
      continue;
    }
    if (bound && bound.status === 'failed') {
      unsatisfied.push(
        `${id}: bound gate failed (${bindLabel})`,
      );
    } else if (bound && bound.status === 'execution_unavailable') {
      unavailable.push(
        `${id}: bound gate execution_unavailable (${bindLabel})`,
      );
    } else {
      unavailable.push(
        `${id}: no matching passed gate for explicit binding (${bindLabel})`,
      );
    }
  }

  if (unsatisfied.length > 0) {
    return {
      gate: name,
      order,
      required,
      command: null,
      expectedExitCode: 0,
      status: 'failed',
      exitCode: 1,
      timedOut: false,
      evidence: `requirements unsatisfied: ${unsatisfied.join('; ')}`,
      classificationSignal: 'FAIL',
      check,
    };
  }

  if (unavailable.length > 0) {
    return {
      gate: name,
      order,
      required,
      command: null,
      expectedExitCode: 0,
      status: 'execution_unavailable',
      exitCode: null,
      timedOut: false,
      evidence: `requirements infrastructure-unavailable: ${unavailable.join('; ')}`,
      infraFailure: 'requirements_runtime_evidence_unavailable',
      classificationSignal: 'INFRA_FAIL',
      check,
    };
  }

  return {
    gate: name,
    order,
    required,
    command: null,
    expectedExitCode: 0,
    status: 'passed',
    exitCode: 0,
    timedOut: false,
    // Pass evidence is prior bound gate results only; artifactRef is metadata, not execution.
    evidence:
      'requirements: all mustHave items substantiated by prior bound gate results (artifactRef is metadata only)',
    classificationSignal: 'PASS',
    check,
  };
}

/**
 * Shell-single-quote a path for controlled oracle command strings.
 * @param {string} value
 * @returns {string}
 */
export function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a controlled command string for a commandless oracle from absolute path.
 * Contract: extension selects runtime; path is absolute and already path-contained
 * under the corpus oracles root.
 *
 * @param {string} oracleAbsPath
 * @returns {string}
 */
export function buildOracleCommand(oracleAbsPath) {
  const abs = path.resolve(oracleAbsPath);
  const ext = path.extname(abs).toLowerCase();
  const quoted = shellSingleQuote(abs);
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return `node ${quoted}`;
  }
  if (ext === '.sh' || ext === '.bash') {
    return `bash ${quoted}`;
  }
  throw new Error(
    `unsupported oracle extension "${ext || '(none)'}" for ${abs}; use .js/.mjs/.cjs/.sh/.bash or declare gate.command`,
  );
}

/**
 * Resolve gate.oraclePath under oracleRoot with containment checks.
 * @param {string} oracleRoot
 * @param {string} oraclePathRel
 * @returns {Promise<string>} absolute path inside oracleRoot
 */
export async function resolveCommandlessOraclePath(oracleRoot, oraclePathRel) {
  if (oracleRoot == null || String(oracleRoot).trim() === '') {
    throw new PathEscapeError('oracleRoot is required for commandless oracle', {
      code: 'ORACLE_ROOT_REQUIRED',
    });
  }
  if (oraclePathRel == null || String(oraclePathRel).trim() === '') {
    throw new PathEscapeError('oraclePath is required for commandless oracle', {
      code: 'ORACLE_PATH_REQUIRED',
    });
  }
  if (path.isAbsolute(String(oraclePathRel))) {
    throw new PathEscapeError(
      `absolute oraclePath is not allowed: "${oraclePathRel}"`,
      { candidate: String(oraclePathRel), code: 'ABSOLUTE_ORACLE' },
    );
  }
  return resolveUnder(path.resolve(oracleRoot), oraclePathRel);
}

/**
 * Evaluate an oracle gate: task-declared command as-is, **or** commandless via
 * oraclePath — never both.
 *
 * oraclePath is recorded on the result **only** when that exclusive path was
 * the command source and was executed under confinement. Unexecuted / mixed
 * gates never emit oraclePath as execution evidence.
 *
 * @param {object} opts
 * @param {string} opts.workspaceDir
 * @param {Record<string, unknown>} opts.gate
 * @param {string} [opts.oracleRoot]
 * @param {ConfinementInfo} opts.confinement
 * @param {number} [opts.timeoutMs]
 * @param {NodeJS.ProcessEnv} opts.env - minimal env from buildGateEnv (never full process.env)
 * @param {boolean} [opts.networkAllowed]
 * @returns {Promise<GateResult & { oraclePath?: string, oracleExecuted?: boolean }>}
 */
export async function evaluateOracleGate({
  workspaceDir,
  gate,
  oracleRoot,
  confinement,
  timeoutMs,
  env,
  networkAllowed = false,
}) {
  const name = typeof gate.gate === 'string' ? gate.gate : 'oracle';
  const order = typeof gate.order === 'number' ? gate.order : 1;
  const required = gate.required === undefined ? true : Boolean(gate.required);
  const expectedExitCode =
    typeof gate.expectedExitCode === 'number' ? gate.expectedExitCode : 0;
  const check = typeof gate.check === 'string' ? gate.check : undefined;
  const declaredCommand =
    typeof gate.command === 'string' && gate.command.length > 0
      ? gate.command
      : null;
  const oraclePathRel =
    typeof gate.oraclePath === 'string' && gate.oraclePath.trim()
      ? gate.oraclePath.trim()
      : null;

  // Fail closed: mixed command + oraclePath is never exclusive oracle execution.
  // Do not run either, and never emit oraclePath as execution evidence.
  if (declaredCommand != null && oraclePathRel != null) {
    return {
      gate: name,
      order,
      required,
      command: null,
      expectedExitCode,
      status: 'execution_unavailable',
      exitCode: null,
      timedOut: false,
      evidence:
        'oracle gate sets both command and oraclePath; refuse mixed execution ' +
        '(oraclePath is not evidence without exclusive oracle-path execution under confinement)',
      infraFailure: 'oracle_command_oraclePath_conflict',
      classificationSignal: 'INFRA_FAIL',
      check,
    };
  }

  /** @type {string | null} */
  let effectiveCommand = declaredCommand;
  /** Exclusive oraclePath was the command source (not yet evidence of execution). */
  let exclusiveOraclePath = false;
  /** @type {string[]} */
  let extraReadRoots = [];

  if (effectiveCommand == null) {
    if (!oraclePathRel) {
      return {
        gate: name,
        order,
        required,
        command: null,
        expectedExitCode,
        status: 'execution_unavailable',
        exitCode: null,
        timedOut: false,
        evidence:
          'oracle gate has no command and no oraclePath; commandless oracle contract requires oraclePath relative to suite oracles/',
        infraFailure: 'oracle_path_missing',
        classificationSignal: 'INFRA_FAIL',
        check,
      };
    }
    if (oracleRoot == null || String(oracleRoot).trim() === '') {
      return {
        gate: name,
        order,
        required,
        command: null,
        expectedExitCode,
        status: 'execution_unavailable',
        exitCode: null,
        timedOut: false,
        evidence:
          'oracleRoot is required to resolve commandless oraclePath under suite oracles/',
        infraFailure: 'oracle_root_missing',
        classificationSignal: 'INFRA_FAIL',
        check,
        // Unexecuted: do not emit oraclePath as execution evidence
      };
    }
    try {
      const resolvedOraclePath = await resolveCommandlessOraclePath(
        oracleRoot,
        oraclePathRel,
      );
      await access(resolvedOraclePath, constants.R_OK);
      effectiveCommand = buildOracleCommand(resolvedOraclePath);
      exclusiveOraclePath = true;
      extraReadRoots = [
        path.dirname(resolvedOraclePath),
        path.resolve(oracleRoot),
      ];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const infra =
        err instanceof PathEscapeError ||
        /escape|absolute|required|unsupported oracle/i.test(msg);
      return {
        gate: name,
        order,
        required,
        command: null,
        expectedExitCode,
        status: 'execution_unavailable',
        exitCode: null,
        timedOut: false,
        evidence: `oracle path resolution failed: ${msg}`,
        infraFailure: infra
          ? 'oracle_path_resolution_failed'
          : 'oracle_unreadable',
        classificationSignal: 'INFRA_FAIL',
        check,
        // Unexecuted: do not emit oraclePath as execution evidence
      };
    }
  }

  if (!confinement || !confinement.available) {
    return {
      gate: name,
      order,
      required,
      command: effectiveCommand,
      expectedExitCode,
      status: 'execution_unavailable',
      exitCode: null,
      timedOut: false,
      evidence: `Confinement unavailable; oracle not executed. ${confinement?.reason ?? ''}`.trim(),
      infraFailure: 'execution_unavailable',
      classificationSignal: 'INFRA_FAIL',
      check,
      // Unexecuted: never set oraclePath as evidence of execution
    };
  }

  if (env == null || typeof env !== 'object') {
    return {
      gate: name,
      order,
      required,
      command: effectiveCommand,
      expectedExitCode,
      status: 'execution_unavailable',
      exitCode: null,
      timedOut: false,
      evidence:
        'oracle requires a minimal gate env from buildGateEnv (never process.env)',
      infraFailure: 'oracle_env_required',
      classificationSignal: 'INFRA_FAIL',
      check,
      // Unexecuted: never set oraclePath as evidence of execution
    };
  }

  // Oracle scripts read WORKSPACE_DIR; inject only that harness-controlled path.
  /** @type {NodeJS.ProcessEnv} */
  const runEnv = {
    ...env,
    WORKSPACE_DIR: path.resolve(workspaceDir),
  };

  const run = await runConfinedCommand({
    confinement,
    workspaceDir: path.resolve(workspaceDir),
    command: effectiveCommand,
    timeoutMs,
    env: runEnv,
    networkAllowed,
    extraReadRoots,
  });

  const out = digestAndPreview(run.stdout);
  const err = digestAndPreview(run.stderr);

  // oraclePath is execution evidence only for exclusive path-sourced runs that
  // actually entered confinement (including timeout / run-time infra failure).
  /** @type {{ oraclePath?: string, oracleExecuted?: boolean }} */
  const executedOracleEvidence =
    exclusiveOraclePath && oraclePathRel
      ? { oraclePath: oraclePathRel, oracleExecuted: true }
      : {};

  if (run.timedOut) {
    return {
      gate: name,
      order,
      required,
      command: effectiveCommand,
      expectedExitCode,
      status: 'failed',
      exitCode: run.exitCode,
      timedOut: true,
      stdoutDigest: out.digest,
      stderrDigest: err.digest,
      evidence: run.infraFailure ?? 'oracle timed out',
      infraFailure: run.infraFailure,
      classificationSignal: 'TIMEOUT',
      check,
      ...executedOracleEvidence,
    };
  }

  if (run.infraFailure) {
    return {
      gate: name,
      order,
      required,
      command: effectiveCommand,
      expectedExitCode,
      status: 'execution_unavailable',
      exitCode: run.exitCode,
      timedOut: false,
      stdoutDigest: out.digest,
      stderrDigest: err.digest,
      evidence: run.infraFailure,
      infraFailure: run.infraFailure,
      classificationSignal: 'INFRA_FAIL',
      check,
      ...executedOracleEvidence,
    };
  }

  const passed = run.exitCode === expectedExitCode;
  return {
    gate: name,
    order,
    required,
    command: effectiveCommand,
    expectedExitCode,
    status: passed ? 'passed' : 'failed',
    exitCode: run.exitCode,
    timedOut: false,
    stdoutDigest: out.digest,
    stderrDigest: err.digest,
    evidence: passed
      ? `oracle exit ${run.exitCode} matches expected ${expectedExitCode}`
      : `oracle exit ${run.exitCode} != expected ${expectedExitCode}`,
    classificationSignal: passed ? 'PASS' : 'FAIL',
    check,
    ...executedOracleEvidence,
  };
}

/**
 * Build argv for confined execution of an exact command string.
 * Never rewrites the command string.
 *
 * @param {ConfinementInfo} confinement
 * @param {string} workspaceDir
 * @param {string} command
 * @param {object} opts
 * @param {string} [opts.profilePath]
 * @param {string} [opts.privateTmp]
 * @param {boolean} [opts.networkAllowed=false]
 * @returns {{ command: string, args: string[] }}
 */
/**
 * @param {ConfinementInfo} confinement
 * @param {string} workspaceDir
 * @param {string} command
 * @param {object} opts
 * @param {string} [opts.profilePath]
 * @param {string} [opts.privateTmp]
 * @param {boolean} [opts.networkAllowed=false]
 * @param {string[]} [opts.readRoots]
 * @returns {{ command: string, args: string[] }}
 */
export function buildConfinedArgv(
  confinement,
  workspaceDir,
  command,
  opts = {},
) {
  if (!confinement.available || !confinement.binary || !confinement.kind) {
    throw new Error('buildConfinedArgv: confinement not available');
  }
  const ws = path.resolve(workspaceDir);
  const shell = '/bin/sh';
  const shellArgs = ['-c', command];
  const networkAllowed = opts.networkAllowed === true;
  const readRoots = Array.isArray(opts.readRoots) ? opts.readRoots : [];

  if (confinement.kind === 'sandbox-exec') {
    if (!opts.profilePath) {
      throw new Error('sandbox-exec requires profilePath');
    }
    return {
      command: confinement.binary,
      args: ['-f', opts.profilePath, shell, ...shellArgs],
    };
  }

  if (confinement.kind === 'bwrap') {
    if (readRoots.length === 0) {
      throw new Error(
        'bwrap: no safe toolchain roots available; fail closed (will not bind / or $HOME)',
      );
    }
    /** @type {string[]} */
    const args = ['--die-with-parent', '--unshare-pid'];
    const home = path.resolve(os.homedir());
    for (const root of readRoots) {
      const abs = path.resolve(root);
      // Never bind exact / or exact $HOME. Contained paths (oracle dirs under a
      // project tree in $HOME) are allowed as explicit narrow read roots.
      if (abs === '/' || abs === home) {
        continue;
      }
      args.push('--ro-bind', abs, abs);
    }
    // Writable workspace only
    args.push('--bind', ws, ws);
    // Private tmp — never bind host home
    args.push('--tmpfs', '/tmp');
    args.push('--dev', '/dev');
    if (readRoots.some((r) => path.resolve(r) === '/proc' || String(r).startsWith('/proc'))) {
      args.push('--proc', '/proc');
    } else {
      args.push('--proc', '/proc');
    }
    args.push('--chdir', ws);
    if (!networkAllowed) {
      args.push('--unshare-net');
    }
    // Hard refuse any full-root bind
    for (let i = 0; i < args.length; i += 1) {
      if (
        (args[i] === '--ro-bind' || args[i] === '--bind') &&
        args[i + 1] === '/' &&
        args[i + 2] === '/'
      ) {
        throw new Error('refusing root bind of / in bwrap argv');
      }
    }
    args.push(shell, ...shellArgs);
    return {
      command: confinement.binary,
      args,
    };
  }

  throw new Error(`unsupported confinement kind: ${confinement.kind}`);
}

/**
 * @param {object} opts
 * @param {ConfinementInfo} opts.confinement
 * @param {string} opts.workspaceDir
 * @param {string} opts.command
 * @param {number} [opts.timeoutMs]
 * @param {NodeJS.ProcessEnv} opts.env - must already be a minimal built env (never full process.env)
 * @param {boolean} [opts.networkAllowed]
 * @param {string[]} [opts.extraReadRoots] additional read-only roots (e.g. oracle dir)
 * @returns {Promise<{ exitCode: number | null, timedOut: boolean, stdout: string, stderr: string, infraFailure?: string, signal?: string, profile?: string }>}
 */
async function runConfinedCommand({
  confinement,
  workspaceDir,
  command,
  timeoutMs,
  env,
  networkAllowed = false,
  extraReadRoots = [],
}) {
  if (env == null || typeof env !== 'object') {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      infraFailure: 'runConfinedCommand: env is required (use buildGateEnv; never process.env)',
    };
  }
  let profileDir = null;
  let privateTmp = null;
  let profileText = '';

  try {
    privateTmp = await mkdtemp(path.join(os.tmpdir(), 'aicb-gate-tmp-'));
    let profilePath;

    const toolchainRoots = await resolveExistingToolchainRoots();
    /** @type {string[]} */
    const readRoots = [...toolchainRoots];
    for (const extra of Array.isArray(extraReadRoots) ? extraReadRoots : []) {
      if (extra == null || String(extra).trim() === '') continue;
      const abs = path.resolve(String(extra));
      const home = path.resolve(os.homedir());
      // Refuse only exact / and exact $HOME. Contained paths under $HOME are OK
      // (corpus oracles often live under the user's project tree).
      if (abs === '/' || abs === home) {
        continue;
      }
      if (!readRoots.includes(abs)) {
        readRoots.push(abs);
      }
    }
    // Fail closed if we cannot construct a minimal executable view
    const hasShellRoot = readRoots.some(
      (r) =>
        r === '/bin' ||
        r === '/usr' ||
        r.startsWith('/bin') ||
        r.startsWith('/usr'),
    );
    if (!hasShellRoot && confinement.kind === 'bwrap') {
      return {
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        infraFailure:
          'safe toolchain view unavailable (no /bin or /usr); fail closed',
      };
    }

    if (confinement.kind === 'sandbox-exec') {
      profileDir = await mkdtemp(path.join(os.tmpdir(), 'aicb-seatbelt-'));
      profilePath = path.join(profileDir, 'profile.sb');
      try {
        profileText = buildSeatbeltProfile(
          path.resolve(workspaceDir),
          privateTmp,
          networkAllowed,
          readRoots,
        );
      } catch (err) {
        return {
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          infraFailure: err instanceof Error ? err.message : String(err),
        };
      }
      if (/\(allow default\)/.test(profileText)) {
        return {
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          infraFailure:
            'refusing permissive seatbelt profile containing (allow default)',
        };
      }
      if (/\(allow file-read\*\)(?!\s*\()/.test(profileText)) {
        return {
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          infraFailure: 'refusing unrestricted (allow file-read*)',
        };
      }
      await writeFile(profilePath, profileText, 'utf8');
    }

    let built;
    try {
      built = buildConfinedArgv(confinement, workspaceDir, command, {
        profilePath,
        privateTmp,
        networkAllowed,
        readRoots,
      });
    } catch (err) {
      return {
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        infraFailure: err instanceof Error ? err.message : String(err),
      };
    }

    // Refuse any root bind of /
    if (
      confinement.kind === 'bwrap' &&
      built.args.some(
        (a, i) =>
          (a === '--bind' || a === '--ro-bind') &&
          built.args[i + 1] === '/' &&
          built.args[i + 2] === '/',
      )
    ) {
      return {
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        infraFailure: 'refusing read-write bind of / as confinement',
      };
    }

    const result = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(built.command, built.args, {
          cwd: path.resolve(workspaceDir),
          // Fail closed: only the caller-supplied minimal env (buildGateEnv).
          env,
          shell: false,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          infraFailure: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      let stdoutTrunc = 0;
      let stderrTrunc = 0;
      let timedOut = false;
      /** @type {NodeJS.Timeout | null} */
      let timer = null;
      let settled = false;
      const limit = DEFAULT_CAPTURE_LIMIT;

      const append = (/** @type {'out'|'err'} */ which, chunk) => {
        if (which === 'out') {
          if (stdout.length >= limit) {
            stdoutTrunc += chunk.length;
            return;
          }
          const room = limit - stdout.length;
          stdout += chunk.length <= room ? chunk : chunk.slice(0, room);
          if (chunk.length > room) stdoutTrunc += chunk.length - room;
        } else {
          if (stderr.length >= limit) {
            stderrTrunc += chunk.length;
            return;
          }
          const room = limit - stderr.length;
          stderr += chunk.length <= room ? chunk : chunk.slice(0, room);
          if (chunk.length > room) stderrTrunc += chunk.length - room;
        }
      };

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve(result);
      };

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (c) => append('out', String(c)));
      child.stderr?.on('data', (c) => append('err', String(c)));

      child.on('error', (err) => {
        finish({
          exitCode: null,
          timedOut: false,
          stdout,
          stderr,
          infraFailure: `process error: ${err.message}`,
        });
      });

      child.on('close', (code, signal) => {
        /** @type {Record<string, unknown>} */
        const result = {
          exitCode: code,
          timedOut,
          stdout,
          stderr,
        };
        if (signal) result.signal = signal;
        if (timedOut) {
          result.infraFailure = `gate timed out after ${timeoutMs}ms`;
        }
        finish(result);
      });

      const ms = timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
      if (Number.isFinite(ms) && ms > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            if (child.pid != null) {
              try {
                process.kill(-child.pid, 'SIGTERM');
              } catch {
                child.kill('SIGTERM');
              }
            }
          } catch {
            /* ignore */
          }
          setTimeout(() => {
            try {
              if (child.pid != null) {
                try {
                  process.kill(-child.pid, 'SIGKILL');
                } catch {
                  child.kill('SIGKILL');
                }
              }
            } catch {
              /* ignore */
            }
          }, 1000).unref?.();
        }, ms);
        timer.unref?.();
      }
    });

    return { ...result, profile: profileText || undefined };
  } finally {
    if (profileDir) {
      try {
        await rm(profileDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    if (privateTmp) {
      try {
        await rm(privateTmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * @param {Record<string, unknown>} gate
 * @returns {boolean}
 */
export function isStructuralGate(gate) {
  const name = typeof gate.gate === 'string' ? gate.gate : '';
  const hasCommand = typeof gate.command === 'string' && gate.command.length > 0;
  if (hasCommand) return false;
  // Commandless oracle with oraclePath is executable via the oracle path contract.
  if (
    name === 'oracle' &&
    typeof gate.oraclePath === 'string' &&
    gate.oraclePath.trim()
  ) {
    return false;
  }
  if (STRUCTURAL_GATES.has(name)) return true;
  return !hasCommand;
}

/**
 * Resolve network policy from task.networkPolicy.
 * @param {object | null | undefined} task
 * @returns {boolean}
 */
export function resolveNetworkAllowed(task) {
  if (!task || typeof task !== 'object') return false;
  const np = task.networkPolicy;
  if (!np || typeof np !== 'object') return false;
  return np.allowed === true;
}

/**
 * Run eligibility gates in order under real confinement / structural evaluators.
 *
 * Gate commands receive a minimal deterministic env from buildGateEnv
 * (base + arm envAllowlist names from parent). Full process.env is never passed.
 * Task YAML must not inject environment.
 *
 * Ordinary GateResult surfaces keep digests only — never stdout/stderr previews
 * (previews can contain secrets).
 *
 * @param {object} opts
 * @param {Array<Record<string, unknown>>} opts.gates
 * @param {string} opts.workspaceDir
 * @param {string} [opts.oracleRoot]
 * @param {ConfinementInfo} [opts.confinement]
 * @param {number} [opts.timeoutMs]
 * @param {string[] | Record<string, unknown> | null} [opts.envAllowlist] arm allowlist of names
 * @param {string | null} [opts.sandboxMode] arm sandbox posture
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined> | null} [opts.parentEnv] testable parent env
 * @param {object} [opts.task] full task including expectedOutcome + networkPolicy (never env)
 * @returns {Promise<GateResult[]>}
 */
export async function runGates({
  gates,
  workspaceDir,
  oracleRoot,
  confinement: confinementOpt,
  timeoutMs,
  envAllowlist = null,
  sandboxMode = null,
  parentEnv = null,
  task = null,
}) {
  if (!Array.isArray(gates)) {
    throw new Error('runGates: gates must be an array');
  }
  if (workspaceDir == null || String(workspaceDir).trim() === '') {
    throw new Error('runGates: workspaceDir is required');
  }

  // Refuse task-YAML env smuggling if a task object carries env-like fields.
  if (task && typeof task === 'object') {
    if (
      Object.prototype.hasOwnProperty.call(task, 'env') ||
      Object.prototype.hasOwnProperty.call(task, 'environment') ||
      Object.prototype.hasOwnProperty.call(task, 'gateEnv')
    ) {
      throw new Error(
        'runGates: task YAML must not inject environment (env/environment/gateEnv refused)',
      );
    }
  }

  const confinement = confinementOpt ?? (await detectConfinement());
  const networkAllowed = resolveNetworkAllowed(task);
  const gateEnv = buildGateEnv({
    envAllowlist,
    sandboxMode,
    parentEnv: parentEnv ?? process.env,
  });
  const ordered = [...gates].sort((a, b) => {
    const ao = typeof a.order === 'number' ? a.order : 0;
    const bo = typeof b.order === 'number' ? b.order : 0;
    return ao - bo;
  });

  /** @type {GateResult[]} */
  const results = [];

  for (const gate of ordered) {
    const name = typeof gate.gate === 'string' ? gate.gate : 'unknown';
    const order = typeof gate.order === 'number' ? gate.order : results.length + 1;
    const required = gate.required === undefined ? true : Boolean(gate.required);
    const expectedExitCode =
      typeof gate.expectedExitCode === 'number' ? gate.expectedExitCode : 0;
    const command =
      typeof gate.command === 'string' && gate.command.length > 0
        ? gate.command
        : null;
    const check = typeof gate.check === 'string' ? gate.check : undefined;

    // Structural evaluators
    if (name === 'baseline-diff' && command == null) {
      results.push(
        await evaluateBaselineDiff({
          workspaceDir: path.resolve(workspaceDir),
          gate,
        }),
      );
      continue;
    }
    if (name === 'requirements' && command == null) {
      results.push(
        await evaluateRequirements({
          gate,
          task,
          priorGateResults: results,
        }),
      );
      continue;
    }

    // Oracle: declared command as-is, or commandless via oraclePath under oracleRoot.
    if (name === 'oracle') {
      results.push(
        await evaluateOracleGate({
          workspaceDir: path.resolve(workspaceDir),
          gate,
          oracleRoot,
          confinement,
          timeoutMs,
          env: gateEnv,
          networkAllowed,
        }),
      );
      continue;
    }

    if (command == null) {
      // Unknown structural: never silent PASS
      results.push({
        gate: name,
        order,
        required,
        command: null,
        expectedExitCode,
        status: 'execution_unavailable',
        exitCode: null,
        timedOut: false,
        evidence: `Gate "${name}" has no command and no structural evaluator; not marking PASS`,
        infraFailure: 'structural_evaluator_unavailable',
        classificationSignal: 'INFRA_FAIL',
        check,
      });
      continue;
    }

    if (!confinement.available) {
      results.push({
        gate: name,
        order,
        required,
        command,
        expectedExitCode,
        status: 'execution_unavailable',
        exitCode: null,
        timedOut: false,
        evidence: `Confinement unavailable; gate command not executed. ${confinement.reason ?? ''}`.trim(),
        infraFailure: 'execution_unavailable',
        classificationSignal: 'INFRA_FAIL',
        check,
      });
      continue;
    }

    const run = await runConfinedCommand({
      confinement,
      workspaceDir: path.resolve(workspaceDir),
      command,
      timeoutMs,
      env: gateEnv,
      networkAllowed,
    });

    // Digests only on ordinary results — never secret-bearing previews.
    const out = digestAndPreview(run.stdout);
    const err = digestAndPreview(run.stderr);

    if (run.timedOut) {
      results.push({
        gate: name,
        order,
        required,
        command,
        expectedExitCode,
        status: 'failed',
        exitCode: run.exitCode,
        timedOut: true,
        stdoutDigest: out.digest,
        stderrDigest: err.digest,
        evidence: run.infraFailure ?? 'gate timed out',
        infraFailure: run.infraFailure,
        classificationSignal: 'TIMEOUT',
        check,
      });
      continue;
    }

    if (run.infraFailure) {
      results.push({
        gate: name,
        order,
        required,
        command,
        expectedExitCode,
        status: 'execution_unavailable',
        exitCode: run.exitCode,
        timedOut: false,
        stdoutDigest: out.digest,
        stderrDigest: err.digest,
        evidence: run.infraFailure,
        infraFailure: run.infraFailure,
        classificationSignal: 'INFRA_FAIL',
        check,
      });
      continue;
    }

    const passed = run.exitCode === expectedExitCode;
    results.push({
      gate: name,
      order,
      required,
      command,
      expectedExitCode,
      status: passed ? 'passed' : 'failed',
      exitCode: run.exitCode,
      timedOut: false,
      stdoutDigest: out.digest,
      stderrDigest: err.digest,
      evidence: passed
        ? `exit ${run.exitCode} matches expected ${expectedExitCode}`
        : `exit ${run.exitCode} != expected ${expectedExitCode}`,
      classificationSignal: passed ? 'PASS' : 'FAIL',
      check,
    });
  }

  return results;
}

export {
  STRUCTURAL_GATES,
  DEFAULT_GATE_TIMEOUT_MS,
  PROTECTED_PATH_PREFIXES,
};
