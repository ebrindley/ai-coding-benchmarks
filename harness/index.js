/**
 * Public harness surface for programmatic use.
 */

export {
  SCHEMA_VERSION,
  INVOCATION_PATHS,
  TRIAL_STATUSES,
  CLASSIFICATIONS,
  CLASSIFICATION_PRECEDENCE,
} from './contracts.js';

export {
  canonicalize,
  canonicalJsonString,
  sha256Buffer,
  sha256File,
  sha256Json,
  digestArtifactDir,
  digestHarnessContent,
  collectDirEntries,
} from './digest.js';

export { computePostureFingerprint } from './posture.js';
export { preflight, selfValidate } from './preflight.js';
export { runCampaign } from './run.js';
export { parseArgs, main as cliMain } from './cli.js';

export { loadSuite, loadTask, loadCorpusTasks } from './load.js';
export { expandExperiment, nextTrial } from './schedule.js';
export {
  createManifest,
  loadManifest,
  saveManifest,
  updateTrial,
  validateManifest,
  listResumableTrials,
  computeCampaignInputDigests,
  compareInputDigests,
} from './manifest.js';
export {
  acquireLock,
  releaseLock,
  readLock,
  isPidAlive,
  canRecoverDeadLock,
  lockPath,
  lockRecoverPath,
  DEAD_LOCK_MIN_AGE_MS,
  LOCK_FILENAME,
  LOCK_RECOVER_FILENAME,
} from './lock.js';
export {
  assertInsideRoot,
  resolveUnder,
  assertSafeIdSegment,
  assertSafeTrialId,
  assertSafeCampaignId,
  trialPathUnder,
  PathEscapeError,
  SAFE_ID_SEGMENT_RE,
  SAFE_TRIAL_ID_RE,
} from './paths.js';
export { exportSanitizedBundle } from './export.js';
export { buildReport, formatHumanSummary, assertHomogeneous } from './summary.js';
export { classifyTrial } from './classify.js';
export {
  detectConfinement,
  runGates,
  buildGateEnv,
  buildSeatbeltProfile,
  buildConfinedArgv,
  countMeaningfulChangedFiles,
  filterMeaningfulChangedPaths,
  parseChangedPaths,
  escapeSeatbeltPath,
  evaluateRequirements,
  evaluateOracleGate,
  buildOracleCommand,
  resolveCommandlessOraclePath,
  resolveItemEvidenceGateName,
  sanitizeGateResultsForStorage,
  isRestrictiveSandboxMode,
  normalizeEnvAllowlist,
  isCredentialLikeEnvKey,
} from './gates.js';
export { trialBranchName, initWorkspaceGit, copyFixtureTree } from './workspace.js';
export {
  ensurePrivateDir,
  writePrivateFile,
  writeTrialResult,
  quarantineRawOutput,
} from './results.js';
export {
  getInvoker,
  buildInvocationRequest,
  parseResolvedModelEvidence,
  parseInvokeResult,
  POETIC_INVOKE_REQUEST_SCHEMA,
  POETIC_INVOKE_RESULT_SCHEMA,
  POETIC_OUTCOME_KINDS,
  PROMPT_TRANSPORTS,
} from './invokers/index.js';
