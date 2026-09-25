/**
 * What the registry tells the ADMIN panel about a plug-in
 * (src/discovery-plugins/registry.js): the editable config keys a plug-in
 * declares, what its availability probe found, and the
 * on-demand probe — "check again" replaces the cached answer, the settings
 * modal's Test is a dry run that leaves it alone.
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerPlugin, unregisterPluginForTests, listPlugins, probePlugin, probeStatus, forgetProbe, refreshProbes, isPluginUnavailable,
} from '../../src/discovery-plugins/registry.js';
import { pluginNames, getPlugin } from '../../src/discovery-plugins/index.js';
import { discoveryPluginSchema } from '../../src/state/config.js';

const registered = [];
function reg(def) {
  registered.push(def.name);
  return registerPlugin({ title: 'Unit', capabilities: ['links'], scope: 'server', resolve: async () => ({ links: [] }), ...def });
}
after(() => { for (const n of registered) { unregisterPluginForTests(n); } });
const ON = (name) => ({ [name]: { enabled: true } });
const rowOf = (name) => listPlugins({ includeDisabled: true, config: ON(name) }).find((p) => p.name === name);

describe('what a plug-in declares for the admin panel', () => {
  test('adminSettings are validated at registration', () => {
    assert.throws(() => reg({ name: 'unit-bad-settings', adminSettings: 'binary' }), /adminSettings must be a list/);
    assert.throws(() => reg({ name: 'unit-bad-settings2', adminSettings: ['enabled'] }), /not "enabled"/);
    assert.throws(() => reg({ name: 'unit-bad-settings3', adminSettings: ['has space'] }), /adminSettings must be a list/);
    const ok = reg({ name: 'unit-declares', adminSettings: ['url', 'timeoutMs'] });
    assert.deepEqual([...ok.adminSettings], ['url', 'timeoutMs']);
    assert.ok(Object.isFrozen(ok.adminSettings));
    assert.deepEqual([...reg({ name: 'unit-declares-nothing' }).adminSettings], [], 'absent = an empty list, never undefined');
  });

  test('the admin listing carries them; the user listing does not', () => {
    const admin = rowOf('unit-declares');
    assert.deepEqual([admin.adminSettings, admin.detail, admin.reason], [['url', 'timeoutMs'], null, null]);
    const user = listPlugins({ config: ON('unit-declares') }).find((p) => p.name === 'unit-declares');
    assert.deepEqual(Object.keys(user).sort(), ['available', 'capabilities', 'description', 'enabled', 'name', 'scope', 'scopes', 'settings', 'title']);
  });

  test('every shipped plug-in only declares settings its config schema knows', () => {
    for (const name of pluginNames()) {
      if (registered.includes(name) || name === 'noop-acquire') { continue; }
      const def = getPlugin(name);
      const schema = discoveryPluginSchema(name);
      assert.ok(schema, `${name} has a config schema`);
      const keys = Object.keys(schema.describe().keys);
      assert.ok(keys.includes('enabled'));
      for (const k of def.adminSettings) { assert.ok(keys.includes(k), `${name}.${k} exists in the config schema`); }
    }
    assert.equal(discoveryPluginSchema('no-such-plugin'), null);
    // The executable is a config-file setting, never an admin one: an editable
    // program path would hand an admin session command execution on the host.
    assert.deepEqual([...getPlugin('youtube').adminSettings], ['codec', 'maxFilesizeMb', 'searchResults']);
    assert.ok(!getPlugin('youtube').adminSettings.includes('binary'));
    assert.deepEqual([...getPlugin('itunes').adminSettings], ['country']);
  });
});

describe('probing on demand', () => {
  test('check again replaces the cached answer; Test is a dry run that leaves it alone', async () => {
    let installed = false;
    const seen = [];
    reg({
      name: 'unit-probed',
      probe: async ({ settings } = {}) => {
        seen.push(settings || null);
        const bin = (settings && settings.binary) || 'saved-binary';
        if (bin === 'good-binary' || installed) { return { ok: true, detail: { version: '1.2.3', bin } }; }
        return { ok: false, reason: `not found (${bin})` };
      },
    });

    // Nothing probed yet: available until proven otherwise.
    assert.equal(probeStatus('unit-probed'), null);
    const first = await probePlugin('unit-probed');
    assert.deepEqual(first, { ok: false, reason: 'not found (saved-binary)', detail: null });
    assert.deepEqual(probeStatus('unit-probed'), first, 'check again is cached');
    assert.equal(isPluginUnavailable('unit-probed'), true);
    assert.deepEqual([rowOf('unit-probed').available, rowOf('unit-probed').reason], [false, 'not found (saved-binary)']);

    // A dry run with values that would work: reported, but NOT cached.
    const dry = await probePlugin('unit-probed', { settings: { binary: 'good-binary' } });
    assert.deepEqual(dry, { ok: true, reason: null, detail: { version: '1.2.3', bin: 'good-binary' } });
    assert.deepEqual(seen[seen.length - 1], { binary: 'good-binary' }, 'the plug-in got the values to try');
    assert.equal(probeStatus('unit-probed').ok, false, 'the saved state is still what users get');
    assert.equal(isPluginUnavailable('unit-probed'), true);

    // The binary appears; check again flips the row and carries the detail.
    installed = true;
    const fixed = await probePlugin('unit-probed');
    assert.equal(fixed.ok, true);
    assert.deepEqual([rowOf('unit-probed').available, rowOf('unit-probed').reason, rowOf('unit-probed').detail], [true, null, { version: '1.2.3', bin: 'saved-binary' }]);

    // forgetProbe: saved settings changed, so the next refresh asks again.
    const asked = seen.length;
    await refreshProbes();
    assert.equal(seen.length, asked, 'a fresh passing answer is trusted');
    forgetProbe('unit-probed');
    assert.equal(probeStatus('unit-probed'), null);
    await refreshProbes();
    assert.equal(seen.length, asked + 1);
  });

  test('a probe that throws is a failed probe; a plug-in without one is available; an unknown one is null', async () => {
    reg({ name: 'unit-throws', probe: async () => { throw new Error('exploded'); } });
    assert.deepEqual(await probePlugin('unit-throws'), { ok: false, reason: 'exploded', detail: null });
    assert.deepEqual(await probePlugin('unit-declares'), { ok: true, reason: null, detail: null });
    assert.equal(await probePlugin('no-such-plugin'), null);
    // detail must be an object to be passed on.
    reg({ name: 'unit-odd-detail', probe: async () => ({ ok: true, detail: 'a string' }) });
    assert.equal((await probePlugin('unit-odd-detail')).detail, null);
  });
});
