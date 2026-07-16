/**
 * Complete trial result / manifest row builders for strict schema tests.
 * Production write/load/verify require the full required field set and a
 * complete frozen manifestTrial on every write/verify boundary.
 */

/**
 * @param {object} [overrides]
 * @returns {object}
 */
export function completeManifestTrial(overrides = {}) {
  return {
    id: 't1',
    experimentId: 'exp-1',
    arm: 'fake',
    provider: 'fake',
    taskId: 'task-1',
    repetition: 1,
    scheduleSeed: 1,
    invocationPath: 'native-cli',
    requestedModel: 'm',
    postureFingerprint: null,
    state: 'completed',
    ...overrides,
  };
}

/**
 * Full writeTrialResult payload (before write stamps writtenAt/resultDigest).
 * @param {object} [overrides]
 * @returns {object}
 */
export function completeTrialResult(overrides = {}) {
  const id = overrides.id != null ? String(overrides.id) : 't1';
  return {
    id,
    experimentId: 'exp-1',
    arm: 'fake',
    provider: 'fake',
    taskId: 'task-1',
    repetition: 1,
    scheduleSeed: 1,
    invocationPath: 'native-cli',
    requestedModel: 'm',
    resolvedModel: null,
    resolvedModelAvailable: false,
    resolvedModelSource: 'unavailable',
    postureFingerprint: null,
    state: 'completed',
    classification: 'PASS',
    digests: {},
    ...overrides,
    id, // force destination id last
  };
}

/**
 * Build the default frozen identity row that matches a complete payload.
 * @param {object} payload
 * @param {string} trialId
 * @returns {object}
 */
export function frozenFromPayload(payload, trialId) {
  return completeManifestTrial({
    id: trialId,
    experimentId: payload.experimentId,
    arm: payload.arm,
    provider: payload.provider,
    taskId: payload.taskId,
    repetition: payload.repetition,
    scheduleSeed: payload.scheduleSeed,
    invocationPath: payload.invocationPath,
    requestedModel: payload.requestedModel,
    postureFingerprint: payload.postureFingerprint,
    state: payload.state,
  });
}

/**
 * writeTrialResult with a complete required-field payload and frozen row.
 *
 * @param {string} campaignDir
 * @param {string} trialId
 * @param {object} [partial]
 * @param {{ manifestTrial?: object }} [opts]
 * @returns {Promise<{ path: string, result: object, manifestTrial: object }>}
 */
export async function writeCompleteTrial(
  campaignDir,
  trialId,
  partial = {},
  opts = {},
) {
  const { writeTrialResult } = await import('../../harness/results.js');
  const payload = completeTrialResult({ ...partial, id: trialId });
  const manifestTrial =
    opts.manifestTrial != null
      ? opts.manifestTrial
      : frozenFromPayload(payload, trialId);
  const written = await writeTrialResult(campaignDir, trialId, payload, {
    manifestTrial,
  });
  return { ...written, manifestTrial };
}
