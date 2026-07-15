/**
 * Build a complete poetic.provider.invoke.result.v1 object matching
 * ProviderInvokeResultV1 (poetic types.ts). For harness tests/fakes.
 */

/**
 * @template T
 * @param {T} value
 */
export function available(value) {
  return { availability: 'available', value };
}

/**
 * @param {string} [reason]
 */
export function unavailable(reason) {
  return reason != null
    ? { availability: 'unavailable', reason }
    : { availability: 'unavailable' };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.requestId]
 * @param {string} [opts.provider]
 * @param {string | null} [opts.requestedModel] request-side model string or null
 * @param {string | null} [opts.resolvedModel]
 * @param {string} [opts.outcomeKind]
 * @param {string} [opts.reasonCode]
 * @param {number | null} [opts.exitCode]
 * @param {string} [opts.outputPath]
 * @param {Record<string, unknown>} [opts.overrides] deep-ish top-level overrides
 * @returns {Record<string, unknown>}
 */
export function buildValidInvokeResultV1(opts = {}) {
  const requestId = opts.requestId ?? 'req-1';
  const provider = opts.provider ?? 'fake';
  const requestedModel =
    opts.requestedModel === undefined ? null : opts.requestedModel;
  const resolvedModel =
    opts.resolvedModel === undefined
      ? requestedModel
      : opts.resolvedModel;
  const outcomeKind = opts.outcomeKind ?? 'success';
  const reasonCode =
    opts.reasonCode ??
    (outcomeKind === 'success'
      ? 'SUCCESS'
      : outcomeKind === 'timeout'
        ? 'PROVIDER_TIMEOUT'
        : outcomeKind === 'refusal'
          ? 'PROVIDER_ERROR'
          : outcomeKind === 'aborted'
            ? 'PROVIDER_ABORTED'
            : outcomeKind === 'internal_error'
              ? 'INTERNAL_ERROR'
              : 'PROVIDER_ERROR');
  const exitCode =
    opts.exitCode !== undefined
      ? opts.exitCode
      : outcomeKind === 'success'
        ? 0
        : 1;
  const outputPath = opts.outputPath ?? '/tmp/out/output.json';
  const quarantineDir =
    opts.quarantineDir ??
    '/tmp/out/output.invoke-artifacts/' + requestId;
  const now = '2026-07-15T12:00:00.000Z';
  const end = '2026-07-15T12:00:01.000Z';

  /** @type {Record<string, unknown>} */
  const result = {
    schema: 'poetic.provider.invoke.result.v1',
    requestId,
    outcome: {
      kind: outcomeKind,
      exitCode,
      reasonCode,
    },
    provider: {
      requested: available(provider),
      resolved: available(provider),
    },
    model: {
      requested:
        requestedModel != null
          ? available(requestedModel)
          : unavailable('no model requested'),
      resolved:
        resolvedModel != null
          ? available(resolvedModel)
          : unavailable('model not resolved by runner'),
      resolutionSource:
        resolvedModel != null ? 'provider-result' : 'unavailable',
    },
    versions: {
      poetic: available('0.0.0-test'),
      providerCli: unavailable('provider CLI version not probed'),
    },
    posture: {
      fingerprint: available('a'.repeat(64)),
      argvRedacted: available(['provider', 'invoke']),
      commandPath: unavailable('command path not reported'),
      sourceClasses: ['native-provider', 'cli'],
      workspaceMode: unavailable('workspace mode not reported'),
    },
    stateIsolation: 'unsupported',
    attempts: [
      {
        attempt: 1,
        startedAt: now,
        endedAt: end,
        durationMs: 1000,
        exitCode,
      },
    ],
    timing: {
      startedAt: now,
      endedAt: end,
      durationMs: 1000,
    },
    process: {
      exitCode,
      transportStatus: unavailable('transport status not reported'),
    },
    cleanup: {
      status: 'not-needed',
      notes: ['provider invoke does not register runs or manage worktrees'],
    },
    diagnostics: unavailable('no structured diagnostics'),
    usage: unavailable('usage not reported by provider'),
    cost: unavailable('cost not reported by provider'),
    artifacts: {
      result: outputPath,
      quarantineDir,
      stdout: quarantineDir + '/stdout.txt',
      stderr: quarantineDir + '/stderr.txt',
    },
  };

  if (opts.overrides && typeof opts.overrides === 'object') {
    return { ...result, ...opts.overrides };
  }
  return result;
}

