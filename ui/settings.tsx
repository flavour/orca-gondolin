import { atom, Button, Heading, Input, plugin, read, Select, set, Stack, Text } from 'orca';
import type {} from './protocol';

const preset = atom('alpine-base:latest');
const custom = atom('');
const busy = atom(true);
const loaded = atom(false);
const status = atom('Loading configuration…');
const failed = atom(false);
const runtimeBusy = atom(true);
const runtimeReady = atom(false);
const runtimeDetail = atom('Checking bundled runtime…');

async function runtime(action: 'runtime.status' | 'runtime.prepare') {
  set(runtimeBusy, true);
  try {
    const result = await plugin.request(action, {});
    set(runtimeReady, result.ready);
    set(runtimeDetail, result.detail);
  } catch (error) {
    set(runtimeReady, false);
    set(runtimeDetail, String(error));
  } finally {
    set(runtimeBusy, false);
  }
}

async function load() {
  set(busy, true);
  try {
    const config = await plugin.request('config.get', {});
    set(preset, config.image === 'alpine-base:latest' ? config.image : 'custom');
    set(custom, config.image === 'alpine-base:latest' ? '' : config.image);
    set(status, 'Configuration loaded.');
    set(failed, false);
    set(loaded, true);
  } catch (error) {
    set(status, String(error));
    set(failed, true);
  } finally {
    set(busy, false);
  }
}

async function save() {
  set(busy, true);
  try {
    const image = read(preset) === 'custom' ? read(custom) : read(preset);
    const saved = await plugin.request('config.save', { image });
    if (read(preset) === 'custom') set(custom, saved.image);
    set(status, `Saved ${saved.image}. New sandboxes will use this image.`);
    set(failed, false);
  } catch (error) {
    set(status, String(error));
    set(failed, true);
  } finally {
    set(busy, false);
  }
}

export function setup() {
  void load();
  void runtime('runtime.status');
}

export default function Settings() {
  return (
    <Stack gap="md">
      <Heading>Gondolin Settings</Heading>
      <Heading level={2}>Runtime setup</Heading>
      <Text>After adding or updating this plugin, prepare its bundled runtime once. This writes private files under ~/.local/share/orca-gondolin; no npm, separate Node installation, or package download is needed.</Text>
      <Text muted>Orca does not run plugin install hooks or pass the plugin directory to VM recipes. Add Plugin alone cannot complete this step. Git, OpenSSH tools and QEMU must still be available on the host.</Text>
      <Button onPress={() => void runtime('runtime.prepare')} disabled={read(runtimeBusy)}>
        Prepare Runtime
      </Button>
      <Text tone={read(runtimeReady) ? 'success' : 'warning'}>{read(runtimeDetail)}</Text>
      <Heading level={2}>Image</Heading>
      <Text>Choose the image for new sandboxes. Existing sandboxes are not changed.</Text>
      <Select
        label="Image"
        value={read(preset)}
        options={[
          { value: 'alpine-base:latest', label: 'Alpine Base (latest)' },
          { value: 'custom', label: 'Custom Gondolin image' },
        ]}
        disabled={read(busy) || !read(loaded)}
        onChange={(value) => set(preset, value)}
      />
      {read(preset) === 'custom' ? (
        <Input
          label="Image name or build UUID"
          placeholder="my-dev-image:latest"
          value={read(custom)}
          maxLength={256}
          disabled={read(busy)}
          onChange={(value) => set(custom, value)}
        />
      ) : null}
      <Text muted>Custom images must be Alpine-based and include Gondolin’s guest and SSH helpers. Build or pull the image on this host first.</Text>
      <Button onPress={() => void save()} disabled={read(busy) || !read(loaded) || (read(preset) === 'custom' && !read(custom).trim())}>
        Save configuration
      </Button>
      <Button variant="ghost" onPress={() => void load()} disabled={read(busy)}>Reload configuration</Button>
      <Text tone={read(failed) ? 'danger' : 'success'}>{read(status)}</Text>
    </Stack>
  );
}
