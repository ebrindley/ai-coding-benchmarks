const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const srcDir = path.join(__dirname, '..', 'src');
const jsFiles = fs.existsSync(srcDir) ? collectJsFiles(srcDir) : [];

if (jsFiles.length > 0) {
  console.error(
    `Migration incomplete: expected no .js files under src/, found ${jsFiles.length}:\n` +
      jsFiles.map((p) => `- ${path.relative(process.cwd(), p)}`).join('\n')
  );
  process.exit(1);
}

const tsconfigPath = path.join(__dirname, '..', 'tsconfig.json');
if (!fs.existsSync(tsconfigPath)) {
  console.error('Migration incomplete: expected tsconfig.json with strict mode enabled');
  process.exit(1);
}

try {
  const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
  if (tsconfig?.compilerOptions?.strict !== true) {
    console.error('Migration incomplete: tsconfig.json must set compilerOptions.strict=true');
    process.exit(1);
  }
} catch (err) {
  console.error(
    `Migration incomplete: failed to parse tsconfig.json (${err instanceof Error ? err.message : String(err)})`
  );
  process.exit(1);
}

const tscBin = path.join(
  __dirname,
  '..',
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc'
);
if (!fs.existsSync(tscBin)) {
  console.error('Missing local TypeScript compiler (node_modules/.bin/tsc)');
  process.exit(1);
}

const result = spawnSync(tscBin, ['--noEmit'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
