import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_IMAGE = 'alpine-base:latest';
export const configPath = () => join(homedir(), '.local', 'share', 'orca-gondolin', 'config.json');

export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => key !== 'image') || typeof value.image !== 'string') {
    throw new Error('Configuration must contain only an image string');
  }
  const image = value.image.trim();
  // Gondolin image name[:tag] or build UUID; not shell syntax or asset paths.
  const segment = '[A-Za-z0-9][A-Za-z0-9._-]*';
  const selector = new RegExp(`^${segment}(?:/${segment})*(?::${segment})?$`);
  if (image.length > 256 || !selector.test(image)) {
    throw new Error('Enter a Gondolin image name[:tag] or build UUID (for example my-dev-image:latest)');
  }
  return { image };
}

export async function readConfig(path = configPath()) {
  try {
    return validateConfig(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return { image: DEFAULT_IMAGE };
    throw new Error(`Cannot read Gondolin configuration at ${path}: ${error.message}`);
  }
}

export async function saveConfig(value, path = configPath()) {
  const config = validateConfig(value);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return config;
}

// Explicit SDK selection, independent of the desktop application's image environment.
export const imageOptions = (config) => ({ sandbox: { imagePath: validateConfig(config).image } });
