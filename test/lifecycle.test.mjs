import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { destroyOwner, paths } from '../src/adapter.mjs';

test('destroy waits for owner confirmation and reports failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'og-'));
  const socketPath = join(directory, 's');
  const server = net.createServer((socket) => {
    socket.once('data', () => socket.end('error\n'));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(destroyOwner(socketPath), /failed to destroy/);
});

test('destroy rejects a mismatched lifecycle payload', async () => {
  await assert.rejects(new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['src/adapter.mjs', 'destroy'], {
      env: { ...process.env, ORCA_VM_MODE: 'destroy', ORCA_VM_INSTANCE_ID: 'orca-test' },
    }, (error, stdout, stderr) => error ? reject(new Error(stderr)) : resolve(stdout));
    child.stdin.end(JSON.stringify({ schemaVersion: 1, mode: 'destroy', instanceId: 'other' }));
  }), /instance mismatch/);
});

test('failed create before boot removes its instance state', async () => {
  const id = `orca-test-${randomUUID()}`;
  await assert.rejects(new Promise((resolve, reject) => {
    execFile(process.execPath, ['src/adapter.mjs', 'create'], {
      env: { ...process.env, ORCA_VM_MODE: 'create', ORCA_VM_INSTANCE_ID: id, ORCA_REPO_REF_HEAD: '' },
    }, (error, stdout, stderr) => error ? reject(new Error(stderr)) : resolve(stdout));
  }), /exact commit/);
  await assert.rejects(readFile(join(paths(id).directory, 'source.bundle')), { code: 'ENOENT' });
});
