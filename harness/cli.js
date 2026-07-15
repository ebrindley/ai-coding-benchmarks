#!/usr/bin/env node
/**
 * Quiet CLI entrypoint: aicb
 *
 * Commands:
 *   aicb self-validate [--root <path>]
 *   aicb run --experiment <path> [--corpus <path>] [--campaign <path>] [--resume] [--max-trials N] [--no-execute]
 *   aicb export --campaign <path> --out <path> [--include-raw]
 *   aicb summary --campaign <path> [--json]
 *
 * Exit codes: 0 ok, 1 usage/validation error, 2 runtime failure.
 * No live provider trials unless experiment arms configure invokers; tests use fakes.
 */

import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { selfValidate } from './preflight.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * @param {string[]} argv
 * @returns {Record<string, string | boolean | string[]>}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string | boolean | string[]>} */
  const out = { _: [] };
  /** @type {string[]} */
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        const key = a.slice(2, eq);
        const val = a.slice(eq + 1);
        out[key] = val;
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      positional.push(a);
    }
  }
  out._ = positional;
  return out;
}

function usage() {
  return [
    'aicb — optional local harness for ai-coding-benchmarks',
    '',
    'Usage:',
    '  aicb self-validate [--root <path>]',
    '  aicb run --experiment <path> [--corpus <path>] [--campaign <path>]',
    '      [--resume] [--max-trials N] [--no-execute]',
    '  aicb export --campaign <path> --out <path> [--include-raw]',
    '  aicb summary --campaign <path> [--json]',
    '',
    'Does not upload or publish results. Raw provider output is quarantined.',
  ].join('\n');
}

/**
 * @param {string} filePath
 * @returns {Promise<object>}
 */
async function loadExperimentFile(filePath) {
  const abs = path.resolve(filePath);
  const text = await readFile(abs, 'utf8');
  if (abs.endsWith('.yaml') || abs.endsWith('.yml')) {
    return parseYaml(text);
  }
  return JSON.parse(text);
}

/**
 * @param {string[]} argv
 * @param {{ stdout?: (s: string) => void, stderr?: (s: string) => void }} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  const writeOut = io.stdout ?? ((s) => process.stdout.write(s));
  const writeErr = io.stderr ?? ((s) => process.stderr.write(s));

  const args = parseArgs(argv);
  const positional = /** @type {string[]} */ (args._);
  const command = positional[0];

  if (!command || command === 'help' || args.help) {
    writeOut(`${usage()}\n`);
    return command && command !== 'help' && !args.help ? 1 : 0;
  }

  try {
    if (command === 'self-validate') {
      const root = typeof args.root === 'string' ? args.root : REPO_ROOT;
      const result = await selfValidate(root);
      if (result.ok) {
        writeOut('self-validate: ok\n');
        return 0;
      }
      writeErr(`self-validate: failed\n${result.errors.map((e) => `  - ${e}`).join('\n')}\n`);
      return 1;
    }

    if (command === 'run') {
      if (typeof args.experiment !== 'string') {
        writeErr('error: --experiment <path> is required\n');
        return 1;
      }
      const experiment = await loadExperimentFile(args.experiment);
      const corpusRoot =
        typeof args.corpus === 'string'
          ? path.resolve(args.corpus)
          : path.resolve(experiment.corpusRoot || path.join(REPO_ROOT, 'benchmarks'));
      const campaignDir =
        typeof args.campaign === 'string' ? path.resolve(args.campaign) : undefined;

      const { runCampaign } = await import('./run.js');
      const result = await runCampaign({
        experiment,
        corpusRoot,
        campaignDir,
        harnessRoot: REPO_ROOT,
        resume: args.resume !== false && args['no-resume'] !== true,
        execute: args['no-execute'] !== true,
        maxTrials:
          args['max-trials'] != null ? Number(args['max-trials']) : undefined,
        log: (msg) => writeErr(`${msg}\n`),
      });

      if (!result.ok) {
        writeErr(`run failed at ${result.stage}: ${(result.errors || []).join('; ')}\n`);
        return 2;
      }
      writeOut(
        JSON.stringify(
          {
            ok: true,
            campaignDir: result.campaignDir,
            executed: result.executed,
            remaining: result.remaining,
            status: result.manifest?.status,
          },
          null,
          2,
        ) + '\n',
      );
      return 0;
    }

    if (command === 'export') {
      if (typeof args.campaign !== 'string' || typeof args.out !== 'string') {
        writeErr('error: --campaign and --out are required\n');
        return 1;
      }
      const { exportSanitizedBundle } = await import('./export.js');
      const result = await exportSanitizedBundle({
        campaignDir: path.resolve(args.campaign),
        outDir: path.resolve(args.out),
        includeRaw: args['include-raw'] === true,
      });
      writeOut(JSON.stringify({ ok: true, ...result }, null, 2) + '\n');
      return 0;
    }

    if (command === 'summary') {
      if (typeof args.campaign !== 'string') {
        writeErr('error: --campaign is required\n');
        return 1;
      }
      const campaignDir = path.resolve(args.campaign);
      const reportPath = path.join(campaignDir, 'report.json');
      try {
        await access(reportPath);
      } catch {
        // rebuild from manifest + results
        const { loadManifest } = await import('./manifest.js');
        const { readTrialResult } = await import('./results.js');
        const { buildReport, formatHumanSummary } = await import('./summary.js');
        const manifest = await loadManifest(campaignDir);
        const results = [];
        for (const t of manifest.trials || []) {
          try {
            results.push(await readTrialResult(campaignDir, t.id));
          } catch {
            results.push(t);
          }
        }
        const report = buildReport(manifest, results);
        if (args.json) {
          writeOut(`${JSON.stringify(report, null, 2)}\n`);
        } else {
          writeOut(`${formatHumanSummary(report)}\n`);
        }
        return 0;
      }
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      if (args.json) {
        writeOut(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        try {
          const { formatHumanSummary } = await import('./summary.js');
          writeOut(`${formatHumanSummary(report)}\n`);
        } catch {
          writeOut(`${JSON.stringify(report, null, 2)}\n`);
        }
      }
      return 0;
    }

    writeErr(`unknown command: ${command}\n${usage()}\n`);
    return 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeErr(`error: ${message}\n`);
    return 2;
  }
}

const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirect) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
