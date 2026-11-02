import { readConfig, saveConfig } from '../src/config.mjs';
import { prepareRuntime, runtimeStatus } from '../src/runtime.mjs';

// Workers are started on demand by panel requests. The config file, not the
// worker's lifetime, is the bridge to the separately installed lifecycle adapter.
export default function activate(orca) {
  orca.panels.handle('config.get', () => readConfig());
  orca.panels.handle('config.save', (value) => saveConfig(value));
  orca.panels.handle('runtime.status', () => runtimeStatus());
  orca.panels.handle('runtime.prepare', () => prepareRuntime());
}
