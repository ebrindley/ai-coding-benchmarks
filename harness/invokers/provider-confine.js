/**
 * Fail-closed OS confinement for provider / Poetic-system process trees.
 *
 * While the provider is alive, the campaign control/evidence tree must be
 * inaccessible for both reads and writes. This is stronger than path-tree
 * separation of workspaces: the harness denies the campaign subpath via
 * sandbox-exec (macOS) or bubblewrap tmpfs mask (Linux).
 *
 * Honesty bound:
 * - Nested sandboxes (e.g. Poetic's own provider sandbox) run *inside* this
 *   outer restriction; we do not claim nested-sandbox introspection.
 * - Windows has no supported primitive here → execution_unavailable.
 * - Gate confinement is separate (gates.js); this module is for invokers only.
 */

import { access, constants, mkdtemp, writeFile, rm, realpath, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {object} ProviderConfinementInfo
 * @property {boolean} available
 * @property {'sandbox-exec' | 'bwrap' | null} kind
 * @property {string | null} binary
 * @property {string} [reason]
 */

/**
 * Escape a path for seatbelt profile literals/subpaths.
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
 * @param {string} name
 * @returns {Promise<string | null>}
 */
async function findOnPath(name) {
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
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
 * Detect OS confinement primitive for provider process trees.
 * @returns {Promise<ProviderConfinementInfo>}
 */
export async function detectProviderConfinement() {
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
        reason: 'macOS sandbox-exec not executable at /usr/bin/sandbox-exec',
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
    reason: `no supported provider confinement for platform "${process.platform}"`,
  };
}

/**
 * Canonical absolute path (realpath when possible).
 * @param {string} p
 * @returns {Promise<string>}
 */
export async function canonicalPath(p) {
  const abs = path.resolve(String(p));
  try {
    return await realpath(abs);
  } catch {
    return abs;
  }
}

/**
 * Collect campaign path aliases to deny (resolved + realpath forms).
 * @param {string} campaignDir
 * @returns {Promise<string[]>}
 */
export async function campaignDenyPaths(campaignDir) {
  const abs = path.resolve(String(campaignDir));
  /** @type {Set<string>} */
  const set = new Set([abs]);
  try {
    set.add(await realpath(abs));
  } catch {
    /* missing dir still deny lexical path */
  }
  // macOS: also deny /var vs /private/var twins when applicable
  if (abs.startsWith('/var/')) {
    set.add(`/private${abs}`);
  }
  if (abs.startsWith('/private/var/')) {
    set.add(abs.replace(/^\/private/, ''));
  }
  return [...set].filter(Boolean);
}

/**
 * macOS seatbelt: allow-default with explicit deny of campaign subpaths.
 * Provider retains general filesystem access except the campaign tree.
 *
 * @param {string[]} campaignPaths canonical campaign path aliases
 * @returns {string}
 */
export function buildProviderSeatbeltProfile(campaignPaths) {
  if (!Array.isArray(campaignPaths) || campaignPaths.length === 0) {
    throw new Error('buildProviderSeatbeltProfile: campaignPaths required');
  }
  const lines = [
    '(version 1)',
    '(allow default)',
  ];
  for (const p of campaignPaths) {
    const esc = escapeSeatbeltPath(path.resolve(p));
    lines.push(`(deny file-read* (subpath "${esc}"))`);
    lines.push(`(deny file-write* (subpath "${esc}"))`);
    lines.push(`(deny file-read-metadata (subpath "${esc}"))`);
  }
  const profile = `${lines.join('\n')}\n`;
  // Must not be deny-default only; we use allow-default + explicit campaign deny.
  if (!/\(allow default\)/.test(profile)) {
    throw new Error('provider seatbelt profile missing (allow default)');
  }
  if (!/\(deny file-read\*/.test(profile) || !/\(deny file-write\*/.test(profile)) {
    throw new Error('provider seatbelt profile missing campaign deny rules');
  }
  return profile;
}

/**
 * Build confined argv for a provider command.
 * Never uses a shell. Command and args are preserved as the final argv tail.
 *
 * @param {object} opts
 * @param {ProviderConfinementInfo} opts.confinement
 * @param {string} opts.command
 * @param {string[]} opts.args
 * @param {string} opts.cwd - workspace cwd (must stay writable)
 * @param {string[]} opts.campaignPaths - paths to mask
 * @param {string} [opts.profilePath] - seatbelt profile file (macOS)
 * @param {string[]} [opts.extraBindPaths] - additional rw binds (scratch dirs)
 * @returns {{ command: string, args: string[] }}
 */
export function buildProviderConfinedArgv({
  confinement,
  command,
  args,
  cwd,
  campaignPaths,
  profilePath,
  extraBindPaths = [],
}) {
  if (!confinement?.available || !confinement.binary || !confinement.kind) {
    throw new Error(
      confinement?.reason ||
        'provider confinement unavailable (fail closed)',
    );
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new Error('buildProviderConfinedArgv: args must be string[]');
  }
  const cmd = String(command);
  const ws = path.resolve(cwd);

  if (confinement.kind === 'sandbox-exec') {
    if (!profilePath) {
      throw new Error('sandbox-exec requires profilePath');
    }
    // sandbox-exec -f profile command args... (argv-safe; no shell)
    return {
      command: confinement.binary,
      args: ['-f', String(profilePath), cmd, ...args],
    };
  }

  if (confinement.kind === 'bwrap') {
    /** @type {string[]} */
    const bargs = [
      '--die-with-parent',
      '--unshare-pid',
      // Full host view, then mask campaign and re-bind workspace rw
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
    ];
    // Mask every campaign alias with an empty tmpfs (no host content).
    for (const camp of campaignPaths) {
      const c = path.resolve(camp);
      if (c === '/' || c === '') {
        throw new Error('refusing to tmpfs-mask filesystem root');
      }
      bargs.push('--tmpfs', c);
    }
    // Writable workspace (and optional scratch paths outside campaign)
    bargs.push('--bind', ws, ws);
    for (const extra of extraBindPaths) {
      const e = path.resolve(extra);
      if (e === '/' || e === '') continue;
      // Do not re-bind campaign paths as writable
      if (campaignPaths.some((c) => e === path.resolve(c) || e.startsWith(path.resolve(c) + path.sep))) {
        throw new Error(`refusing to bind path under campaign: ${e}`);
      }
      bargs.push('--bind', e, e);
    }
    bargs.push('--chdir', ws);
    bargs.push('--', cmd, ...args);
    return { command: confinement.binary, args: bargs };
  }

  throw new Error(`unsupported provider confinement kind: ${confinement.kind}`);
}

/**
 * Prepare confinement materials and wrap a command for provider spawn.
 * Caller must invoke cleanup() after the child exits.
 *
 * @param {object} opts
 * @param {string} opts.command
 * @param {string[]} opts.args
 * @param {string} opts.cwd
 * @param {string} opts.campaignDir - campaign control/evidence root to hide
 * @param {string[]} [opts.extraBindPaths]
 * @param {ProviderConfinementInfo} [opts.confinement] - pre-detected
 * @returns {Promise<
 *   | { ok: true, command: string, args: string[], cleanup: () => Promise<void>, confinement: ProviderConfinementInfo, campaignPaths: string[] }
 *   | { ok: false, infraFailure: string, executionUnavailable: true }
 * >}
 */
export async function wrapProviderCommand(opts) {
  const campaignDir = opts.campaignDir;
  if (campaignDir == null || String(campaignDir).trim() === '') {
    return {
      ok: false,
      executionUnavailable: true,
      infraFailure:
        'provider confinement requires campaignDir (fail closed; unconfined spawn refused)',
    };
  }

  const confinement =
    opts.confinement ?? (await detectProviderConfinement());
  if (!confinement.available) {
    return {
      ok: false,
      executionUnavailable: true,
      infraFailure: `provider confinement unavailable: ${confinement.reason || 'unknown'} (fail closed; unconfined spawn refused)`,
    };
  }

  let campaignPaths;
  try {
    campaignPaths = await campaignDenyPaths(campaignDir);
  } catch (err) {
    return {
      ok: false,
      executionUnavailable: true,
      infraFailure: `failed to resolve campaign path for confinement: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  /** @type {string | null} */
  let profileDir = null;
  /** @type {string | undefined} */
  let profilePath;

  try {
    if (confinement.kind === 'sandbox-exec') {
      profileDir = await mkdtemp(path.join(os.tmpdir(), 'aicb-provider-sb-'));
      profilePath = path.join(profileDir, 'provider.sb');
      const profile = buildProviderSeatbeltProfile(campaignPaths);
      await writeFile(profilePath, profile, { encoding: 'utf8', mode: 0o600 });
    }

    const wrapped = buildProviderConfinedArgv({
      confinement,
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      campaignPaths,
      profilePath,
      extraBindPaths: opts.extraBindPaths,
    });

    return {
      ok: true,
      command: wrapped.command,
      args: wrapped.args,
      confinement,
      campaignPaths,
      cleanup: async () => {
        if (profileDir) {
          await rm(profileDir, { recursive: true, force: true }).catch(() => {});
        }
      },
    };
  } catch (err) {
    if (profileDir) {
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
    return {
      ok: false,
      executionUnavailable: true,
      infraFailure: `failed to establish provider confinement: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Assert a path is not under the campaign tree (for scratch placement).
 * Uses realpath of existing ancestors so macOS /var vs /private/var matches.
 * @param {string} candidate
 * @param {string} campaignDir
 * @returns {Promise<void>}
 */
export async function assertPathOutsideCampaign(candidate, campaignDir) {
  const camp = await canonicalPath(campaignDir);
  let cand = path.resolve(String(candidate));
  // Walk up to an existing ancestor, realpath it, then rejoin remaining segments.
  try {
    cand = await realpath(cand);
  } catch {
    let cur = cand;
    const missing = [];
    while (cur !== path.parse(cur).root) {
      missing.unshift(path.basename(cur));
      cur = path.dirname(cur);
      try {
        const real = await realpath(cur);
        cand = path.resolve(real, ...missing);
        break;
      } catch {
        /* continue */
      }
    }
  }
  if (cand === camp || cand.startsWith(camp + path.sep)) {
    throw new Error(
      `path must be outside campaign control tree: ${cand} is under ${camp}`,
    );
  }
}
