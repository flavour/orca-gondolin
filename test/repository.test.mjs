import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleRepository, git, quote, sanitizeRemote, sourceContext, provisionRepository } from '../src/repository.mjs';

export async function fixture(t) {
  const repo = await mkdtemp(join(tmpdir(), 'orca-gondolin-test-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Test');
  await writeFile(join(repo, 'file.txt'), 'first\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'first');
  const head = git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'file.txt'), 'second\n');
  git(repo, 'commit', '-am', 'second');
  await writeFile(join(repo, 'file.txt'), 'dirty\n');
  return { repo, head };
}

test('bundle includes the pinned commit, not dirty files or current HEAD', async (t) => {
  const { repo, head } = await fixture(t);
  git(repo, 'remote', 'add', 'origin', 'https://user:token@example.com/org/repo.git');
  const bundle = join(repo, 'source.bundle');
  const source = bundleRepository({ ORCA_REPO_PATH: repo, ORCA_REPO_REF_HEAD: head, ORCA_REPO_BRANCH: 'workspace/test' }, bundle);
  assert.equal(source.remote, 'https://example.com/org/repo.git');
  assert.equal(git(repo, 'for-each-ref', 'refs/orca-gondolin'), '');
  const clone = join(repo, 'clone');
  git(repo, 'init', clone);
  git(clone, 'fetch', '--no-tags', bundle, source.bundleRef);
  git(clone, 'checkout', '-b', source.branch, head);
  assert.equal(git(clone, 'show', 'HEAD:file.txt'), 'first');
  assert.equal(git(clone, 'rev-parse', 'HEAD'), head);
});

test('rejects missing pin, invalid branches and untrusted instance paths', async (t) => {
  const { repo, head } = await fixture(t);
  assert.throws(() => bundleRepository({ ORCA_REPO_PATH: repo }, join(repo, 'x')), /exact commit/);
  assert.throws(() => bundleRepository({ ORCA_REPO_PATH: repo, ORCA_REPO_REF_HEAD: head, ORCA_REPO_BRANCH: '--bad' }, join(repo, 'x')));
  for (const id of ['', '../escape', 'a/b', 'a;touch x']) assert.throws(() => sourceContext({ ORCA_VM_INSTANCE_ID: id }));
  assert.equal(sourceContext({ ORCA_VM_INSTANCE_ID: 'orca-123' }), 'orca-123');
});

test('remote sanitization and shell quoting', () => {
  assert.equal(sanitizeRemote('https://u:secret@host/repo?token=secret#secret'), 'https://host/repo');
  assert.equal(sanitizeRemote('/home/user/repo'), null);
  assert.equal(sanitizeRemote('ext::arbitrary command'), null);
  assert.equal(sanitizeRemote('git@github.com:org/repo.git'), 'git@github.com:org/repo.git');
  assert.equal(quote("a'b"), "'a'\\''b'");
});

test('guest nonzero exit codes abort provisioning', async () => {
  const vm = { fs: { writeFile: async (_path, stream) => { stream.destroy(); } }, exec: async () => ({ exitCode: 1, stderr: 'clone failed' }) };
  await assert.rejects(provisionRepository(vm, { bundlePath: '/dev/null', head: 'a'.repeat(40), branch: 'test' }), /clone failed/);
});
