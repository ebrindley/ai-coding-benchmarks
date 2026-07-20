/**
 * Isolated trial workspaces created from corpus fixtures.
 *
 * Copies the fixture tree without following symlinks that escape the fixture root,
 * initializes a fresh git repository, and never inherits harness-repo instruction files.
 *
 * Provider execution workspaces live under a private temporary root
 * (`os.tmpdir()/aicb-exec/<campaignId>/…`), **not** under the campaign tree.
 * That is filesystem-tree separation only (ancestor walks cannot reach
 * campaign raw/manifest/locks/results via `..` from the provider cwd). It is
 * **not** OS-level read isolation.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readdir,
  lstat,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
  chmod,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { digestArtifactDir, isSkippedFixtureEntry } from './digest.js';
import {
  assertInsideRoot,
  isPathInside,
  PathEscapeError,
  resolveWorkspaceRoot,
} from './paths.js';

/**
 * Private temporary prefix for provider execution workspaces (outside campaign).
 * Campaign tree still holds artifacts, results, raw, manifest, locks.
 */
export const EXECUTION_TMP_PREFIX = 'aicb-exec';

/**
 * Instruction / VCS names that must never be inherited from the harness repo
 * into a trial workspace (root only).
 * Note: `.git` and `node_modules` are also excluded at any depth via
 * `isSkippedFixtureEntry` — identical policy to directory digests
 * (`FIXTURE_SKIP_DIR_NAMES` in digest.js).
 */
const BLOCKED_ROOT_NAMES = new Set([
  '.git',
  'AGENTS.md',
  'Agents.md',
  'AGENT.md',
  'CLAUDE.md',
  'Claude.md',
  '.claude',
]);

/**
 * @param {string} trialId
 * @returns {string}
 */
export function sanitizeTrialId(trialId) {
  const raw = String(trialId ?? 'trial').trim() || 'trial';
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

/**
 * Resolve the private execution root for a campaign's provider workspaces.
 * Always under `os.tmpdir()/aicb-exec/<campaignId-safe>/` (or baseTmp override),
 * never under the campaign directory.
 *
 * @param {object} [opts]
 * @param {string} [opts.campaignId]
 * @param {string} [opts.baseTmp] - override tmp root (tests)
 * @returns {string} absolute execution root
 */
export function resolveExecutionRoot(opts = {}) {
  const base =
    opts.baseTmp != null && String(opts.baseTmp).trim() !== ''
      ? path.resolve(String(opts.baseTmp))
      : os.tmpdir();
  const campaignSeg =
    opts.campaignId != null && String(opts.campaignId).trim() !== ''
      ? sanitizeTrialId(opts.campaignId)
      : 'campaign';
  return path.join(base, EXECUTION_TMP_PREFIX, campaignSeg || 'campaign');
}

/**
 * Canonicalize a path for ancestor checks (realpath when possible).
 * @param {string} p
 * @returns {Promise<string>}
 */
async function realpathOrResolve(p) {
  const abs = path.resolve(String(p));
  try {
    return await realpath(abs);
  } catch {
    return abs;
  }
}

/**
 * True when `ancestor` is a strict filesystem ancestor of `descendant`
 * (or equal). Uses realpath when available.
 *
 * @param {string} ancestorAbs
 * @param {string} descendantAbs
 * @returns {boolean}
 */
export function isStrictPathAncestor(ancestorAbs, descendantAbs) {
  return isPathInside(path.resolve(ancestorAbs), path.resolve(descendantAbs));
}

/**
 * Assert provider workspace is **not** under the campaign tree.
 * Walks `..` from workspaceDir to filesystem root; campaignDir must never
 * appear as an ancestor. Fail closed if it does.
 *
 * Honesty bound: this proves filesystem-tree separation only — not OS read isolation.
 *
 * @param {string} workspaceDir
 * @param {string} campaignDir
 * @returns {Promise<{ workspaceDir: string, campaignDir: string }>}
 */
export async function assertWorkspaceOutsideCampaign(workspaceDir, campaignDir) {
  if (workspaceDir == null || String(workspaceDir).trim() === '') {
    throw new PathEscapeError('assertWorkspaceOutsideCampaign: workspaceDir is required', {
      code: 'WORKSPACE_REQUIRED',
    });
  }
  if (campaignDir == null || String(campaignDir).trim() === '') {
    throw new PathEscapeError('assertWorkspaceOutsideCampaign: campaignDir is required', {
      code: 'CAMPAIGN_REQUIRED',
    });
  }

  const ws = await realpathOrResolve(workspaceDir);
  const camp = await realpathOrResolve(campaignDir);

  if (isPathInside(camp, ws)) {
    throw new PathEscapeError(
      `execution workspace must not be under campaign tree: workspace "${ws}" is inside campaign "${camp}"`,
      { root: camp, candidate: ws, code: 'WORKSPACE_UNDER_CAMPAIGN' },
    );
  }

  // Walk ancestors of workspace; campaign path must never appear.
  let cur = ws;
  const root = path.parse(cur).root;
  while (cur !== root) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    if (parent === camp || (await realpathOrResolve(parent)) === camp) {
      throw new PathEscapeError(
        `campaign is an ancestor of execution workspace (fail closed): campaign="${camp}" workspace="${ws}"`,
        { root: camp, candidate: ws, code: 'CAMPAIGN_ANCESTOR' },
      );
    }
    cur = parent;
  }

  return { workspaceDir: ws, campaignDir: camp };
}

