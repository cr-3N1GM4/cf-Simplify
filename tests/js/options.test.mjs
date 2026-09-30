import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { EXT, read, settle, storageArea } from './helpers.mjs';

async function openOptions({ config = {}, sync = {}, local = {}, grant = true, index = { count: 3, problems: {} } } = {}) {
  const html = read(path.join(EXT, 'options', 'options.html'));
  const dom = new JSDOM(html, { url: 'https://extension.test/options/options.html', runScripts: 'outside-only' });
  const { window } = dom;
  const stores = { sync: storageArea(sync), local: storageArea(local) };
  const log = { permissions: [], messages: [], fetches: [] };
  window.chrome = {
    storage: stores,
    permissions: { request: async ({ origins }) => { log.permissions.push(JSON.parse(JSON.stringify(origins))); return grant; } },
    runtime: {
      getURL: (p) => 'https://extension.test/' + p,
      sendMessage: async (msg) => { log.messages.push(JSON.parse(JSON.stringify(msg))); return { ok: true, message: 'Connected. m replied: OK' }; }
    }
  };
  window.fetch = async (url) => {
    log.fetches.push(String(url));
    const data = String(url).endsWith('config.json') ? config : index;
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) };
  };
  window.eval(read(path.join(EXT, 'shared', 'providers.js')));
  window.eval(read(path.join(EXT, 'options', 'options.js')));
  await settle(20);
  const $ = (id) => window.document.getElementById(id);
  const change = (el) => el.dispatchEvent(new window.Event('change', { bubbles: true }));
  const submit = async () => {
    $('settings').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
    await settle(20);
  };
  return { window, $, stores, log, change, submit };
}

test('lists every provider and shows the right fields for each', async () => {
  const { $, change } = await openOptions({ config: { libraryUrl: 'https://alice.github.io/cf-simplify' } });
  assert.deepEqual([...$('provider').options].map((o) => o.value), ['none', 'gemini', 'groq', 'openrouter', 'ollama', 'custom']);
  assert.equal($('libraryUrl').placeholder, 'https://alice.github.io/cf-simplify');
  assert.ok($('providerFields').hidden);

  $('provider').value = 'gemini';
  change($('provider'));
  assert.ok(!$('providerFields').hidden);
  assert.ok(!$('keyField').hidden);
  assert.ok($('baseUrlField').hidden);
  assert.equal($('model').placeholder, 'gemini-flash-latest');
  assert.ok($('keyHelp').textContent.includes('aistudio.google.com'));

  $('provider').value = 'ollama';
  change($('provider'));
  assert.ok($('keyField').hidden);
  assert.ok(!$('baseUrlField').hidden);
});

test('saves settings, keeps each provider\'s values, and asks permission only for new addresses', async () => {
  const { $, change, submit, stores, log } = await openOptions();
  $('provider').value = 'gemini';
  change($('provider'));
  $('apiKey').value = 'AIza-key';
  $('provider').value = 'custom';
  change($('provider'));
  $('baseUrl').value = 'https://llm.example.com:8443/v1/';
  $('model').value = 'my-model';
  $('libraryUrl').value = 'https://alice.github.io/cf-simplify/';
  await submit();

  assert.deepEqual(log.permissions, [['https://llm.example.com/*']], 'github.io is built in; the custom API is not');
  assert.equal(stores.sync.data.provider, 'custom');
  assert.equal(stores.sync.data.libraryUrl, 'https://alice.github.io/cf-simplify');
  assert.deepEqual(stores.local.data.providerSettings.custom, { apiKey: '', model: 'my-model', baseUrl: 'https://llm.example.com:8443/v1' });
  assert.equal(stores.local.data.providerSettings.gemini.apiKey, 'AIza-key', 'switching providers keeps the other key');
  assert.match($('saveStatus').textContent, /^Saved/);

  $('provider').value = 'gemini';
  change($('provider'));
  assert.equal($('apiKey').value, 'AIza-key');
});

test('refuses to save without the needed permission or with a bad address', async () => {
  const page = await openOptions({ grant: false });
  page.$('provider').value = 'custom';
  page.change(page.$('provider'));
  page.$('baseUrl').value = 'https://llm.example.com/v1';
  page.$('model').value = 'm';
  await page.submit();
  assert.match(page.$('saveStatus').textContent, /needs permission/);
  assert.equal(page.stores.sync.data.provider, undefined);

  page.$('libraryUrl').value = 'ftp://nope';
  await page.submit();
  assert.match(page.$('saveStatus').textContent, /must start with https/);
});

test('checks the library and tests the key', async () => {
  const { $, log, change } = await openOptions({ config: { libraryUrl: 'https://alice.github.io/cf-simplify' }, index: { count: 1234, updatedAt: '2026-09-20T10:00:00Z' } });
  $('checkLibrary').click();
  await settle(20);
  assert.ok(log.fetches.includes('https://alice.github.io/cf-simplify/index.json'), 'uses the built-in address when the field is empty');
  assert.match($('libraryStatus').textContent, /Library found: 1,234 problems/);

  $('provider').value = 'groq';
  change($('provider'));
  $('apiKey').value = 'gsk-test';
  $('testKey').click();
  await settle(20);
  assert.deepEqual(log.messages.at(-1), { type: 'cfs:test', config: { provider: 'groq', apiKey: 'gsk-test', model: '', baseUrl: '' } });
  assert.match($('keyStatus').textContent, /Connected/);
});

test('shows and clears simplifications saved on this computer', async () => {
  const local = {
    'c:1A': { source: 'personal', simplified: 'x' },
    'c:4A': { source: 'library', simplified: 'y' },
    'phase:4': { phase: 'FINISHED' }
  };
  const { $, stores } = await openOptions({ local });
  assert.match($('cacheInfo').textContent, /2 simplified problems are saved here \(1 made with your key\)/);
  $('clearCache').click();
  await settle(20);
  assert.deepEqual(Object.keys(stores.local.data), ['phase:4']);
  assert.match($('cacheInfo').textContent, /Nothing saved yet/);
  assert.ok($('clearCache').disabled);
});
