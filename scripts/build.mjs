import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = new URL('../dist/', import.meta.url);
const staging = await mkdtemp(join(tmpdir(), 'orca-gondolin-build-'));
try {
  await cp(join(root, 'src'), join(staging, 'src'), { recursive: true });
  for (const path of ['package.json', 'package-lock.json', 'LICENSE']) {
    await cp(join(root, path), join(staging, path));
  }
  // Build-time only. Ship pure JS: no native krun runner, cpu-features build,
  // install scripts, platform-specific binaries, or npm needed by the end user.
  execFileSync('npm', ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: staging, stdio: 'inherit',
  });
  await rm(join(staging, 'node_modules', '.bin'), { recursive: true, force: true });
  const files = [];
  async function collect(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      const source = join(directory, name);
      const stat = await lstat(source);
      if (stat.isDirectory()) await collect(source, path);
      else if (stat.isFile()) {
        if (/\.(?:node|so|dylib|dll)$/.test(name)) throw new Error(`Native binary in portable runtime: ${path}`);
        files.push({ path, content: (await readFile(source)).toString('base64') });
      } else throw new Error(`Unsupported runtime entry (symlink or special file): ${path}`);
    }
  }
  await collect(staging);
  const raw = Buffer.from(JSON.stringify({ schemaVersion: 1, files }));
  if (raw.length > 50 * 1024 * 1024 || files.length > 2000) throw new Error('Bundled runtime exceeds packaging limits');
  const bundle = gzipSync(raw, { level: 9 });
  // Validate the exact format consumed by the panel's runtime-preparation action.
  const { unpackRuntime } = await import('../src/runtime.mjs');
  unpackRuntime(bundle);
  await rm(dist, { recursive: true, force: true });
  await mkdir(new URL('src/', dist), { recursive: true });
  for (const path of ['orca-plugin.json', 'recipes', 'worker', 'ui', 'src/config.mjs', 'src/runtime.mjs', 'README.md', 'LICENSE', 'docs']) {
    await cp(new URL(`../${path}`, import.meta.url), new URL(path, dist), { recursive: true });
  }
  await writeFile(new URL('runtime.json.gz', dist), bundle);
  console.log(`Plugin folder: ${fileURLToPath(dist)}\nBundled runtime: ${files.length} files, ${(bundle.length / 1024 / 1024).toFixed(2)} MiB compressed`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