/**
 * Best-effort remove of an execution workspace created under the private root.
 * Fail closed: refuses to remove paths outside the allowed execution root.
 *
 * @param {string} workspaceDir
 * @param {object} [opts]
 * @param {string} [opts.executionRoot] - must contain workspaceDir
 * @returns {Promise<{ removed: boolean, reason?: string }>}
 */
export async function cleanupExecutionWorkspace(workspaceDir, opts = {}) {
  if (workspaceDir == null || String(workspaceDir).trim() === '') {
    return { removed: false, reason: 'missing-workspace' };
  }

  const abs = path.resolve(String(workspaceDir));
  const allowedRoot =
    opts.executionRoot != null && String(opts.executionRoot).trim() !== ''
      ? path.resolve(String(opts.executionRoot))
      : path.join(os.tmpdir(), EXECUTION_TMP_PREFIX);

  // Never rm the execution root itself — only a trial workspace under it.
  if (abs === path.resolve(allowedRoot)) {
    return { removed: false, reason: 'refused-execution-root' };
  }

  try {
    await assertInsideRoot(allowedRoot, abs);
  } catch (err) {
    return {
      removed: false,
      reason: `outside-execution-root: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) {
      // Unlink the link only — never follow into an unexpected target tree.
      await unlink(abs);
      return { removed: true, reason: 'unlinked-symlink' };
    }
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') {
      return { removed: false, reason: 'absent' };
    }
    return {
      removed: false,
      reason: `lstat-failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    await rm(abs, { recursive: true, force: true });
    return { removed: true };
  } catch (err) {
    return {
      removed: false,
      reason: `rm-failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Immutable fixture-baseline ref created at workspace init.
 * baseline-diff and changed-file counting compare against this, never mutable HEAD/status alone.
 */
export const FIXTURE_BASELINE_REF = 'aicb-fixture-baseline';

/**
 * Non-protected trial branch for in-place Poetic edits.
 * @param {string} trialId
 * @returns {string}
 */
export function trialBranchName(trialId) {
  return `run/aicb-${sanitizeTrialId(trialId)}`;
}

/**
 * Neutral local Git config overrides so provider-controlled repo config cannot
 * run hooks, fsmonitor, external diff/textconv, LFS filters, or editors.
 * Applied as `git -c key=value …` on every harness-owned Git invocation.
 */
export const HARNESS_GIT_NEUTRAL_CONFIG = Object.freeze([
  ['core.hooksPath', process.platform === 'win32' ? 'NUL' : '/dev/null'],
  ['core.fsmonitor', ''],
  ['core.fsmonitorHook', ''],
  ['core.useBuiltinFSMonitor', 'false'],
  ['diff.external', ''],
  ['diff.renames', 'true'],
  ['pager.diff', 'false'],
  ['pager.status', 'false'],
  ['interactive.diffFilter', ''],
  ['filter.lfs.process', ''],
  ['filter.lfs.smudge', ''],
  ['filter.lfs.clean', ''],
  ['filter.lfs.required', 'false'],
  ['commit.gpgsign', 'false'],
  ['tag.gpgsign', 'false'],
  ['log.showSignature', 'false'],
  ['advice.detachedHead', 'false'],
  ['gc.auto', '0'],
]);

/**
 * Build argv for harness-owned git: neutral `-c` overrides then caller args.
 * Caller args should be the git subcommand form (e.g. `['status', '--porcelain']`),
 * not including the `git` binary itself.
 * @param {string[]} gitArgs
 * @returns {string[]}
 */
export function buildHarnessGitArgv(gitArgs) {
  /** @type {string[]} */
  const argv = [];
  for (const [key, value] of HARNESS_GIT_NEUTRAL_CONFIG) {
    argv.push('-c', `${key}=${value}`);
  }
  if (Array.isArray(gitArgs)) {
    for (const a of gitArgs) argv.push(String(a));
  }
  return argv;
}

/**
 * Minimal env for harness-owned git. Strips GIT_DIR / worktree overrides and
 * blocks system/global config so repo-local provider config cannot re-enable
 * callbacks via include.path tricks at those layers.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [baseEnv]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildHarnessGitEnv(baseEnv = process.env) {
  const pathEnv =
    (baseEnv && typeof baseEnv.PATH === 'string' && baseEnv.PATH) ||
    '/usr/bin:/bin:/usr/local/bin';
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    PATH: pathEnv,
    LANG: (baseEnv && baseEnv.LANG) || 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_EDITOR: 'true',
    GIT_TEMPLATE_DIR: '',
    // Never inherit provider-influenced identity/worktree overrides.
    // (Explicit absence — do not set GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR.)
  };
  // Preserve HOME only when present (some git builds want it); never required.
  if (baseEnv && typeof baseEnv.HOME === 'string' && baseEnv.HOME) {
    env.HOME = baseEnv.HOME;
  }
  return env;
}

/**
 * Default argv-only git spawn (no shell) with harness-neutral config/env.
 * Injectable for tests via opts.gitSpawn (receives *logical* args, pre -c wrap,
 * so tests can assert subcommands without depending on neutral flag lists).
 * @param {string[]} args logical git args (e.g. ['status', '--porcelain', '-z'])
 * @param {string} cwd
 * @returns {Promise<{ exitCode: number | null, stdout: string, stderr: string }>}
 */
export function defaultGitSpawn(args, cwd) {
  const argv = buildHarnessGitArgv(args);
  const env = buildHarnessGitEnv(process.env);
  return new Promise((resolve, reject) => {
    const child = spawn('git', argv, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    // Binary-safe accumulation: git -z paths may contain non-utf8 bytes.
    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    child.stdout?.on('data', (c) => {
      stdoutChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    });
    child.stderr?.on('data', (c) => {
      stderrChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    });
    child.on('error', (err) => {
      reject(err);
    });
    child.on('close', (code) => {
      stdout = Buffer.concat(stdoutChunks).toString('utf8');
      stderr = Buffer.concat(stderrChunks).toString('utf8');
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

/**
 * Run a harness-owned git command in cwd (neutral config/env).
 * @param {string} cwd
 * @param {string[]} args logical git args
 * @param {{ gitSpawn?: (args: string[], cwd: string) => Promise<{ exitCode: number | null, stdout: string, stderr: string }> }} [opts]
 * @returns {Promise<{ exitCode: number | null, stdout: string, stderr: string }>}
 */
export async function runHarnessGit(cwd, args, opts = {}) {
  const spawnFn = opts.gitSpawn ?? defaultGitSpawn;
  return spawnFn(args, path.resolve(cwd));
}

/**
 * Copy a fixture tree into dest without following symlinks out of fixtureRoot.
 * Escaping symlinks are rejected (fail closed).
 *
 * @param {string} fixtureRoot
 * @param {string} destRoot
 * @returns {Promise<void>}
 */
export async function copyFixtureTree(fixtureRoot, destRoot) {
  // Canonicalize roots so macOS /tmp vs /private/tmp does not false-reject internal links.
  let srcRoot = path.resolve(fixtureRoot);
  try {
    srcRoot = await realpath(srcRoot);
  } catch {
    /* keep resolved path if root not yet fully materialized */
  }
  const dstRoot = path.resolve(destRoot);

  await assertInsideRoot(srcRoot, srcRoot);
  await mkdir(dstRoot, { recursive: true });

  /**
   * @param {string} srcDir
   * @param {string} dstDir
   * @param {string} rel
   */
  async function walk(srcDir, dstDir, rel) {
    // Ensure current srcDir is still inside fixture root (symlink dir attacks).
    const realSrcDir = await assertInsideRoot(srcRoot, srcDir);

    let entries;
    try {
      entries = await readdir(realSrcDir, { withFileTypes: true });
    } catch (err) {
      throw new PathEscapeError(
        `failed to read fixture directory "${rel || '.'}": ${err instanceof Error ? err.message : String(err)}`,
        { root: srcRoot, candidate: realSrcDir, code: 'FIXTURE_READ' },
      );
    }

    for (const entry of entries) {
      // Exclusion policy aligned with digest.js: skip .git and node_modules at any depth
      // (neither copied nor digested). Documented in FIXTURE_SKIP_DIR_NAMES.
      if (isSkippedFixtureEntry(entry.name)) {
        continue;
      }
      // Never pull harness instruction entries even if a fixture accidentally includes them.
      if (rel === '' && BLOCKED_ROOT_NAMES.has(entry.name)) {
        continue;
      }

      const srcPath = path.join(realSrcDir, entry.name);
      const dstPath = path.join(dstDir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;

      let st;
      try {
        st = await lstat(srcPath);
      } catch (err) {
        throw new PathEscapeError(
          `failed to lstat fixture entry "${childRel}": ${err instanceof Error ? err.message : String(err)}`,
          { root: srcRoot, candidate: srcPath, code: 'FIXTURE_LSTAT' },
        );
      }

      if (st.isSymbolicLink()) {
        let linkTarget;
        try {
          linkTarget = await readlink(srcPath);
        } catch (err) {
          throw new PathEscapeError(
            `failed to readlink fixture entry "${childRel}": ${err instanceof Error ? err.message : String(err)}`,
            { root: srcRoot, candidate: srcPath, code: 'FIXTURE_READLINK' },
          );
        }
        // Fail closed: absolute fixture symlinks are never preserved.
        if (path.isAbsolute(linkTarget)) {
          throw new PathEscapeError(
            `fixture absolute symlink rejected: "${childRel}" -> "${linkTarget}"`,
            { root: srcRoot, candidate: linkTarget, code: 'ABSOLUTE_SYMLINK' },
          );
        }
        // Preserve only relative internal symlinks that resolve inside fixture root.
        // Compare using realpath-canonical roots (macOS /var -> /private/var).
        const resolved = path.resolve(path.dirname(srcPath), linkTarget);
        let resolvedCanon = resolved;
        try {
          // realpath parent + join remaining (target may not exist yet)
          resolvedCanon = path.resolve(
            await realpath(path.dirname(srcPath)),
            linkTarget,
          );
        } catch {
          resolvedCanon = resolved;
        }
        if (!isPathInside(srcRoot, resolvedCanon)) {
          throw new PathEscapeError(
            `fixture symlink escapes fixture root: "${childRel}" -> "${linkTarget}"`,
            { root: srcRoot, candidate: resolvedCanon, code: 'SYMLINK_ESCAPE' },
          );
        }
        // Re-create with the same relative target string (not followed).
        await symlink(linkTarget, dstPath);
        continue;
      }

      if (st.isDirectory()) {
        await mkdir(dstPath, { recursive: true });
        await walk(srcPath, dstPath, childRel);
        continue;
      }

      if (st.isFile()) {
        await copyFile(srcPath, dstPath);
        try {
          await utimes(dstPath, st.atime, st.mtime);
        } catch {
          /* best-effort timestamps */
        }
        continue;
      }

      // Skip sockets, devices, FIFOs — not meaningful fixture content.
    }
  }

  await walk(srcRoot, dstRoot, '');
}

/**
 * Initialize a fresh git repository on a non-protected trial branch
 * `run/aicb-<safe-trial>` so in-place Poetic runs are not rejected.
 *
 * @param {string} workspaceDir
 * @param {object} [opts]
 * @param {string} [opts.trialId]
 * @param {(args: string[], cwd: string) => Promise<{ exitCode: number | null, stdout: string, stderr: string }>} [opts.gitSpawn]
 * @returns {Promise<{ branch: string, gitArgvLog: string[][] }>}
 */
export async function initWorkspaceGit(workspaceDir, opts = {}) {
  const cwd = path.resolve(workspaceDir);
  const gitSpawn = opts.gitSpawn ?? defaultGitSpawn;
  /** @type {string[][]} */
  const gitArgvLog = [];
  /**
   * @param {string[]} args
   */
  const run = async (args) => {
    gitArgvLog.push([...args]);
    return gitSpawn(args, cwd);
  };

  const init = await run(['init']);
  if (init.exitCode !== 0) {
    throw new Error(
      `git init failed in workspace (exit ${init.exitCode}): ${init.stderr || init.stdout}`,
    );
  }
  for (const args of [
    ['config', 'user.email', 'harness@local'],
    ['config', 'user.name', 'aicb-harness'],
    // Record identity only in this workspace; do not enable hooks/fsmonitor.
    ['config', 'core.hooksPath', process.platform === 'win32' ? 'NUL' : '/dev/null'],
    ['config', 'core.fsmonitor', ''],
    ['add', '-A'],
    ['commit', '--allow-empty', '-m', 'aicb-harness fixture baseline'],
    // Immutable authority for baseline-diff: tag the pristine fixture commit.
    // Diff compares to this ref, not mutable HEAD or dirty-status alone.
    ['tag', '-m', 'aicb fixture baseline', FIXTURE_BASELINE_REF],
  ]) {
    const result = await run(args);
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${args[0]} failed in workspace (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
      );
    }
  }

  const branch = trialBranchName(opts.trialId ?? 'trial');
  // Create/switch to non-protected trial branch for in-place edits
  const co = await run(['checkout', '-B', branch]);
  if (co.exitCode !== 0) {
    throw new Error(
      `git checkout -B ${branch} failed (exit ${co.exitCode}): ${co.stderr || co.stdout}`,
    );
  }

  return { branch, gitArgvLog, baselineRef: FIXTURE_BASELINE_REF };
}

/**
 * Create an isolated trial workspace from a fixture directory.
 *
 * Prefer an external `workspaceRoot` from {@link resolveExecutionRoot} so the
 * provider cwd is not under the campaign tree. When `campaignDir` is provided,
 * asserts the created workspace is outside that tree.
 *
 * @param {object} opts
 * @param {string} opts.fixtureDir - absolute path to fixture root
 * @param {string} [opts.workspaceRoot] - parent directory for trial workspaces (execution root)
 * @param {string} [opts.campaignId] - used when defaulting workspaceRoot via resolveExecutionRoot
 * @param {string} [opts.campaignDir] - when set, assert workspace is outside campaign tree
 * @param {string} opts.trialId - unique trial identifier
 * @param {(args: string[], cwd: string) => Promise<{ exitCode: number | null, stdout: string, stderr: string }>} [opts.gitSpawn]
 * @returns {Promise<{ workspaceDir: string, fixtureHash: string, branch: string, executionRoot: string }>}
 */
export async function createIsolatedWorkspace({
  fixtureDir,
  workspaceRoot,
  campaignId,
  campaignDir,
  trialId,
  gitSpawn,
}) {
  if (fixtureDir == null || String(fixtureDir).trim() === '') {
    throw new Error('createIsolatedWorkspace: fixtureDir is required');
  }
  if (trialId == null || String(trialId).trim() === '') {
    throw new Error('createIsolatedWorkspace: trialId is required');
  }

  const fixtureAbs = path.resolve(String(fixtureDir));
  const fixtureStat = await lstat(fixtureAbs);
  if (!fixtureStat.isDirectory()) {
    throw new Error(`createIsolatedWorkspace: fixtureDir is not a directory: ${fixtureAbs}`);
  }

  // Default parent is under aicb-exec (private tmp), not the campaign tree.
  // Callers (runCampaign) should pass resolveExecutionRoot(...) explicitly.
  const parent =
    workspaceRoot != null && String(workspaceRoot).trim() !== ''
      ? resolveWorkspaceRoot(workspaceRoot)
      : resolveExecutionRoot({ campaignId: campaignId ?? trialId });

  await mkdir(parent, { recursive: true, mode: 0o700 });
  try {
    await chmod(parent, 0o700);
  } catch {
    /* best-effort private mode */
  }

  const unique = `${sanitizeTrialId(trialId)}-${randomBytes(8).toString('hex')}`;
  const workspaceDir = path.join(parent, unique);
  await assertInsideRoot(parent, workspaceDir);
  await mkdir(workspaceDir, { recursive: true, mode: 0o700 });

  if (campaignDir != null && String(campaignDir).trim() !== '') {
    await assertWorkspaceOutsideCampaign(workspaceDir, campaignDir);
  }

  // Copy first, then digest the exact effective tree used in execution
  // (post-copy content: same exclusions as digests, before marker/git).
  await copyFixtureTree(fixtureAbs, workspaceDir);
  const fixtureHash = await digestArtifactDir(workspaceDir);

  const branch = trialBranchName(trialId);
  await writeFile(
    path.join(workspaceDir, '.aicb-workspace'),
    `trialId=${String(trialId)}\nfixtureHash=${fixtureHash}\nbranch=${branch}\nexecutionRoot=${parent}\n`,
    'utf8',
  );

  const git = await initWorkspaceGit(workspaceDir, { trialId, gitSpawn });

  return {
    workspaceDir,
    fixtureHash,
    branch: git.branch,
    executionRoot: parent,
  };
}
