/**
 * Corpus-wide requirements evidence binding completeness.
 * Ensures every mustHave on a task with a requirements gate resolves to a real
 * eligibility gate that precedes the requirements gate (by order).
 * No live providers. No corpus mutation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const CORPUS = path.join(REPO, 'benchmarks', 'cli-comparison');
const TASKS_ROOT = path.join(CORPUS, 'tasks');

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listYamlFiles(dir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await listYamlFiles(abs)));
    } else if (ent.isFile() && ent.name.endsWith('.yaml')) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Resolve the evidence gate name a mustHave item binds to (mirrors gates.js rules).
 * @param {Record<string, unknown>} item
 * @param {(item: Record<string, unknown>) => string | null} resolveItemEvidenceGateName
 * @returns {{ kind: 'gate', name: string } | { kind: 'oraclePath', path: string } | { kind: 'error', message: string }}
 */
function resolveMustHaveBinding(item, resolveItemEvidenceGateName) {
  const substantiation = String(item.substantiation ?? '')
    .trim()
    .toLowerCase();
  if (!substantiation) {
    return {
      kind: 'error',
      message: 'missing substantiation',
    };
  }

  const explicit = resolveItemEvidenceGateName(item);
  const oraclePath =
    typeof item.oraclePath === 'string' && item.oraclePath.trim()
      ? item.oraclePath.trim()
      : null;

  if (substantiation === 'test' || substantiation === 'tests') {
    return { kind: 'gate', name: explicit || 'tests' };
  }

  // Static / other: explicit evidenceGate|gate or oraclePath only
  if (oraclePath) {
    return { kind: 'oraclePath', path: oraclePath };
  }
  if (explicit) {
    return { kind: 'gate', name: explicit };
  }
  return {
    kind: 'error',
    message: `substantiation="${substantiation}" requires explicit evidenceGate, gate, or oraclePath`,
  };
}

describe('corpus requirements evidence binding', () => {
  it('every mustHave on a requirements-gated task binds to a preceding evidence gate', async () => {
    const { loadTask } = await import('../harness/load.js');
    const { resolveItemEvidenceGateName } = await import('../harness/gates.js');

    const taskFiles = await listYamlFiles(TASKS_ROOT);
    assert.ok(taskFiles.length > 0, 'expected corpus task YAML files');

    /** @type {string[]} */
    const failures = [];
    let requirementsTasks = 0;
    let mustHaveChecked = 0;

    for (const taskPath of taskFiles.sort()) {
      const task = await loadTask(taskPath);
      const gates = Array.isArray(task.eligibilityGates)
        ? task.eligibilityGates
        : [];
      const reqGate = gates.find((g) => g && g.gate === 'requirements');
      if (!reqGate) continue;

      requirementsTasks += 1;
      const taskId = String(task.taskId || path.basename(taskPath));
      const reqOrder =
        typeof reqGate.order === 'number' ? reqGate.order : Number.NaN;
      if (!Number.isFinite(reqOrder)) {
        failures.push(`${taskId}: requirements gate missing numeric order`);
        continue;
      }

      /** @type {Map<string, { order: number, gate: Record<string, unknown> }>} */
      const byName = new Map();
      for (const g of gates) {
        if (!g || typeof g.gate !== 'string') continue;
        const order = typeof g.order === 'number' ? g.order : Number.NaN;
        byName.set(g.gate, { order, gate: g });
      }

      const mustHave = Array.isArray(task.expectedOutcome?.mustHave)
        ? task.expectedOutcome.mustHave
        : [];
      if (mustHave.length === 0) {
        failures.push(`${taskId}: requirements gate present but mustHave empty`);
        continue;
      }

      for (const item of mustHave) {
        mustHaveChecked += 1;
        const id =
          item && item.id != null ? String(item.id) : '(no-id)';
        if (!item || typeof item !== 'object') {
          failures.push(`${taskId}/${id}: invalid mustHave item`);
          continue;
        }

        const binding = resolveMustHaveBinding(
          item,
          resolveItemEvidenceGateName,
        );
        if (binding.kind === 'error') {
          failures.push(`${taskId}/${id}: ${binding.message}`);
          continue;
        }

        if (binding.kind === 'oraclePath') {
          const oracleGates = gates.filter(
            (g) =>
              g &&
              g.gate === 'oracle' &&
              typeof g.oraclePath === 'string' &&
              g.oraclePath.replace(/\\/g, '/') ===
                binding.path.replace(/\\/g, '/'),
          );
          if (oracleGates.length === 0) {
            // Allow explicit evidenceGate name that is an oracle gate
            const explicit = resolveItemEvidenceGateName(item);
            if (explicit && byName.has(explicit)) {
              const found = byName.get(explicit);
              if (
                !(
                  found &&
                  Number.isFinite(found.order) &&
                  found.order < reqOrder
                )
              ) {
                failures.push(
                  `${taskId}/${id}: oraclePath=${binding.path} evidenceGate="${explicit}" must precede requirements (order ${reqOrder})`,
                );
              }
            } else {
              failures.push(
                `${taskId}/${id}: oraclePath=${binding.path} has no matching eligibilityGates oracle entry preceding requirements`,
              );
            }
            continue;
          }
          const preceding = oracleGates.some(
            (g) => typeof g.order === 'number' && g.order < reqOrder,
          );
          if (!preceding) {
            failures.push(
              `${taskId}/${id}: oraclePath=${binding.path} oracle gate must precede requirements (order ${reqOrder})`,
            );
          }
          continue;
        }

        // binding.kind === 'gate'
        const found = byName.get(binding.name);
        if (!found) {
          failures.push(
            `${taskId}/${id}: evidence gate "${binding.name}" not present in eligibilityGates`,
          );
          continue;
        }
        if (!Number.isFinite(found.order) || !(found.order < reqOrder)) {
          failures.push(
            `${taskId}/${id}: evidence gate "${binding.name}" order=${found.order} must be < requirements order=${reqOrder}`,
          );
        }
      }
    }

    assert.ok(
      requirementsTasks > 0,
      'expected at least one task with a requirements gate',
    );
    assert.ok(mustHaveChecked > 0, 'expected at least one mustHave item');
    assert.deepEqual(
      failures,
      [],
      `corpus requirements binding failures:\n${failures.join('\n')}`,
    );
  });

  it('artifactRef alone does not substantiate static mustHave (metadata only)', async () => {
    const { evaluateRequirements } = await import('../harness/gates.js');
    const result = await evaluateRequirements({
      gate: { gate: 'requirements', order: 9, required: true },
      task: {
        expectedOutcome: {
          mustHave: [
            {
              id: 'static-only-ref',
              description: 'has artifactRef but no evidenceGate',
              substantiation: 'static',
              artifactRef: 'scripts/check-something.js',
            },
          ],
        },
      },
      priorGateResults: [
        {
          gate: 'tests',
          required: true,
          status: 'passed',
          classificationSignal: 'PASS',
        },
      ],
    });
    assert.equal(result.status, 'execution_unavailable');
    assert.match(String(result.evidence), /evidenceGate|oraclePath/i);
    assert.doesNotMatch(
      String(result.evidence),
      /artifactRef (was |is )?executed/i,
    );
  });
});
