// Optional developer/terminal equivalent of the panel's Prepare Runtime button.
// Unlike the original installer, this never runs npm or downloads dependencies.
import { fileURLToPath } from 'node:url';
import { prepareRuntime } from '../src/runtime.mjs';

const status = await prepareRuntime({
  bundlePath: fileURLToPath(new URL('../dist/runtime.json.gz', import.meta.url)),
});
if (!status.ready) throw new Error(status.detail);
console.log(status.detail);
