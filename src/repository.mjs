import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function sourceContext(env) {
  const id = env.ORCA_VM_INSTANCE_ID;
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error('Invalid ORCA_VM_INSTANCE_ID');
  return id;
}

export function sanitizeRemote(remote) {
  if (/^(?:https?|ssh):\/\//i.test(remote)) {
    const url = new URL(remote);
    if (url.protocol !== 'ssh:') url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  }
  // Do not expose local filesystem paths or arbitrary remote helpers in the guest.
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(remote)) return remote;
  return null;
}

export function bundleRepository(env, bundlePath) {
  const repo = env.ORCA_REPO_PATH || process.cwd();
  const head = env.ORCA_REPO_REF_HEAD;
  if (!head || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) throw new Error('ORCA_REPO_REF_HEAD must identify an exact commit');
  if (git(repo, 'rev-parse', `${head}^{commit}`) !== head.toLowerCase()) throw new Error('Source commit mismatch');
  const branch = env.ORCA_REPO_BRANCH || env.ORCA_WORKSPACE_NAME;
  if (!branch) throw new Error('Missing workspace branch');
  git(repo, 'check-ref-format', '--branch', branch);
  const ref = `refs/orca-gondolin/${randomUUID()}`;
  try {
    git(repo, 'update-ref', ref, head);
    git(repo, 'bundle', 'create', bundlePath, ref);
  } finally {
    git(repo, 'update-ref', '-d', ref);
  }
  let remote = null;
  try { remote = sanitizeRemote(git(repo, 'remote', 'get-url', 'origin')); } catch { /* No origin. */ }
  return { head, branch, remote, bundlePath, bundleRef: ref };
}

export const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export async function checkedExec(vm, command) {
  const result = await vm.exec(command);
  if (result.exitCode !== 0) throw new Error(`Guest command failed (${result.exitCode}): ${result.stderr}`);
  return result.stdout.trim();
}

export async function provisionRepository(vm, source) {
  await vm.fs.writeFile('/tmp/orca-source.bundle', createReadStream(source.bundlePath));
  await checkedExec(vm, `set -eu
mkdir -p /workspace/repo
git -C /workspace/repo init
git -C /workspace/repo fetch --no-tags /tmp/orca-source.bundle ${quote(source.bundleRef)}
git -C /workspace/repo checkout -b ${quote(source.branch)} ${quote(source.head)}
${source.remote ? `git -C /workspace/repo remote add origin ${quote(source.remote)}` : ''}
rm /tmp/orca-source.bundle`);
  const actual = await checkedExec(vm, 'git -C /workspace/repo rev-parse HEAD');
  if (actual !== source.head.toLowerCase()) throw new Error('Guest HEAD does not match requested commit');
}
