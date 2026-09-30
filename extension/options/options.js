/* CF Simplify settings page. */
'use strict';

const PROVIDERS = globalThis.CFS_PROVIDERS;
const $ = (id) => document.getElementById(id);
const PREF_DEFAULTS = { libraryUrl: '', provider: 'none', autoConvert: true, defaultView: 'simplified' };

// Hosts the extension may already reach (manifest host_permissions).
const BUILT_IN_HOSTS = [
  'https://*.codeforces.com', 'https://*.github.io', 'https://cdn.jsdelivr.net', 'https://raw.githubusercontent.com',
  'http://localhost', 'http://127.0.0.1', 'https://generativelanguage.googleapis.com', 'https://api.groq.com',
  'https://openrouter.ai'
];

let drafts = {};         // per-provider { apiKey, model, baseUrl } being edited
let current = 'none';    // provider shown in the form
let bundledLibrary = ''; // library address built into this copy (config.json)

function setStatus(id, text, kind) {
  const node = $(id);
  node.textContent = text || '';
  node.className = 'status' + (kind ? ' ' + kind : '');
}

function isBuiltIn(url) {
  return BUILT_IN_HOSTS.some((pattern) => {
    const [scheme, host] = pattern.split('://');
    if (url.protocol !== scheme + ':') return false;
    return host.startsWith('*.')
      ? url.hostname === host.slice(2) || url.hostname.endsWith(host.slice(1))
      : url.hostname === host;
  });
}

// Origins (without port, as Chrome expects) that need an extra permission prompt.
function originsToRequest(urls) {
  const origins = new Set();
  for (const raw of urls) {
    if (!raw) continue;
    let url;
    try { url = new URL(raw); } catch (err) { continue; }
    if (!/^https?:$/.test(url.protocol) || isBuiltIn(url)) continue;
    origins.add(url.protocol + '//' + url.hostname + '/*');
  }
  return Array.from(origins);
}

function validUrl(raw) {
  if (!raw) return true;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch (err) {
    return false;
  }
}

function captureDraft() {
  if (current === 'none') return;
  drafts[current] = {
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    baseUrl: $('baseUrl').value.trim().replace(/\/+$/, '')
  };
}

function showProvider(name) {
  current = name;
  const preset = PROVIDERS[name];
  $('providerFields').hidden = !preset;
  if (!preset) return;
  const draft = drafts[name] || {};
  $('apiKey').value = draft.apiKey || '';
  $('model').value = draft.model || '';
  $('baseUrl').value = draft.baseUrl || '';
  $('model').placeholder = preset.defaultModel || 'Model name';
  $('baseUrl').placeholder = preset.baseUrl || 'https://example.com/v1';
  $('baseUrlField').hidden = !preset.editableBaseUrl;
  $('keyField').hidden = !preset.needsKey && name !== 'custom';
  $('keyHelp').textContent = preset.keyHelp || '';
  $('modelHelp').textContent = preset.modelHelp || '';
  setStatus('keyStatus', '');
}

function readForm() {
  captureDraft();
  return {
    libraryUrl: $('libraryUrl').value.trim().replace(/\/+$/, ''),
    provider: $('provider').value,
    autoConvert: document.querySelector('input[name="autoConvert"]:checked').value === 'yes',
    defaultView: document.querySelector('input[name="defaultView"]:checked').value,
    own: drafts[$('provider').value] || {}
  };
}

async function load() {
  const cfg = await fetch(chrome.runtime.getURL('config.json')).then((r) => r.json()).catch(() => ({}));
  const prefs = await chrome.storage.sync.get(PREF_DEFAULTS);
  const local = await chrome.storage.local.get({ providerSettings: {} });
  drafts = local.providerSettings || {};

  bundledLibrary = String(cfg.libraryUrl || '').replace(/\/+$/, '');
  $('libraryUrl').value = prefs.libraryUrl;
  $('libraryUrl').placeholder = bundledLibrary || 'https://your-name.github.io/cf-simplify';

  const select = $('provider');
  select.append(new Option("Don't use a key", 'none'));
  for (const [id, preset] of Object.entries(PROVIDERS)) select.append(new Option(preset.label, id));
  select.value = PROVIDERS[prefs.provider] ? prefs.provider : 'none';
  showProvider(select.value);

  document.querySelector(`input[name="autoConvert"][value="${prefs.autoConvert ? 'yes' : 'no'}"]`).checked = true;
  document.querySelector(`input[name="defaultView"][value="${prefs.defaultView === 'original' ? 'original' : 'simplified'}"]`).checked = true;
  refreshCacheInfo();
}

