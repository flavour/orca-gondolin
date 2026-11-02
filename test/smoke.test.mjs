import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../src/repository.mjs';
import { paths } from '../src/adapter.mjs';
import { saveConfig } from '../src/config.mjs';
import { prepareRuntime } from '../src/runtime.mjs';

const exec = promisify(execFile);
test('real Gondolin configured image → SSH pinned checkout → destroy', { skip: !process.env.GONDOLIN_SMOKE, timeout: 660_000 }, async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'orca-gondolin-smoke-'));
  const id = `orca-test-${randomUUID()}`;
  const home = join(repo, 'home');
  const locations = paths(id, home);
  const env = { ...process.env, HOME: home, ORCA_VM_INSTANCE_ID: id, ORCA_REPO_PATH: repo, ORCA_REPO_BRANCH: 'smoke/workspace' };
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { ensureImageSelector, getImageStoreDirectory } = await import('@earendil-works/gondolin');
  const image = await ensureImageSelector('alpine-base:latest');
  assert.ok(image.buildId);
  env.GONDOLIN_IMAGE_STORE = getImageStoreDirectory(); // Reuse assets without changing the user's config.
  env.GONDOLIN_DEFAULT_IMAGE = 'must-not-use-this-image:invalid';
  await saveConfig({ image: image.buildId }, join(home, '.local/share/orca-gondolin/config.json'));
  const prepared = await prepareRuntime({
    home,
    bundlePath: fileURLToPath(new URL('../dist/runtime.json.gz', import.meta.url)),
    nodePath: process.env.GONDOLIN_SMOKE_NODE ?? process.execPath,
  });
  assert.equal(prepared.ready, true);
  const launcher = join(home, '.local/share/orca-gondolin/bin/orca-gondolin');
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Test');
  await writeFile(join(repo, 'hello.txt'), 'hello gondolin\n');
  git(repo, 'add', 'hello.txt');
  git(repo, 'commit', '-m', 'smoke');
  env.ORCA_REPO_REF_HEAD = git(repo, 'rev-parse', 'HEAD');
  let result;
  try {
    const created = await exec(launcher, ['create'], { env, cwd: repo, timeout: 610_000 });
    result = JSON.parse(created.stdout);
    assert.equal(result.checkoutMode, 'provisioned-root');
    assert.equal(result.userData.image, image.buildId);
    const target = result.connection.target;
    const ssh = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'IdentitiesOnly=yes',
      '-i', target.identityFile, '-p', String(target.port), `${target.username}@${target.host}`];
    const response = await exec('ssh', [...ssh, 'cd /workspace/repo && git rev-parse HEAD && cat hello.txt && node --version'], { timeout: 30_000 });
    assert.match(response.stdout, new RegExp(env.ORCA_REPO_REF_HEAD));
    assert.match(response.stdout, /hello gondolin/);
  } catch (error) {
    try { console.error(await readFile(join(locations.directory, 'daemon.log'), 'utf8')); } catch {}
    throw error;
  } finally {
    if (result) {
      const payload = JSON.stringify({ schemaVersion: 1, mode: 'destroy', instanceId: id, recipeResult: result });
      const destroy = () => new Promise((resolve, reject) => {
        const child = execFile(launcher, ['destroy'], { env, cwd: repo, timeout: 65_000 }, (error) => error ? reject(error) : resolve());
        child.stdin.end(payload);
      });
      await destroy();
      await assert.rejects(readFile(join(locations.directory, 'result.json')), { code: 'ENOENT' });
      await assert.rejects(readFile(result.connection.target.identityFile), { code: 'ENOENT' });
      await destroy(); // Successful destruction is idempotent.
    }
  }
});
