#!/usr/bin/env node

/**
 * Oracle Test: Consumer Import Validation
 *
 * Validates that the migrated package can be imported by a consumer
 * and exports the expected API. This catches latent bugs like:
 * - package.json#main pointing to non-existent file
 * - Missing exports after migration
 * - Broken module resolution
 *
 * Usage:
 *   WORKSPACE_DIR=/path/to/workspace node check-consumer-import.js
 *
 * Exit codes:
 *   0 - All checks passed
 *   1 - Import validation failed
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Recursively collect all `.ts` files under a directory, returning paths
 * relative to the workspace. Done in Node so the compile step never relies on
 * shell glob expansion (which silently fails when `src/**` is passed verbatim
 * to a non-globbing shell).
 */
function collectTsFiles(dir, workspaceDir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full, workspaceDir));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.ts')) {
      out.push(path.relative(workspaceDir, full));
    }
  }
  return out;
}

const workspaceDir = process.env.WORKSPACE_DIR;
if (!workspaceDir) {
  console.error('ERROR: WORKSPACE_DIR environment variable not set');
  process.exit(1);
}

if (!fs.existsSync(workspaceDir)) {
  console.error(`ERROR: Workspace directory not found: ${workspaceDir}`);
  process.exit(1);
}

console.log('Oracle Test: Consumer Import Validation');
console.log(`Workspace: ${workspaceDir}`);
console.log('');

// Read package.json
const pkgPath = path.join(workspaceDir, 'package.json');
if (!fs.existsSync(pkgPath)) {
  console.error('ERROR: package.json not found in workspace');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
console.log(`Package: ${pkg.name || 'unnamed'}`);

const expectedExports = [
  'capitalize',
  'kebabCase',
  'unique',
  'chunk',
  'pick',
  'isPlainObject',
  'withTimeout',
  'delay',
];

// Check main field exists
if (!pkg.main && !pkg.exports) {
  console.error('ERROR: package.json has neither "main" nor "exports" field');
  console.error('  Consumer cannot import this package');
  process.exit(1);
}

// Validate main field points to existing file
let mainPath;
if (pkg.main) {
  mainPath = path.join(workspaceDir, pkg.main);
  if (!fs.existsSync(mainPath)) {
    console.error(`ERROR: package.json "main" points to non-existent file: ${pkg.main}`);
    console.error(`  Expected file at: ${mainPath}`);
    process.exit(1);
  }
  console.log(`✓ main field exists: ${pkg.main}`);
} else {
  console.log('✓ package.json uses exports field');
}

// Try to import the module
console.log('');
console.log('Testing consumer import...');

try {
  let importUrl;

  if (pkg.main) {
    const ext = path.extname(pkg.main).toLowerCase();

    // If main is TypeScript, compile sources to a throwaway JS output directory for a realistic consumer import.
    if (ext === '.ts') {
      const outDir = path.join(workspaceDir, '.oracle-dist');
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir, { recursive: true });

      // Compile all TS files under src/ (matches the fixture structure) without
      // relying on tsconfig noEmit. Files are collected in Node and passed as an
      // explicit argv array so we never depend on shell glob expansion (which
      // produced a TS6053 "File 'src/**/*.ts' not found" failure) or on a login
      // shell sourcing the host profile.
      const srcDir = path.join(workspaceDir, 'src');
      const tsFiles = fs.existsSync(srcDir) ? collectTsFiles(srcDir, workspaceDir) : [];
      if (tsFiles.length === 0) {
        console.error('ERROR: No .ts files found under src/ to compile');
        process.exit(1);
      }

      // Prefer the workspace-local tsc installed by the `install` gate
      // (typescript is a pinned devDependency) so the oracle compiles with the
      // same compiler version the task targets, rather than whatever `npx`
      // would fetch from the network.
      const localTsc = path.join(
        workspaceDir,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'tsc.cmd' : 'tsc'
      );
      const tscBin = fs.existsSync(localTsc) ? localTsc : 'npx';
      const tscArgs = [
        ...(tscBin === 'npx' ? ['tsc'] : []),
        '--target',
        'ES2022',
        '--module',
        'ESNext',
        '--moduleResolution',
        'node',
        '--outDir',
        '.oracle-dist',
        '--rootDir',
        'src',
        ...tsFiles,
      ];

      const compile = spawnSync(tscBin, tscArgs, { cwd: workspaceDir, stdio: 'inherit' });
      if (compile.status !== 0) {
        console.error('ERROR: Failed to compile TypeScript for consumer import test');
        process.exit(1);
      }

      // Map src/index.ts -> .oracle-dist/index.js
      const rel = path.relative(path.join(workspaceDir, 'src'), mainPath).replace(/\.ts$/i, '.js');
      const compiledMainPath = path.join(outDir, rel);
      if (!fs.existsSync(compiledMainPath)) {
        console.error('ERROR: Compiled main file not found');
        console.error(`  Expected: ${compiledMainPath}`);
        process.exit(1);
      }

      importUrl = pathToFileURL(compiledMainPath).href;
    } else {
      importUrl = pathToFileURL(mainPath).href;
    }
  } else {
    console.error('ERROR: Oracle currently requires package.json#main for this fixture');
    process.exit(1);
  }

  const imported = await import(importUrl);

  const missingExports = [];
  for (const exportName of expectedExports) {
    if (!(exportName in imported)) {
      missingExports.push(exportName);
    }
  }

  if (missingExports.length > 0) {
    console.error(`ERROR: Missing expected exports: ${missingExports.join(', ')}`);
    console.error('  Consumer code expecting these functions will break');
    process.exit(1);
  }

  console.log('✓ Module imports successfully');
  console.log(`✓ All expected exports present: ${expectedExports.join(', ')}`);

  // Smoke test: verify functions are callable
  if (typeof imported.capitalize !== 'function') {
    console.error('ERROR: capitalize export is not a function');
    process.exit(1);
  }

  const testResult = imported.capitalize('hello');
  if (testResult !== 'Hello') {
    console.error(`ERROR: capitalize('hello') returned '${testResult}', expected 'Hello'`);
    console.error('  Basic functionality appears broken after migration');
    process.exit(1);
  }

  console.log('✓ Basic functionality smoke test passed');
} catch (err) {
  console.error('ERROR: Failed to import module as consumer would');
  console.error(`  ${err?.message ?? String(err)}`);
  if (err?.stack) {
    console.error('');
    console.error('Stack trace:');
    console.error(err.stack);
  }
  process.exit(1);
}

console.log('');
console.log('✓ Consumer import validation PASSED');
console.log('  Package can be successfully imported and used by consumers');
process.exit(0);
