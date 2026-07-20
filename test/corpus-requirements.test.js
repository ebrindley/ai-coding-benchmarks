/**
 * Corpus-wide requirements evidence binding completeness and task-oracle contracts.
 * Ensures every mustHave on a task with a requirements gate resolves to a real
 * eligibility gate that precedes the requirements gate (by order).
 * Also guards demonstrated oracle honesty defects (metadata, scale claims, 201,
 * externalized RPN tests, SQLite stated requirements).
 * No live providers. No corpus mutation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const CORPUS = path.join(REPO, 'benchmarks', 'cli-comparison');
const TASKS_ROOT = path.join(CORPUS, 'tasks');
const FIXTURES = path.join(CORPUS, 'fixtures');

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

describe('corpus task-oracle contracts', () => {
  it('task YAML has no dead scoring/toolEvidencePolicy; networkPolicy only allowed', async () => {
    const { loadTask } = await import('../harness/load.js');
    const taskFiles = await listYamlFiles(TASKS_ROOT);
    /** @type {string[]} */
    const failures = [];

    for (const taskPath of taskFiles.sort()) {
      const raw = await readFile(taskPath, 'utf8');
      const taskId = path.basename(taskPath);
      if (/^scoring:/m.test(raw)) {
        failures.push(`${taskId}: non-operational scoring block present`);
      }
      if (/^toolEvidencePolicy:/m.test(raw)) {
        failures.push(`${taskId}: non-operational toolEvidencePolicy present`);
      }
      if (/provenanceRequired:/.test(raw) || /^\s+record:/m.test(raw)) {
        failures.push(
          `${taskId}: networkPolicy must not include provenanceRequired/record`,
        );
      }

      const task = await loadTask(taskPath);
      if (task.scoring != null) {
        failures.push(`${taskId}: loaded task still has scoring`);
      }
      if (task.toolEvidencePolicy != null) {
        failures.push(`${taskId}: loaded task still has toolEvidencePolicy`);
      }
      if (task.networkPolicy != null) {
        if (typeof task.networkPolicy !== 'object') {
          failures.push(`${taskId}: networkPolicy must be an object`);
        } else {
          const keys = Object.keys(task.networkPolicy).sort();
          if (keys.length !== 1 || keys[0] !== 'allowed') {
            failures.push(
              `${taskId}: networkPolicy keys must be only [allowed], got ${JSON.stringify(keys)}`,
            );
          }
          if (typeof task.networkPolicy.allowed !== 'boolean') {
            failures.push(`${taskId}: networkPolicy.allowed must be boolean`);
          }
        }
      }
    }

    assert.deepEqual(failures, [], failures.join('\n'));
  });

  it('java god-class description matches compact fixture scale', async () => {
    const { loadTask } = await import('../harness/load.js');
    const taskPath = path.join(
      TASKS_ROOT,
      'brownfield',
      '006-java-refactor-god-class.yaml',
    );
    const task = await loadTask(taskPath);
    const desc = String(task.description || '');
    assert.doesNotMatch(
      desc,
      /2000\+?\s*lines|45 methods|12 dependencies/i,
      'description must not claim inflated god-class scale',
    );
    assert.match(
      desc,
      /~?90 lines|compact fixture|mixed-responsibility/i,
      'description should state actual compact fixture scale',
    );

    const orderService = await readFile(
      path.join(
        FIXTURES,
        'java-god-class-service',
        'src/main/java/com/example/service/OrderService.java',
      ),
      'utf8',
    );
    const lineCount = orderService.split(/\r?\n/).length;
    assert.ok(
      lineCount < 200,
      `fixture OrderService is compact (${lineCount} lines); description must stay honest`,
    );

    const checkScript = await readFile(
      path.join(
        FIXTURES,
        'java-god-class-service',
        'scripts/check-service-count.sh',
      ),
      'utf8',
    );
    assert.match(
      checkScript,
      /too thin|must own public/i,
      'service-count oracle must reject empty/thin shells',
    );
    assert.match(checkScript, /must delegate|delegate to/i);
    assert.match(checkScript, /constructor injecting all three collaborators/i);
    for (const name of [
      'InventoryService',
      'PaymentService',
      'NotificationService',
    ]) {
      assert.ok(checkScript.includes(name), `oracle missing ${name} contract`);
    }
  });

  it('spring createBook contract requires exact HTTP 201', async () => {
    const testSrc = await readFile(
      path.join(
        FIXTURES,
        'java-spring-service-harness',
        'src/test/java/com/example/BookControllerTest.java',
      ),
      'utf8',
    );
    const createIdx = testSrc.indexOf('void createBook');
    assert.ok(createIdx >= 0, 'createBook test must exist');
    const slice = testSrc
      .slice(createIdx)
      .match(/^void createBook[\s\S]*?^  }/m)?.[0];
    assert.ok(slice, 'createBook test body must be readable');
    assert.match(
      slice,
      /status\(\)\.is\(201\)|status\(\)\.isCreated\s*\(/,
      'createBook must assert exact 201/Created',
    );
    assert.doesNotMatch(
      slice,
      /is2xxSuccessful|status\(\)\.isOk\s*\(/,
      'createBook must not accept generic 2xx/200',
    );

    const oracle = await readFile(
      path.join(
        CORPUS,
        'oracles',
        'greenfield-004-java-spring-service',
        'check-http-endpoints.sh',
      ),
      'utf8',
    );
    const postOracle = oracle.slice(
      oracle.indexOf('# Test 2: POST /books'),
      oracle.indexOf('# Test 3: GET /books/{id}'),
    );
    assert.match(
      postOracle,
      /if \[\[ "\$HTTP_CODE" != "201" \]\]; then/,
      'external oracle must require exactly HTTP 201',
    );
    assert.doesNotMatch(
      postOracle,
      /expected 201 or 200|"\$HTTP_CODE" != "200"/,
      'external oracle must not accept HTTP 200 for create',
    );
  });

  it('rust RPN tests live under protected tests/ and starter is incomplete', async () => {
    const libPath = path.join(FIXTURES, 'rust-rpn-calc', 'src/lib.rs');
    const lib = await readFile(libPath, 'utf8');
    assert.doesNotMatch(
      lib,
      /#\[cfg\(test\)\]/,
      'tests must not live inside editable src/lib.rs',
    );
    assert.match(
      lib,
      /todo!|unimplemented!/,
      'starter eval must be genuinely incomplete',
    );

    const external = await readFile(
      path.join(FIXTURES, 'rust-rpn-calc', 'tests/eval_tests.rs'),
      'utf8',
    );
    assert.match(external, /fn multiplication_and_addition/);
    assert.match(external, /fn divide_by_zero_is_error/);

    const { loadTask } = await import('../harness/load.js');
    const task = await loadTask(
      path.join(TASKS_ROOT, 'greenfield', '008-rust-rpn-calculator.yaml'),
    );
    const refs = (task.expectedOutcome?.mustHave || [])
      .map((m) => String(m.artifactRef || ''))
      .join('\n');
    assert.match(refs, /tests\/eval_tests\.rs/);
    assert.doesNotMatch(refs, /src\/lib\.rs::tests/);
  });

  it('sqlite schema tests enforce stated columns, indexes, view, idempotency', async () => {
    const testSrc = await readFile(
      path.join(FIXTURES, 'sqlite-analytics-schema', 'tests/test_schema.py'),
      'utf8',
    );
    for (const needle of [
      'REQUIRED_COLUMNS',
      'REQUIRED_INDEX_TARGETS',
      'order_date',
      'customer_id',
      'product_id',
      'test_schema_idempotent',
      'daily_sales_summary',
      'sale_date',
      'total_orders',
      'total_revenue',
      'avg_order_value',
      'Sentinel Customer',
      'destroyed existing',
    ]) {
      assert.ok(testSrc.includes(needle), `schema tests missing: ${needle}`);
    }
    assert.match(
      testSrc,
      /\(\s*["']orders["']\s*,\s*["']order_date["']\s*\)/,
    );
    assert.match(
      testSrc,
      /\(\s*["']orders["']\s*,\s*["']customer_id["']\s*\)/,
    );
    assert.match(
      testSrc,
      /\(\s*["']order_items["']\s*,\s*["']product_id["']\s*\)/,
    );

    const reportTests = await readFile(
      path.join(FIXTURES, 'sqlite-ecommerce-reports', 'tests/test_reports.py'),
      'utf8',
    );
    assert.match(reportTests, /assertEqual\(len\(rows\), 50\)/);
    assert.match(reportTests, /101,\s*105,\s*112/);
    assert.match(reportTests, /45 \* 2500/);
  });

  it('TypeScript migration allows only required source and config edits', async () => {
    const { loadTask } = await import('../harness/load.js');
    const task = await loadTask(
      path.join(TASKS_ROOT, 'brownfield', '008-js-to-ts-migration.yaml'),
    );
    const gate = task.eligibilityGates.find((item) => item.gate === 'baseline-diff');
    const allow = gate?.baselineDiffPolicy?.allow;
    assert.ok(Array.isArray(allow));
    assert.ok(allow.includes('package.json'));
    assert.ok(allow.includes('tsconfig.json'));
    for (const stem of ['array-utils', 'async-utils', 'index', 'object-utils', 'string-utils']) {
      assert.ok(allow.includes(`src/${stem}.js`));
      assert.ok(allow.includes(`src/${stem}.ts`));
    }
    assert.equal(allow.some((entry) => entry.startsWith('test/')), false);
  });
});
