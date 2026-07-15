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
  digestRawOutputBytes,
  collectDirEntries,
  FIXTURE_SKIP_DIR_NAMES,
  isSkippedFixtureEntry,
  portableModeBits,
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
  readRecoveryGuard,
  isPidAlive,
  canRecoverDeadLock,
  canRecoverDeadGuard,
  lockPath,
  lockRecoverPath,
  DEAD_LOCK_MIN_AGE_MS,
  DEAD_GUARD_MIN_AGE_MS,
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
export {
  exportSanitizedBundle,
  redactHostIdentifying,
  stripPromptBearing,
  sanitizeExportReasonCode,
  isExportSafeReasonCode,
} from './export.js';
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
  isAllowlistedGateEnvName,
  isGateCfgEnvName,
  isSafeGateCfgValue,
  isBoundedIdentifier,
  sanitizeBoundedIdentifier,
  isExclusiveOraclePathEvidence,
  GATE_SAFE_ALLOWLIST_NAMES,
  GATE_CFG_NAME_RE,
  GATE_CFG_VALUE_RE,
  GATE_CFG_VALUE_MAX_LEN,
  BOUNDED_IDENTIFIER_RE,
} from './gates.js';
export { trialBranchName, initWorkspaceGit, copyFixtureTree } from './workspace.js';
export {
  ensurePrivateDir,
  writePrivateFile,
  writeTrialResult,
  quarantineRawOutput,
  computeRawOutputDigests,
  computeArtifactDigest,
  verifyTrialEvidenceDigests,
  verifyCampaignEvidenceDigests,
  buildTrialDigests,
  computeResultDigest,
  computeFinalResultDigest,
  buildFinalResultEnvelope,
  isInfraFailureWithoutRawEvidence,
  isUnavailableForReport,
} from './results.js';
export {
  getInvoker,
  buildInvocationRequest,
  parseResolvedModelEvidence,
  parseInvokeResult,
  sanitizeAdapterReasonCode,
  POETIC_INVOKE_REQUEST_SCHEMA,
  POETIC_INVOKE_RESULT_SCHEMA,
  POETIC_OUTCOME_KINDS,
  PROMPT_TRANSPORTS,
  detectProviderConfinement,
  buildProviderSeatbeltProfile,
  buildProviderConfinedArgv,
} from './invokers/index.js';
export {
  readFileNoFollow,
  readTextNoFollow,
  copyFileNoFollow,
  UnsafePathError,
} from './safe-fs.js';
