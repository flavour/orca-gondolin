import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRuntime, runtimeStatus, unpackRuntime } from '../src/runtime.mjs';

function archive(extra = [], marker = 'first') {
  const files = [
    ['package.json', JSON.stringify({ type: 'module' })],
    ['src/adapter.mjs', `console.log(JSON.stringify({marker: ${JSON.stringify(marker)}, args: process.argv.slice(2), nodeMode: process.env.ELECTRON_RUN_AS_NODE}));`],
    ['src/daemon.mjs', '// test owner'],
    ['node_modules/@earendil-works/gondolin/package.json', '{"name":"@earendil-works/gondolin"}'],
    ...extra,
  ].map(([path, data]) => ({ path, content: Buffer.from(data).toString('base64') }));
  return gzipSync(JSON.stringify({ schemaVersion: 1, files }));
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'og-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plugin = join(directory, 'relocated-plugin');
  await mkdir(plugin);
  const bundlePath = join(plugin, 'runtime.json.gz');
  await writeFile(bundlePath, archive());
  const home = join(directory, "home with spaces and 'quotes'");
  const root = join(home, '.local/share/orca-gondolin');
  return { directory, plugin, bundlePath, home, root, options: { home, bundlePath }, launcher: join(root, 'bin/orca-gondolin') };
}

const exec = promisify(execFile);
test('prepares offline, preserves config and runs without Node/npm on PATH or plugin files', async (t) => {
  const { options, root, plugin, launcher, directory } = await fixture(t);
  assert.equal((await runtimeStatus(options)).ready, false);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'config.json'), '{"image":"keep:me"}');
  assert.equal((await prepareRuntime(options)).ready, true);
  assert.equal((await runtimeStatus(options)).ready, true);
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), '{"image":"keep:me"}');
  await rm(plugin, { recursive: true }); // Neither install location nor source tree needed after preparation.
  const { stdout } = await exec(launcher, ['create', "argument with 'quotes'"], {
    cwd: directory, env: { PATH: '/no-node-or-npm-here' },
  });
  assert.deepEqual(JSON.parse(stdout), { marker: 'first', args: ['create', "argument with 'quotes'"], nodeMode: '1' });
});

test('repeated/concurrent preparation is safe; upgrades retain old runtime directories', async (t) => {
  const { options, root, bundlePath, launcher } = await fixture(t);
  await Promise.all([prepareRuntime(options), prepareRuntime(options)]);
  const first = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'));
  await prepareRuntime(options);
  assert.deepEqual(await readdir(join(root, 'runtimes')), [first.id]);
  await writeFile(bundlePath, archive([], 'second'));
  assert.equal((await runtimeStatus(options)).ready, false);
  assert.equal((await prepareRuntime(options)).ready, true);
  const second = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'));
  assert.notEqual(second.id, first.id);
  await access(join(root, 'runtimes', first.id, 'src/adapter.mjs'));
  assert.equal(JSON.parse((await exec(launcher)).stdout).marker, 'second');
  assert.equal((await readdir(join(root, 'runtimes'))).length, 2);
});

test('unsafe archives fail before replacing a working runtime', async (t) => {
  const { options, root, bundlePath, launcher } = await fixture(t);
  await prepareRuntime(options);
  const previous = await readFile(launcher, 'utf8');
  for (const path of ['../outside', '/absolute', 'src/../../outside', 'src\\escape', 'src/./bad', 'src/adapter.mjs', 'SRC/ADAPTER.MJS']) {
    const bytes = archive([[path, 'bad']]);
    assert.throws(() => unpackRuntime(bytes), /Unsafe/);
  }
  await writeFile(bundlePath, archive([['../outside', 'bad']]));
  await assert.rejects(prepareRuntime(options), /Unsafe/);
  assert.equal(await readFile(launcher, 'utf8'), previous);
  assert.equal((await readdir(join(root, 'runtimes'))).length, 1);
});

test('unprepared recipe explains the UI setup step instead of invoking npm', async (t) => {
  const { home } = await fixture(t);
  const recipe = JSON.parse(await readFile(new URL('../recipes/gondolin.json', import.meta.url), 'utf8'));
  for (const mode of ['create', 'destroy']) {
    await assert.rejects(exec('/bin/sh', ['-c', recipe[mode]], {
      env: { HOME: home, PATH: '/no-node-or-npm-here' },
    }), (error) => {
      assert.match(error.stderr, /Open Gondolin Settings and click Prepare Runtime/);
      assert.equal(error.code, 1);
      return true;
    });
  }
});
