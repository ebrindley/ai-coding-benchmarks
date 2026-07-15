/**
 * Static confinement adapter for task-declared eligibility gates.
 *
 * Fail closed when the platform confinement primitive is unavailable or a safe
 * policy cannot be constructed — never run gate command strings bare.
 * Command strings are passed as exact literals to `/bin/sh -c` under confinement only.
 *
 * macOS: deny-default seatbelt — process-exec; reads only workspace/private-tmp/system
 *        toolchain roots; writes only workspace + private tmp; network per task policy.
 * Linux: explicit ro-bind of system/toolchain roots only (never / or $HOME),
 *        writable workspace, private tmpfs, die-with-parent, network unshare when denied.
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
 * @property {string} [stdoutPreview]
 * @property {string} [stderrPreview]
 * @property {string} [evidence]
 * @property {string} [infraFailure]
 * @property {'PASS' | 'FAIL' | 'INFRA_FAIL' | 'TIMEOUT' | null} classificationSignal
 * @property {string} [check]
 */

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
 * Evaluate requirements from prior ordered gate results.
 *
 * - substantiation "test": satisfied only by a passed required `tests` gate
 * - other substantiation: satisfied only by a matching passed executable/structural
 *   gate (by gate name, e.g. lint/oracle); otherwise infrastructure-unavailable
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

    if (substantiation === 'test' || substantiation === 'tests') {
      const testsGate = prior.find(
        (g) =>
          g &&
          String(g.gate) === 'tests' &&
          g.required !== false &&
          isPassedGateResult(g),
      );
      if (!testsGate) {
        const testsRan = prior.find((g) => g && String(g.gate) === 'tests');
        if (testsRan && testsRan.status === 'failed') {
          unsatisfied.push(`${id}: tests gate failed`);
        } else {
          unavailable.push(
            `${id}: no passed required tests gate for substantiation=test`,
          );
        }
      }
      continue;
    }

    if (!substantiation) {
      unavailable.push(
        `${id}: missing substantiation; cannot map to a gate result`,
      );
      continue;
    }

    // Map substantiation keywords to gate names (lint, oracle, install, static, …)
    const candidates = prior.filter((g) => {
      if (!g || !isPassedGateResult(g)) return false;
      const gname = String(g.gate || '').toLowerCase();
      return (
        gname === substantiation ||
        gname.includes(substantiation) ||
        substantiation.includes(gname)
      );
    });
    if (candidates.length === 0) {
      unavailable.push(
        `${id}: no matching passed gate for substantiation="${substantiation}"`,
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
    evidence: 'requirements: all mustHave items substantiated by prior gate results',
    classificationSignal: 'PASS',
    check,
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
      if (abs === '/' || abs === home || abs.startsWith(home + path.sep)) {
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
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {boolean} [opts.networkAllowed]
 * @returns {Promise<{ exitCode: number | null, timedOut: boolean, stdout: string, stderr: string, infraFailure?: string, signal?: string, profile?: string }>}
 */
async function runConfinedCommand({
  confinement,
  workspaceDir,
  command,
  timeoutMs,
  env,
  networkAllowed = false,
}) {
  let profileDir = null;
  let privateTmp = null;
  let profileText = '';

  try {
    privateTmp = await mkdtemp(path.join(os.tmpdir(), 'aicb-gate-tmp-'));
    let profilePath;

    const readRoots = await resolveExistingToolchainRoots();
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
          env: env ?? { ...process.env },
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
 * @param {object} opts
 * @param {Array<Record<string, unknown>>} opts.gates
 * @param {string} opts.workspaceDir
 * @param {string} [opts.oracleRoot]
 * @param {ConfinementInfo} [opts.confinement]
 * @param {number} [opts.timeoutMs]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {object} [opts.task] full task including expectedOutcome + networkPolicy
 * @returns {Promise<GateResult[]>}
 */
export async function runGates({
  gates,
  workspaceDir,
  oracleRoot: _oracleRoot,
  confinement: confinementOpt,
  timeoutMs,
  env,
  task = null,
}) {
  if (!Array.isArray(gates)) {
    throw new Error('runGates: gates must be an array');
  }
  if (workspaceDir == null || String(workspaceDir).trim() === '') {
    throw new Error('runGates: workspaceDir is required');
  }

  const confinement = confinementOpt ?? (await detectConfinement());
  const networkAllowed = resolveNetworkAllowed(task);
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
      env,
      networkAllowed,
    });

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
        stdoutPreview: out.preview,
        stderrPreview: err.preview,
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
        stdoutPreview: out.preview,
        stderrPreview: err.preview,
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
      stdoutPreview: out.preview,
      stderrPreview: err.preview,
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
