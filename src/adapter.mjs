#!/usr/bin/env node
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { open, mkdir, rm, access, lstat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleRepository, sourceContext } from './repository.mjs';
import { readConfig } from './config.mjs';

export function paths(id, home = homedir()) {
  const key = createHash('sha256').update(id).digest('hex').slice(0, 24);
  const root = join(home, '.local', 'share', 'orca-gondolin', 'instances');
  // AF_UNIX paths are limited to ~104 bytes on macOS. A private per-user directory
  // in /tmp keeps this independent of the length of the user's home directory.
  const sockets = join(tmpdir(), `orca-gondolin-${process.getuid()}`);
  return { root, directory: join(root, key), sockets, socketPath: join(sockets, `${key}.sock`) };
}

async function lifecycleInput(id) {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1024 * 1024) throw new Error('Lifecycle payload too large');
  }
  const payload = JSON.parse(input);
  if (payload.schemaVersion !== 1 || payload.mode !== 'destroy' || payload.instanceId !== id ||
      payload.recipeResult?.userData?.instanceId !== id) throw new Error('Lifecycle instance mismatch');
}

export async function destroyOwner(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    socket.setTimeout(60_000, () => socket.destroy(new Error('Destroy timed out; state retained for retry')));
    socket.on('connect', () => socket.write('destroy\n'));
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('error', reject);
    socket.on('end', () => response.trim() === 'ok' ? resolve() : reject(new Error('Owner failed to destroy VM')));
  });
}

async function createOwner(id, locations, source, config) {
  const log = await open(join(locations.directory, 'daemon.log'), 'a', 0o600);
  const child = fork(fileURLToPath(new URL('./daemon.mjs', import.meta.url)), [], {
    detached: true,
    stdio: ['ignore', log.fd, log.fd, 'ipc'],
  });
  await log.close();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cancel = () => {
      child.kill('SIGTERM');
      finish(new Error(`Provisioning cancelled. Inspect ${locations.directory}/daemon.log before removing retained state.`));
    };
    const timer = setTimeout(cancel, 10 * 60_000);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('SIGTERM', cancel);
      process.off('SIGINT', cancel);
      child.unref();
      if (error) reject(error); else resolve(result);
    };
    process.once('SIGTERM', cancel);
    process.once('SIGINT', cancel);
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(new Error(`Gondolin owner exited (${code}); see ${locations.directory}/daemon.log`)));
    child.once('message', (message) => message.error
      ? finish(Object.assign(new Error(message.error), { cleaned: message.cleaned }))
      : finish(null, message.result));
    child.send({ id, ...locations, source, config });
  });
}

export async function main(env = process.env) {
  const mode = env.ORCA_VM_MODE || process.argv[2];
  const id = sourceContext(env);
  const locations = paths(id);
  if (mode === 'destroy') {
    await lifecycleInput(id);
    try { await access(locations.directory); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    try { await destroyOwner(locations.socketPath); } catch (error) {
      throw new Error(`Cannot contact or stop Gondolin owner: ${error.message}. State retained at ${locations.directory}; inspect daemon.log and gondolin list.`);
    }
    await rm(locations.directory, { recursive: true, force: true });
    await rm(locations.socketPath, { force: true });
    return;
  }
  if (mode !== 'create') throw new Error(`Unsupported lifecycle: ${mode}`);
  const config = await readConfig(); // Snapshot once: settings changes affect only later creates.
  await mkdir(locations.root, { recursive: true, mode: 0o700 });
  await mkdir(locations.sockets, { recursive: true, mode: 0o700 });
  const socketDirectory = await lstat(locations.sockets);
  if (!socketDirectory.isDirectory() || socketDirectory.uid !== process.getuid() || (socketDirectory.mode & 0o077)) {
    throw new Error(`Unsafe socket directory: ${locations.sockets}`);
  }
  await mkdir(locations.directory, { mode: 0o700 }); // Exclusive ownership; never overwrite a running VM.
  const bundlePath = join(locations.directory, 'source.bundle');
  let ownerStarted = false;
  try {
    const source = bundleRepository(env, bundlePath);
    ownerStarted = true;
    const result = await createOwner(id, locations, source, config);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    if (!ownerStarted || error.cleaned) {
      await rm(locations.directory, { recursive: true, force: true });
      await rm(locations.socketPath, { force: true });
    }
    throw error;
  } finally {
    await rm(bundlePath, { force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
