#!/usr/bin/env node
// Check that no test files have been modified.
//
// Mirrors the Python check_no_test_edits.py convention used elsewhere in this
// suite: JSON on stdout for machine parsing, a grep-able error ID on stderr,
// and meaningful exit codes.
//
// Exit codes:
//     0:  PASS - No test files modified
//     10: FAIL_TEST_FILES_MODIFIED - Test files were modified
//     11: FAIL_GIT_ERROR - Could not determine modified files
//
// Error IDs (grep-able):
//     PASS_NO_TEST_EDITS
//     FAIL_TEST_FILES_MODIFIED
//     FAIL_GIT_ERROR

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TEST_DIRS = ['tests', 'test', '__tests__'];

function isTestFile(filepath) {
  const parts = filepath.split('/');
  if (parts.some((part) => TEST_DIRS.includes(part))) return true;
  const name = parts[parts.length - 1];
  return name.endsWith('.test.ts') || name.endsWith('.spec.ts');
}

function getModifiedFiles() {
  const run = (args) =>
    execFileSync('git', args, { cwd: fixtureDir, encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

  const staged = run(['diff', '--cached', '--name-only', '--', fixtureDir]);
  const unstaged = run(['diff', '--name-only', '--', fixtureDir]);
  return [...new Set([...staged, ...unstaged])];
}

function emit(result) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.stderr.write(`[${result.error_id}] ${result.message}\n`);
}

function main() {
  let modifiedFiles;
  try {
    modifiedFiles = getModifiedFiles();
  } catch {
    emit({
      check: 'no_test_edits',
      error_id: 'FAIL_GIT_ERROR',
      exit_code: 11,
      passed: false,
      modified_test_files: [],
      total_modified_files: 0,
      message: 'Could not determine modified files via git',
    });
    return 11;
  }

  const modifiedTestFiles = modifiedFiles.filter(isTestFile);
  const passed = modifiedTestFiles.length === 0;

  emit({
    check: 'no_test_edits',
    error_id: passed ? 'PASS_NO_TEST_EDITS' : 'FAIL_TEST_FILES_MODIFIED',
    exit_code: passed ? 0 : 10,
    passed,
    modified_test_files: modifiedTestFiles,
    total_modified_files: modifiedFiles.length,
    message: passed
      ? 'No test files modified - bug-fix constraint satisfied'
      : `${modifiedTestFiles.length} test file(s) modified - constraint violated: ${modifiedTestFiles.join(', ')}`,
  });

  return passed ? 0 : 10;
}

process.exit(main());
