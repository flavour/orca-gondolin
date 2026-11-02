import net from 'node:net';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { provisionRepository, checkedExec } from './repository.mjs';
import { imageOptions } from './config.mjs';

let vm;
let boot;
let server;
let stopping;
let handedOff = false;
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    if (boot) { try { vm = await boot; } catch { /* Boot failed. */ } }
    if (vm) await vm.close();
    server?.close();
  })();
  return stopping;
}
// If Orca cancels/kills the create command before handoff, do not leave an orphan VM.
process.on('disconnect', () => {
  if (!handedOff) stop().then(() => process.exit(0), (error) => {
    console.error(error); process.exit(1);
  });
});
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => stop().then(() => process.exit(0), (error) => {
    console.error(error); process.exit(1);
  }));
}

process.once('message', async ({ id, directory, socketPath, source, config }) => {
  try {
    // Import only in the owner process. SDK diagnostics go to the private daemon log.
    const { VM } = await import('@earendil-works/gondolin');
    boot = VM.create({
      sessionLabel: `Orca ${id}`,
      sandbox: { ...imageOptions(config).sandbox, vmm: 'qemu' },
      memory: '4G', cpus: 2,
      rootfs: { mode: 'cow', size: '20G' },
      tmpfs: { '/tmp': { size: '256m' } },
    });
    vm = await boot;
    await checkedExec(vm, 'apk add --no-cache git bash nodejs tar curl libstdc++ libgcc');
    await provisionRepository(vm, source);
    const access = await vm.enableSsh({ user: 'root', listenHost: '127.0.0.1', listenPort: 0 });
    const result = {
      schemaVersion: 2,
      checkoutMode: 'provisioned-root',
      connection: {
        type: 'ssh', projectRoot: '/workspace/repo',
        target: {
          label: `Gondolin ${id}`, host: access.host, port: access.port,
          username: access.user, identityFile: access.identityFile, identitiesOnly: true,
        },
      },
      userData: { instanceId: id, sessionId: vm.id, image: config.image },
    };
    server = net.createServer((socket) => {
      socket.setTimeout(10_000, () => socket.destroy());
      let input = '';
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        input += chunk;
        if (input.length > 1024) return socket.destroy();
        if (!input.includes('\n')) return;
        socket.pause();
        if (input.trim() !== 'destroy') return socket.end('error\n');
        stop().then(() => {
          socket.end('ok\n', () => process.exit(0));
        }, (error) => {
          console.error(error);
          socket.end('error\n');
          // Keep ownership and report failure; do not silently forget the VM.
          stopping = undefined;
        });
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    await writeFile(join(directory, 'result.json'), JSON.stringify(result), { mode: 0o600 });
    // Deliver the result before dropping the IPC channel. The local control socket
    // becomes the durable lifecycle interface after this handoff.
    await new Promise((resolve, reject) => process.send({ result }, (error) => error ? reject(error) : resolve()));
    handedOff = true;
    if (process.connected) process.disconnect();
  } catch (error) {
    console.error(error);
    let cleaned = false;
    try { await stop(); cleaned = true; } catch (cleanup) { console.error('Cleanup failed:', cleanup); }
    if (process.connected) {
      handedOff = true;
      process.send({ error: error.message, cleaned }, () => {
        if (process.connected) process.disconnect();
      });
    }
    process.exitCode = 1;
  }
});