/**
 * CommonJS helper source for fake poetic scripts. Defines writeFullV1(req, out, opts).
 * Embed in fake scripts after requiring fs/path.
 */
export const FAKE_POETIC_WRITE_FULL_V1_CJS = `
function writeFullV1(req, out, opts) {
  opts = opts || {};
  var fs = require('fs');
  var path = require('path');
  var avail = function (v) { return { availability: 'available', value: v }; };
  var unavail = function (r) { return r != null ? { availability: 'unavailable', reason: r } : { availability: 'unavailable' }; };
  var requestId = opts.requestId != null ? opts.requestId : req.requestId;
  var providerName = opts.provider != null ? opts.provider : req.provider;
  var requestedModel = opts.requestedModel !== undefined
    ? opts.requestedModel
    : (req.model != null && String(req.model).trim() !== '' ? String(req.model) : null);
  if (opts.forceRequestedModel !== undefined) requestedModel = opts.forceRequestedModel;
  var resolvedModel = opts.resolvedModel !== undefined ? opts.resolvedModel : requestedModel;
  var kind = opts.outcomeKind || 'success';
  var reasonCode = opts.reasonCode || (kind === 'success' ? 'SUCCESS' : kind === 'timeout' ? 'PROVIDER_TIMEOUT' : kind === 'aborted' ? 'PROVIDER_ABORTED' : kind === 'internal_error' ? 'INTERNAL_ERROR' : 'PROVIDER_ERROR');
  var exitCode = opts.exitCode !== undefined ? opts.exitCode : (kind === 'success' ? 0 : 1);
  var base = path.basename(path.resolve(out));
  var stem = base.toLowerCase().endsWith('.json') ? base.slice(0, -5) : base;
  var qDir = path.join(path.dirname(path.resolve(out)), stem + '.invoke-artifacts', requestId);
  if (opts.writeRaw !== false) {
    fs.mkdirSync(qDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(qDir, 'stdout.txt'), opts.stdout != null ? opts.stdout : '');
    fs.writeFileSync(path.join(qDir, 'stderr.txt'), opts.stderr != null ? opts.stderr : '');
  }
  var now = new Date().toISOString();
  var resultObj = {
    schema: 'poetic.provider.invoke.result.v1',
    requestId: requestId,
    outcome: { kind: kind, exitCode: exitCode, reasonCode: reasonCode },
    provider: { requested: avail(providerName), resolved: avail(providerName) },
    model: {
      requested: requestedModel != null ? avail(requestedModel) : unavail('no model requested'),
      resolved: resolvedModel != null ? avail(resolvedModel) : unavail('model not resolved'),
      resolutionSource: resolvedModel != null ? 'provider-result' : 'unavailable'
    },
    versions: { poetic: avail('0.0.0-test'), providerCli: unavail('not probed') },
    posture: {
      fingerprint: avail('${'a'.repeat(64)}'),
      argvRedacted: avail(['provider', 'invoke']),
      commandPath: unavail('n/a'),
      sourceClasses: ['native-provider', 'cli'],
      workspaceMode: unavail('n/a')
    },
    stateIsolation: 'unsupported',
    attempts: [{ attempt: 1, startedAt: now, endedAt: now, durationMs: 1, exitCode: exitCode }],
    timing: { startedAt: now, endedAt: now, durationMs: 1 },
    process: { exitCode: exitCode, transportStatus: unavail('n/a') },
    cleanup: { status: 'not-needed' },
    diagnostics: unavail('n/a'),
    usage: unavail('n/a'),
    cost: unavail('n/a'),
    artifacts: {
      result: path.resolve(out),
      quarantineDir: qDir,
      stdout: path.join(qDir, 'stdout.txt'),
      stderr: path.join(qDir, 'stderr.txt')
    }
  };
  fs.writeFileSync(out, JSON.stringify(resultObj));
}
`;
