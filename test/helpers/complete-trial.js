/**
 * Complete trial result / manifest row builders for strict schema tests.
 * Production write/load/verify require the full required field set.
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
 * writeTrialResult with a complete required-field payload.
 *
 * @param {string} campaignDir
 * @param {string} trialId
 * @param {object} [partial] - trial fields; may include skipManifestTrial:true
 * @param {{ manifestTrial?: object | null }} [opts]
 */
export async function writeCompleteTrial(
  campaignDir,
  trialId,
  partial = {},
  opts = {},
) {
  const { writeTrialResult } = await import('../../harness/results.js');
  const { skipManifestTrial, ...fields } = partial;
  const payload = completeTrialResult({ ...fields, id: trialId });
  /** @type {{ manifestTrial?: object }} */
  const writeOpts = { ...opts };
  if (skipManifestTrial === true) {
    // Explicit opt-out for tests that exercise write without frozen row.
    delete writeOpts.manifestTrial;
  } else if (writeOpts.manifestTrial == null) {
    writeOpts.manifestTrial = completeManifestTrial({
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
  return writeTrialResult(campaignDir, trialId, payload, writeOpts);
}
