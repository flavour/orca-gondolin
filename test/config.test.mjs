import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_IMAGE, imageOptions, readConfig, saveConfig, validateConfig } from '../src/config.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'og-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, 'nested', 'config.json') };
}

test('unset configuration defaults to Alpine; saved selection reaches SDK options', async (t) => {
  const { file } = await fixture(t);
  assert.deepEqual(await readConfig(file), { image: DEFAULT_IMAGE });
  await saveConfig({ image: '  team/dev:stable  ' }, file);
  const snapshot = await readConfig(file);
  assert.deepEqual(imageOptions(snapshot), { sandbox: { imagePath: 'team/dev:stable' } });
  await saveConfig({ image: DEFAULT_IMAGE }, file);
  assert.equal(snapshot.image, 'team/dev:stable'); // An already-starting VM keeps its selection.
  assert.equal((await readConfig(file)).image, DEFAULT_IMAGE);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('validation rejects malformed input without replacing a good configuration', async (t) => {
  const { file } = await fixture(t);
  await saveConfig({ image: 'my-dev:latest' }, file);
  for (const image of ['', '../image', '/tmp/assets', 'x;touch-file', 'x\ny', 'x:', 'x//y', 'x'.repeat(257)]) {
    await assert.rejects(saveConfig({ image }, file));
  }
  for (const value of [null, [], {}, { image: 4 }, { image: 'valid', extra: true }]) {
    assert.throws(() => validateConfig(value));
  }
  assert.equal((await readConfig(file)).image, 'my-dev:latest');
  assert.equal(validateConfig({ image: '5a757d8e-a3f2-4e95-a265-4dca3b7ac13a' }).image, '5a757d8e-a3f2-4e95-a265-4dca3b7ac13a');
});

test('malformed configuration fails closed, rather than silently using another image', async (t) => {
  const { file } = await fixture(t);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, '{broken');
  await assert.rejects(readConfig(file), /Cannot read Gondolin configuration/);
  await writeFile(file, JSON.stringify({ image: '../escape' }));
  await assert.rejects(readConfig(file), /Cannot read Gondolin configuration/);
});

test('panel worker saves the same file read by the lifecycle adapter, across restarts', async (t) => {
  const { directory } = await fixture(t);
  const worker = pathToFileURL(join(process.cwd(), 'worker/main.mjs')).href;
  const config = pathToFileURL(join(process.cwd(), 'src/config.mjs')).href;
  const script = `
    import activate from ${JSON.stringify(worker)};
    import { readConfig, imageOptions } from ${JSON.stringify(config)};
    const handlers = new Map();
    activate({ panels: { handle: (name, handler) => handlers.set(name, handler) } });
    await handlers.get('config.save')({image: 'custom-dev:v1'});
    const loaded = await handlers.get('config.get')();
    console.log(JSON.stringify({loaded, options: imageOptions(await readConfig())}));
  `;
  const exec = promisify(execFile);
  const env = { ...process.env, HOME: directory };
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], { env });
  assert.deepEqual(JSON.parse(stdout), {
    loaded: { image: 'custom-dev:v1' }, options: { sandbox: { imagePath: 'custom-dev:v1' } },
  });
  const restarted = await exec(process.execPath, ['--input-type=module', '-e', `import {readConfig} from ${JSON.stringify(config)}; console.log(JSON.stringify(await readConfig()));`], { env });
  assert.equal(JSON.parse(restarted.stdout).image, 'custom-dev:v1');
  assert.equal(JSON.parse(await readFile(join(directory, '.local/share/orca-gondolin/config.json'), 'utf8')).image, 'custom-dev:v1');
});
