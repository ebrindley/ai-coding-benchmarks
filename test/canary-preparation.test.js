import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const pin = '9eef589959858af368b168e674685ef597468fa1';
const taskId = 'brownfield-008-js-to-ts-migration';

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aicb-canary-test-'));
  const fixture = 'benchmarks/cli-comparison/fixtures/example';
  const taskFile = 'benchmarks/cli-comparison/tasks/example.yaml';
  const put = (name, content, mode) => {
    const dest = path.join(root, name);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, content, mode ? { mode } : undefined);
  };
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Canary Test');
  git('config', 'user.email', 'canary@example.invalid');
  put('.gitignore', 'canary/workspaces/\ncanary/.config/\n');
  put(`${fixture}/.gitignore`, 'node_modules/\ndist/\n');
  put(`${fixture}/src.js`, 'export const value = "pinned";\n');
  put(taskFile, 'taskId: pinned\n');
  git('add', '.gitignore', fixture, taskFile);
  git('commit', '--quiet', '-m', 'Prepare synthetic pin');
  const sha = git('rev-parse', 'HEAD');
  for (const script of ['prepare-workspaces.sh', 'preflight.sh']) {
    put(`canary/scripts/${script}`, readFileSync(path.join(repo, 'canary/scripts', script), 'utf8')
      .replaceAll(pin, sha), 0o755);
  }
  put('canary/config/tasks.json', JSON.stringify({ tasks: [{ taskId, taskFile, fixture }] }));
  put('canary/config/models.json', JSON.stringify({ models: [{ identifier: 'dummy', indexedModelIdentifier: 'dummy-model' }] }));
  put('canary/config/opencode.json', '{}\n');
  for (const command of ['curl', 'build', 'npm', 'go', 'mvn']) put(`bin/${command}`, '#!/bin/sh\nexit 0\n', 0o755);
  put('bin/lms', '#!/bin/sh\nprintf \'[{"identifier":"dummy","indexedModelIdentifier":"dummy-model"}]\\n\'\n', 0o755);
  put('bin/opencode', '#!/bin/sh\n[ "$XDG_CONFIG_HOME" = "$EXPECTED_CONFIG_HOME" ] || exit 91\nprintf "lmstudio/dummy\\n"\n', 0o755);
  const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`,
    GIT_AUTHOR_NAME: 'Canary Test', GIT_AUTHOR_EMAIL: 'canary@example.invalid',
    GIT_COMMITTER_NAME: 'Canary Test', GIT_COMMITTER_EMAIL: 'canary@example.invalid',
    XDG_CONFIG_HOME: `${root}/parent-config`, EXPECTED_CONFIG_HOME: `${root}/canary/.config` };
  const run = (script) => spawnSync('bash', [`${root}/canary/scripts/${script}`], { env, encoding: 'utf8' });
  const prepare = () => {
    const result = run('prepare-workspaces.sh');
    assert.equal(result.status, 0, result.stderr);
  };
  const workspace = `${root}/canary/workspaces/${taskId}`;
  const commitWorkspace = () => {
    execFileSync('git', ['-C', workspace, 'add', '.'], { env });
    execFileSync('git', ['-C', workspace, 'commit', '--quiet', '-m', 'Test changed prepared bytes'], { env });
  };
  return { root, fixture, taskFile, put, run, prepare, workspace, commitWorkspace };
}

test('canary preparation reads the pin instead of current fixture and task bytes', () => {
  const ctx = setup();
  ctx.put(`${ctx.fixture}/src.js`, 'current checkout\n');
  ctx.put(ctx.taskFile, 'taskId: current\n');
  ctx.prepare();
  assert.equal(readFileSync(`${ctx.workspace}/src.js`, 'utf8'), 'export const value = "pinned";\n');
  assert.equal(readFileSync(`${ctx.workspace}/.canary/task.yaml`, 'utf8'), 'taskId: pinned\n');
  const result = ctx.run('preflight.sh');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /corpus or harness differs/);
});

test('canary preflight allows ignored artifacts and scopes OpenCode config to its probe', () => {
  const ctx = setup();
  ctx.prepare();
  ctx.put(`canary/workspaces/${taskId}/node_modules/dummy/index.js`, 'dummy dependency\n');
  ctx.put(`canary/workspaces/${taskId}/dist/generated.js`, 'dummy build\n');
  const result = ctx.run('preflight.sh');
  assert.ok([0, 2].includes(result.status), result.stderr);
  assert.match(result.stdout, /corpus, workspaces, model identities, and OpenCode routing are valid/);
});

test('canary preflight rejects committed fixture edits even with a truthful SHA stamp', () => {
  const ctx = setup();
  ctx.prepare();
  ctx.put(`canary/workspaces/${taskId}/src.js`, 'changed fixture\n');
  ctx.commitWorkspace();
  const result = ctx.run('preflight.sh');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /prepared workspace differs.*src\.js/);
});

test('canary preflight rejects committed task edits and extra meaningful files', () => {
  for (const name of ['.canary/task.yaml', 'extra.js']) {
    const ctx = setup();
    ctx.prepare();
    ctx.put(`canary/workspaces/${taskId}/${name}`, 'changed bytes\n');
    ctx.commitWorkspace();
    const result = ctx.run('preflight.sh');
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(name), result.stderr);
  }
});
