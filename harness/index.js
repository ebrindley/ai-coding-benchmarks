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
} from './digest.js';

export { computePostureFingerprint } from './posture.js';
export { preflight, selfValidate } from './preflight.js';
export { runCampaign } from './run.js';
export { parseArgs, main as cliMain } from './cli.js';

export { loadSuite, loadTask, loadCorpusTasks } from './load.js';
export { expandExperiment, nextTrial } from './schedule.js';
export { createManifest, loadManifest, saveManifest, updateTrial } from './manifest.js';
export { exportSanitizedBundle } from './export.js';
export { buildReport, formatHumanSummary, assertHomogeneous } from './summary.js';
export { classifyTrial } from './classify.js';
export {
  detectConfinement,
  runGates,
  buildSeatbeltProfile,
  buildConfinedArgv,
  countMeaningfulChangedFiles,
  filterMeaningfulChangedPaths,
  parseChangedPaths,
  escapeSeatbeltPath,
  evaluateRequirements,
} from './gates.js';
export { trialBranchName, initWorkspaceGit } from './workspace.js';
export {
  getInvoker,
  buildInvocationRequest,
  parseResolvedModelEvidence,
  POETIC_INVOKE_REQUEST_SCHEMA,
} from './invokers/index.js';
