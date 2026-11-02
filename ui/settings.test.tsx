import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockHost, mount } from 'orca/testing';
import * as Settings from './settings';

test('image picker loads, accepts a custom image and confirms save', async () => {
  let saved;
  const panel = await mount(Settings, { host: mockHost({ requests: {
    'runtime.status': { ready: false, detail: 'Runtime not prepared.' },
    'config.get': { image: 'alpine-base:latest' },
    'config.save': (value) => { saved = value; return value; },
  } }) });
  try {
    assert.equal(panel.find({ label: 'Image' })?.props.value, 'alpine-base:latest');
    await panel.select({ label: 'Image' }, 'custom');
    await panel.type({ label: 'Image name or build UUID' }, 'my-dev:v2', { replace: true });
    await panel.press({ text: 'Save configuration' });
    assert.deepEqual(saved, { image: 'my-dev:v2' });
    assert.ok(panel.find({ text: /Saved my-dev:v2/ }));
    assert.deepEqual(panel.errors, []);
    assert.deepEqual(panel.warnings, []);
    assert.deepEqual(panel.refusals, []);
  } finally { await panel.unmount(); }
});

test('saved custom selection reloads; save failures are visible', async () => {
  const panel = await mount(Settings, { host: mockHost({ requests: {
    'runtime.status': { ready: true, detail: 'Runtime is prepared.' },
    'config.get': { image: 'team/dev:stable' },
    'config.save': () => { throw new Error('Configuration is not writable'); },
  } }) });
  try {
    assert.equal(panel.find({ label: 'Image' })?.props.value, 'custom');
    assert.equal(panel.find({ label: 'Image name or build UUID' })?.props.value, 'team/dev:stable');
    await panel.press({ text: 'Save configuration' });
    assert.ok(panel.find({ text: /Configuration is not writable/ }));
    assert.equal(panel.find({ label: 'Image name or build UUID' })?.props.value, 'team/dev:stable');
    assert.deepEqual(panel.errors, []);
    assert.deepEqual(panel.warnings, []);
  } finally { await panel.unmount(); }
});

test('runtime preparation is explicit and reports success without changing the image', async () => {
  let prepared = 0;
  const panel = await mount(Settings, { host: mockHost({ requests: {
    'runtime.status': { ready: false, detail: 'Runtime not prepared.' },
    'runtime.prepare': () => { prepared++; return { ready: true, detail: 'Bundled runtime is prepared.' }; },
    'config.get': { image: 'team/dev:stable' },
  } }) });
  try {
    assert.equal(prepared, 0);
    assert.ok(panel.find({ text: /Runtime not prepared/ }));
    await panel.press({ text: 'Prepare Runtime' });
    assert.equal(prepared, 1);
    assert.ok(panel.find({ text: 'Bundled runtime is prepared.' }));
    assert.equal(panel.find({ label: 'Image name or build UUID' })?.props.value, 'team/dev:stable');
    assert.deepEqual(panel.errors, []);
    assert.deepEqual(panel.refusals, []);
  } finally { await panel.unmount(); }
});

test('runtime preparation failures are visible and can be retried', async () => {
  const panel = await mount(Settings, { host: mockHost({ requests: {
    'runtime.status': { ready: false, detail: 'Runtime not prepared.' },
    'runtime.prepare': () => { throw new Error('Cannot write runtime directory'); },
    'config.get': { image: 'alpine-base:latest' },
  } }) });
  try {
    await panel.press({ text: 'Prepare Runtime' });
    assert.ok(panel.find({ text: /Cannot write runtime directory/ }));
    assert.equal(panel.find({ text: 'Prepare Runtime' })?.disabled, false);
    assert.deepEqual(panel.errors, []);
  } finally { await panel.unmount(); }
});