async function save(event) {
  event.preventDefault();
  const form = readForm();
  const preset = PROVIDERS[form.provider];
  if (!validUrl(form.libraryUrl)) return setStatus('saveStatus', 'The library address must start with https:// or http://.', 'error');
  if (preset && preset.editableBaseUrl && form.own.baseUrl && !validUrl(form.own.baseUrl)) {
    return setStatus('saveStatus', 'The base URL must start with https:// or http://.', 'error');
  }
  if (form.provider === 'custom' && !form.own.baseUrl) return setStatus('saveStatus', 'Enter the base URL of your API.', 'error');
  if (preset && !form.own.model && !preset.defaultModel) return setStatus('saveStatus', 'Enter a model name.', 'error');

  // Ask for access to any new address first, while the click still counts as a user action.
  const origins = originsToRequest([form.libraryUrl, preset && preset.editableBaseUrl ? form.own.baseUrl : '']);
  if (origins.length) {
    const granted = await chrome.permissions.request({ origins });
    if (!granted) return setStatus('saveStatus', 'Not saved: the extension needs permission to reach ' + origins.join(', ') + '.', 'error');
  }

  await chrome.storage.sync.set({
    libraryUrl: form.libraryUrl,
    provider: form.provider,
    autoConvert: form.autoConvert,
    defaultView: form.defaultView
  });
  await chrome.storage.local.set({ providerSettings: drafts });
  setStatus('saveStatus', 'Saved. Reload open Codeforces tabs to use the new settings.', 'ok');
}

async function checkLibrary() {
  const url = $('libraryUrl').value.trim().replace(/\/+$/, '') || bundledLibrary;
  if (!url) return setStatus('libraryStatus', 'Enter a library address first.', 'error');
  if (!validUrl(url)) return setStatus('libraryStatus', 'The address must start with https:// or http://.', 'error');
  const origins = originsToRequest([url]);
  if (origins.length && !(await chrome.permissions.request({ origins }))) {
    return setStatus('libraryStatus', 'Permission to reach that address was not granted.', 'error');
  }
  setStatus('libraryStatus', 'Checking…');
  try {
    const res = await fetch(url + '/index.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status === 404 ? 'no index.json at that address' : 'HTTP ' + res.status);
    const index = await res.json();
    const count = Number(index.count || Object.keys(index.problems || {}).length);
    const when = index.updatedAt ? ', updated ' + new Date(index.updatedAt).toLocaleDateString() : '';
    setStatus('libraryStatus', `Library found: ${count.toLocaleString()} problems${when}.`, 'ok');
  } catch (err) {
    setStatus('libraryStatus', "Couldn't read the library: " + (err.message || err) + '.', 'error');
  }
}

async function testKey() {
  const form = readForm();
  const preset = PROVIDERS[form.provider];
  if (!preset) return setStatus('keyStatus', 'Choose a provider first.', 'error');
  const origins = originsToRequest([preset.editableBaseUrl ? form.own.baseUrl : '']);
  if (origins.length && !(await chrome.permissions.request({ origins }))) {
    return setStatus('keyStatus', 'Permission to reach that address was not granted.', 'error');
  }
  $('testKey').disabled = true;
  setStatus('keyStatus', 'Testing…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'cfs:test', config: { provider: form.provider, ...form.own } });
    setStatus('keyStatus', res.message, res.ok ? 'ok' : 'error');
  } catch (err) {
    setStatus('keyStatus', err.message || String(err), 'error');
  } finally {
    $('testKey').disabled = false;
  }
}

async function refreshCacheInfo() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('c:'));
  const personal = keys.filter((k) => all[k] && all[k].source === 'personal').length;
  $('cacheInfo').textContent = keys.length
    ? `${keys.length} simplified ${keys.length === 1 ? 'problem is' : 'problems are'} saved here (${personal} made with your key), so they open instantly and don't use your key again.`
    : 'Nothing saved yet. Simplified problems are saved here after you open them.';
  $('clearCache').disabled = keys.length === 0;
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('c:')));
  refreshCacheInfo();
}

$('provider').addEventListener('change', () => { captureDraft(); showProvider($('provider').value); });
$('settings').addEventListener('submit', save);
$('checkLibrary').addEventListener('click', checkLibrary);
$('testKey').addEventListener('click', testKey);
$('clearCache').addEventListener('click', clearCache);
load();
