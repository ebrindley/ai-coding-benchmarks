/**
 * Shared module contracts for the external benchmark harness.
 * Pure documentation of shapes — no runtime dependency on this file required.
 *
 * invocationPath (experiment arms): 'poetic-adapter' | 'native-cli' | 'poetic-system'
 * Trial classification precedence: TIMEOUT > INFRA_FAIL > NO_OP > FAIL > PASS
 */

export const SCHEMA_VERSION = 1;

export const INVOCATION_PATHS = Object.freeze([
  'poetic-adapter',
  'native-cli',
  'poetic-system',
]);

export const TRIAL_STATUSES = Object.freeze([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
]);

export const CLASSIFICATIONS = Object.freeze([
  'PASS',
  'FAIL',
  'NO_OP',
  'INFRA_FAIL',
  'TIMEOUT',
]);

/** Classification precedence: higher index wins when multiple signals apply. */
export const CLASSIFICATION_PRECEDENCE = Object.freeze({
  PASS: 0,
  FAIL: 1,
  NO_OP: 2,
  INFRA_FAIL: 3,
  TIMEOUT: 4,
});
