/**
 * Fail-closed OS confinement for provider / Poetic-system process trees.
 *
 * While the provider is alive, the campaign control/evidence tree must be
 * inaccessible for both reads and writes. This is stronger than path-tree
 * separation of workspaces: the harness denies the campaign subpath via
 * sandbox-exec (macOS) or bubblewrap tmpfs mask (Linux).
 *
 * Linux bubblewrap binds `/` read-only and only rebinds the execution
 * workspace (plus optional scratch paths) writable. Host `os.tmpdir()`
 * (commonly `/tmp`) is therefore unwritable inside the sandbox. Every
 * confined provider spawn receives a private 0700 temp directory under the
 * already-writable workspace/scratch bind, with TMPDIR/TMP/TEMP constrained
 * to that directory. Campaign-control storage is never used as temp parent.
 *
 * Honesty bound:
 * - Nested sandboxes (e.g. Poetic's own provider sandbox) run *inside* this
 *   outer restriction; we do not claim nested-sandbox introspection.
 * - Windows has no supported primitive here → execution_unavailable.
 * - Gate confinement is separate (gates.js); this module is for invokers only.
 */

import {
  access,
  constants,
  mkdtemp,
  writeFile,
  rm,
  realpath,
  chmod,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** mkdtemp prefix for per-invocation private temp under the workspace bind. */
export const PROVIDER_PRIVATE_TEMP_PREFIX = 'aicb-prov-tmp-';

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
 * Create a private 0700 temp directory under an already-writable confinement
 * bind (workspace or scratch). Never under campaign control storage.
 *
 * Poetic creates its raw spool under `os.tmpdir()`; under bubblewrap host
 * `/tmp` is read-only, so the child must receive TMPDIR pointing here.
 *
 * @param {string} parentDir - absolute parent already (or soon) RW-bound
 * @returns {Promise<string>} absolute private temp path
 */
export async function createProviderPrivateTemp(parentDir) {
  if (parentDir == null || String(parentDir).trim() === '') {
    throw new Error('createProviderPrivateTemp: parentDir required');
  }
  const parent = path.resolve(String(parentDir));
  if (parent === '/' || parent === '') {
    throw new Error('createProviderPrivateTemp: refusing filesystem root');
  }
  // The harness must establish the workspace/scratch parent itself. Do not
  // create arbitrary caller-selected ancestors from this confinement helper.
  const dir = await mkdtemp(path.join(parent, PROVIDER_PRIVATE_TEMP_PREFIX));
  // Force 0700 independent of umask (Poetic expects a private spool parent).
  await chmod(dir, 0o700);
  return dir;
}

/**
 * Overlay constrained TMPDIR/TMP/TEMP onto a harness-controlled env object.
 * Does not merge task YAML env — only the three temp keys are set/overwritten.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {string} privateTempDir
 * @returns {NodeJS.ProcessEnv}
 */
export function applyProviderTempEnv(env, privateTempDir) {
  if (privateTempDir == null || String(privateTempDir).trim() === '') {
    throw new Error('applyProviderTempEnv: privateTempDir required');
  }
  const t = path.resolve(String(privateTempDir));
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  if (env != null && typeof env === 'object') {
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined && v !== null) {
        out[k] = String(v);
      }
    }
  }
  out.TMPDIR = t;
  out.TMP = t;
  out.TEMP = t;
  return out;
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
 * Always provisions a private 0700 temp under the writable workspace/scratch
 * bind (never under campaign control storage) so confined children can use
 * os.tmpdir() / TMPDIR even when bubblewrap mounts host root read-only.
 *
 * @param {object} opts
 * @param {string} opts.command
 * @param {string[]} opts.args
 * @param {string} opts.cwd
 * @param {string} opts.campaignDir - campaign control/evidence root to hide
 * @param {string[]} [opts.extraBindPaths]
 * @param {string} [opts.privateTempParent] - parent for private temp (default: cwd)
 * @param {ProviderConfinementInfo} [opts.confinement] - pre-detected
 * @returns {Promise<
 *   | { ok: true, command: string, args: string[], cleanup: () => Promise<void>, confinement: ProviderConfinementInfo, campaignPaths: string[], privateTempDir: string }
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

  if (opts.cwd == null || String(opts.cwd).trim() === '') {
    return {
      ok: false,
      executionUnavailable: true,
      infraFailure:
        'provider confinement requires cwd (workspace) for private temp and writable bind',
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
  /** @type {string | null} */
  let privateTempDir = null;
  /** @type {string | undefined} */
  let profilePath;

  try {
    // Private temp under already-writable workspace/scratch bind — never campaign.
    const tempParent =
      opts.privateTempParent != null &&
      String(opts.privateTempParent).trim() !== ''
        ? String(opts.privateTempParent)
        : String(opts.cwd);
    await assertPathOutsideCampaign(tempParent, campaignDir);
    const canonicalTempParent = await canonicalPath(tempParent);
    const allowedTempParents = [String(opts.cwd), ...(opts.extraBindPaths ?? [])];
    let tempParentAllowed = false;
    for (const allowed of allowedTempParents) {
      const canonicalAllowed = await canonicalPath(allowed);
      if (
        canonicalTempParent === canonicalAllowed ||
        canonicalTempParent.startsWith(canonicalAllowed + path.sep)
      ) {
        tempParentAllowed = true;
        break;
      }
    }
    if (!tempParentAllowed) {
      throw new Error(
        `private temp parent must be inside cwd or an explicit writable bind: ${canonicalTempParent}`,
      );
    }
    privateTempDir = await createProviderPrivateTemp(tempParent);
    await assertPathOutsideCampaign(privateTempDir, campaignDir);

    if (confinement.kind === 'sandbox-exec') {
      // Seatbelt profile lives on the host outside the sandbox tree (sandbox-exec
      // reads -f path before applying the profile). Host tmp is fine here.
      profileDir = await mkdtemp(path.join(os.tmpdir(), 'aicb-provider-sb-'));
      profilePath = path.join(profileDir, 'provider.sb');
      const profile = buildProviderSeatbeltProfile(campaignPaths);
      await writeFile(profilePath, profile, { encoding: 'utf8', mode: 0o600 });
    }

    // Ensure the private temp is RW-bound under bwrap (redundant when under cwd,
    // required when privateTempParent is an external scratch path).
    /** @type {string[]} */
    const extraBindPaths = [
      ...(Array.isArray(opts.extraBindPaths) ? opts.extraBindPaths : []),
      privateTempDir,
    ];

    const wrapped = buildProviderConfinedArgv({
      confinement,
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      campaignPaths,
      profilePath,
      extraBindPaths,
    });

    const tempToClean = privateTempDir;
    const profileToClean = profileDir;
    // Ownership transferred to cleanup; avoid double-rm on success return.
    privateTempDir = null;
    profileDir = null;

    return {
      ok: true,
      command: wrapped.command,
      args: wrapped.args,
      confinement,
      campaignPaths,
      privateTempDir: tempToClean,
      cleanup: async () => {
        if (profileToClean) {
          await rm(profileToClean, { recursive: true, force: true }).catch(
            () => {},
          );
        }
        if (tempToClean) {
          await rm(tempToClean, { recursive: true, force: true }).catch(
            () => {},
          );
        }
      },
    };
  } catch (err) {
    if (profileDir) {
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
    if (privateTempDir) {
      await rm(privateTempDir, { recursive: true, force: true }).catch(() => {});
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
