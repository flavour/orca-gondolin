import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 50 * 1024 * 1024;
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function locations(options) {
  const root = join(options.home ?? homedir(), '.local', 'share', 'orca-gondolin');
  return {
    root,
    bundle: options.bundlePath ?? fileURLToPath(new URL('../runtime.json.gz', import.meta.url)),
    node: options.nodePath ?? process.execPath,
    launcher: join(root, 'bin', 'orca-gondolin'),
    receipt: join(root, 'runtime.json'),
  };
}

async function bundleInfo(path) {
  let bytes;
  try { bytes = await readFile(path); } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Bundled runtime is missing. Install the built dist/ plugin folder, not the source checkout.');
    throw error;
  }
  if (bytes.length > MAX_BYTES) throw new Error('Bundled runtime is too large');
  return { bytes, id: createHash('sha256').update(bytes).digest('hex') };
}

export async function runtimeStatus(options = {}) {
  const paths = locations(options);
  try {
    const { id } = await bundleInfo(paths.bundle);
    const receipt = JSON.parse(await readFile(paths.receipt, 'utf8'));
    if (receipt.id !== id || receipt.node !== paths.node) {
      return { ready: false, detail: 'Prepare the runtime for this plugin/Orca version.' };
    }
    await access(paths.node, constants.X_OK);
    await access(paths.launcher, constants.X_OK);
    await access(join(paths.root, 'runtimes', id, 'ready.json'));
    return { ready: true, detail: 'Bundled runtime is prepared. Git and QEMU must be available on the host.' };
  } catch (error) {
    return { ready: false, detail: error.code === 'ENOENT'
      ? 'Runtime not prepared. Click Prepare Runtime; no npm or package download is needed.'
      : `Cannot inspect runtime: ${error.message}` };
  }
}

export function unpackRuntime(bytes) {
  const archive = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_BYTES }).toString('utf8'));
  if (archive.schemaVersion !== 1 || !Array.isArray(archive.files) || archive.files.length > 2000) {
    throw new Error('Invalid bundled runtime format');
  }
  const seen = new Set();
  let size = 0;
  const files = archive.files.map(({ path, content }) => {
    // Archives contain plain files only. Reject absolute paths, traversal and
    // cross-platform aliases before creating anything in the runtime directory.
    if (typeof path !== 'string' || !/^[A-Za-z0-9@_.-]+(?:\/[A-Za-z0-9@_.-]+)*$/.test(path) ||
        path.split('/').some((part) => part === '.' || part === '..') ||
        seen.has(path.toLowerCase()) || typeof content !== 'string') {
      throw new Error('Unsafe path or content in bundled runtime');
    }
    seen.add(path.toLowerCase());
    const data = Buffer.from(content, 'base64');
    size += data.length;
    if (size > MAX_BYTES) throw new Error('Unpacked runtime is too large');
    return { path, data };
  });
  for (const required of ['src/adapter.mjs', 'src/daemon.mjs', 'package.json', 'node_modules/@earendil-works/gondolin/package.json']) {
    if (!seen.has(required)) throw new Error(`Bundled runtime is missing ${required}`);
  }
  return files;
}

export async function prepareRuntime(options = {}) {
  if (process.platform === 'win32') throw new Error('Gondolin runtime preparation supports Linux and macOS only');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error('Gondolin requires Node 22.19+; update Orca');
  const paths = locations(options);
  await access(paths.node, constants.X_OK);
  const { bytes, id } = await bundleInfo(paths.bundle);
  const files = unpackRuntime(bytes); // Validate completely before writing any runtime files.
  const versions = join(paths.root, 'runtimes');
  await mkdir(versions, { recursive: true, mode: 0o700 });
  await mkdir(join(paths.root, 'bin'), { recursive: true, mode: 0o700 });
  const destination = join(versions, id);
  const staging = join(versions, `.prepare-${randomUUID()}`);
  try {
    await mkdir(staging, { mode: 0o700 });
    for (const { path, data } of files) {
      const target = join(staging, ...path.split('/'));
      await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
      await writeFile(target, data, { flag: 'wx', mode: 0o600 });
    }
    await writeFile(join(staging, 'ready.json'), JSON.stringify({ id }), { mode: 0o600 });
    try { await rename(staging, destination); } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      // A concurrent preparation (or this same version) already published it.
      const ready = JSON.parse(await readFile(join(destination, 'ready.json'), 'utf8'));
      if (ready.id !== id) throw new Error('Existing runtime is incomplete; state was not replaced');
    }
    const launcher = `${paths.launcher}.${randomUUID()}.tmp`;
    try {
      // Orca workers use Electron in Node mode. Retain that mode for the adapter
      // and its detached owner; a normal Node executable accepts it harmlessly.
      await writeFile(launcher, `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(paths.node)} ${quote(join(destination, 'src', 'adapter.mjs'))} "$@"\n`, { flag: 'wx', mode: 0o700 });
      await chmod(launcher, 0o700);
      await rename(launcher, paths.launcher);
    } finally { await rm(launcher, { force: true }); }
    const receipt = `${paths.receipt}.${randomUUID()}.tmp`;
    try {
      await writeFile(receipt, JSON.stringify({ id, node: paths.node }), { flag: 'wx', mode: 0o600 });
      await rename(receipt, paths.receipt);
    } finally { await rm(receipt, { force: true }); }
    // Keep older versions: detached VMs may still be executing their modules.
    return runtimeStatus(options);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
