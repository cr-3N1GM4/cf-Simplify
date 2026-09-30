/* CF Simplify background service worker.
   - Looks problems up in the shared library (static JSON files).
   - Checks whether a contest is still running (Codeforces API) so the
     extension can pause itself during contests.
   - Optionally simplifies a missing problem with the person's own API key. */
'use strict';

// Chrome runs this as a service worker. Firefox runs it as a background page
// whose manifest loads the shared files first (see `build.py package`).
if (typeof importScripts === 'function') importScripts('shared/providers.js', 'shared/checks.js');

const PREF_DEFAULTS = {
  libraryUrl: '',
  provider: 'none',
  autoConvert: true,
  defaultView: 'simplified'
};
const LIBRARY_TTL_MS = 3 * 24 * 60 * 60 * 1000; // re-check the library every 3 days (picks up fixes)
const PHASE_TTL_MS = 5 * 60 * 1000;
const LLM_TIMEOUT_MS = 120 * 1000;

// ---------------------------------------------------------------- bundled files
const once = (fn) => { let p = null; return () => (p ||= fn()); };
const bundledConfig = once(() => fetch(chrome.runtime.getURL('config.json')).then((r) => r.json()).catch(() => ({})));
const systemPrompt = once(() => fetch(chrome.runtime.getURL('prompt.txt')).then((r) => r.text()));
const hintTerms = once(() => fetch(chrome.runtime.getURL('shared/hint-terms.json')).then((r) => r.json()));

// ---------------------------------------------------------------- settings
async function getSettings() {
  const [prefs, local, cfg] = await Promise.all([
    chrome.storage.sync.get(PREF_DEFAULTS),
    chrome.storage.local.get({ providerSettings: {} }),
    bundledConfig()
  ]);
  const libraryUrl = String(prefs.libraryUrl || cfg.libraryUrl || '').trim().replace(/\/+$/, '');
  const own = local.providerSettings[prefs.provider] || {};
  return {
    ...prefs,
    libraryUrl,
    reportUrl: cfg.reportUrl || '',
    llm: resolveLlm(prefs.provider, own)
  };
}

// Returns a usable {provider, baseUrl, model, apiKey} or null.
function resolveLlm(provider, own) {
  const preset = CFS_PROVIDERS[provider];
  if (!preset) return null;
  const baseUrl = String((preset.editableBaseUrl && own.baseUrl) || preset.baseUrl || '').trim().replace(/\/+$/, '');
  const model = String(own.model || preset.defaultModel || '').trim();
  const apiKey = String(own.apiKey || '').trim();
  if (!baseUrl || !model) return null;
  if (preset.needsKey && !apiKey) return null;
  return { provider, baseUrl, model, apiKey };
}

// ---------------------------------------------------------------- contest phase
const phaseRequests = new Map();

async function contestPhase(contestId) {
  const id = Number(contestId);
  if (!Number.isInteger(id) || id <= 0) return 'UNKNOWN';
  const key = 'phase:' + id;
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached && (cached.phase === 'FINISHED' || Date.now() - cached.at < PHASE_TTL_MS)) return cached.phase;
  if (phaseRequests.has(id)) return phaseRequests.get(id);

  const request = (async () => {
    try {
      const phase = await fetchPhase(id);
      if (phase !== 'UNKNOWN') await chrome.storage.local.set({ [key]: { phase, at: Date.now() } });
      return phase === 'UNKNOWN' && cached ? cached.phase : phase;
    } catch (err) {
      return cached ? cached.phase : 'UNKNOWN';
    } finally {
      phaseRequests.delete(id);
    }
  })();
  phaseRequests.set(id, request);
  return request;
}

async function fetchPhase(id) {
  if (id >= 100000) {
    // Gym contest: ask for a one-row standings table, which carries the contest phase.
    const data = await fetchJson(`https://codeforces.com/api/contest.standings?contestId=${id}&from=1&count=1`);
    return data.status === 'OK' ? data.result.contest.phase : 'UNKNOWN';
  }
  const data = await fetchJson('https://codeforces.com/api/contest.list?gym=false');
  if (data.status !== 'OK') return 'UNKNOWN';
  const entries = {};
  let answer = 'UNKNOWN';
  for (const contest of data.result) {
    if (contest.id === id) answer = contest.phase;
    // Remember every finished contest so later lookups need no network call.
    if (contest.phase === 'FINISHED') entries['phase:' + contest.id] = { phase: 'FINISHED', at: Date.now() };
  }
  await chrome.storage.local.set(entries);
  return answer;
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Unexpected response from ${new URL(url).host} (HTTP ${res.status})`);
  }
}

// A problem may be shown only when its contest is over. If the API can't be
// reached, trust problemset pages (they only list finished contests) and the
// contest page's own status box.
function phaseAllows(phase, problem) {
  if (phase === 'FINISHED') return true;
  return phase === 'UNKNOWN' && (problem.kind === 'problemset' || problem.pageSaysFinished === true);
}

function pausedReply(phase) {
  return { status: 'paused', reason: phase === 'UNKNOWN' ? 'unknown' : 'running' };
}

// ---------------------------------------------------------------- library
function cacheKey(problem) {
  return 'c:' + problem.contestId + String(problem.index).toUpperCase();
}

async function fetchLibraryEntry(base, problem) {
  const url = `${base}/problems/${encodeURIComponent(problem.contestId)}/${encodeURIComponent(String(problem.index).toUpperCase())}.json`;
  const res = await fetch(url, { cache: 'no-cache' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`The library answered with HTTP ${res.status}.`);
  const data = await res.json();
  return data && typeof data.simplified === 'string' && data.simplified.trim() ? data : null;
}

async function lookup(problem) {
  const settings = await getSettings();
  const key = cacheKey(problem);
  const saved = (await chrome.storage.local.get(key))[key];
  if (saved && (saved.source !== 'library' || Date.now() - saved.savedAt < LIBRARY_TTL_MS)) {
    return { status: 'ok', ...saved, reportUrl: settings.reportUrl };
  }

  let libraryError = '';
  if (settings.libraryUrl) {
    try {
      const entry = await fetchLibraryEntry(settings.libraryUrl, problem);
      if (entry) {
        const record = {
          simplified: entry.simplified,
          source: 'library',
          model: entry.model || '',
          warnings: Array.isArray(entry.warnings) ? entry.warnings : [],
          savedAt: Date.now()
        };
        await chrome.storage.local.set({ [key]: record });
        return { status: 'ok', ...record, reportUrl: settings.reportUrl };
      }
    } catch (err) {
      libraryError = err.message || String(err);
    }
  }
  if (saved) return { status: 'ok', ...saved, reportUrl: settings.reportUrl };

  return {
    status: 'missing',
    canConvert: Boolean(settings.llm),
    autoConvert: settings.autoConvert,
    libraryConfigured: Boolean(settings.libraryUrl),
    libraryError
  };
}

// ---------------------------------------------------------------- personal-key conversion
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

async function callChat(llm, messages) {
  const url = llm.baseUrl + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (llm.apiKey) headers.Authorization = 'Bearer ' + llm.apiKey;
  if (llm.provider === 'openrouter') headers['X-Title'] = 'CF Simplify';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: llm.model, messages, temperature: 0.2 }),
      signal: controller.signal
    });
  } catch (err) {
    const host = safeHost(url);
    throw new Error(err.name === 'AbortError'
      ? `${host} took too long to answer. Try again.`
      : `Couldn't reach ${host}. Check your connection and the base URL in Settings.`);
  } finally {
    clearTimeout(timer);
  }

  const body = await res.text();
  if (!res.ok) throw new Error(describeHttpError(res.status, body, llm));
  let data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    throw new Error('The AI service sent a response that is not JSON.');
  }
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const text = Array.isArray(content)
    ? content.map((part) => (typeof part === 'string' ? part : part.text || '')).join('')
    : String(content || '');
  const cleaned = CFSChecks.cleanOutput(text);
  if (!cleaned) throw new Error('The AI service returned an empty answer. Try again.');
  return cleaned;
}

function safeHost(url) {
  try { return new URL(url).host; } catch (err) { return url; }
}

function describeHttpError(status, body, llm) {
  const detail = extractErrorMessage(body);
  if (status === 401 || status === 403) return `Your API key was rejected (HTTP ${status}). Check it in Settings.${detail ? ' ' + detail : ''}`;
  if (status === 404) return `Model "${llm.model}" or the endpoint was not found (HTTP 404). Check the model name in Settings.`;
  if (status === 429) {
    return /per[\s_-]?day|perday|\bRPD\b|daily/i.test(body)
      ? 'Your key has used its free requests for today. Try again tomorrow or use another provider.'
      : 'Too many requests for your key right now. Wait a minute and try again.';
  }
  if (status === 400) return `The AI service rejected the request (HTTP 400).${detail ? ' ' + detail : ''}`;
  return `The AI service answered with HTTP ${status}.${detail ? ' ' + detail : ''}`;
}

function extractErrorMessage(body) {
  try {
    let data = JSON.parse(body);
    if (Array.isArray(data)) data = data[0];
    const msg = (data && data.error && (data.error.message || data.error)) || (data && data.message) || '';
    return typeof msg === 'string' ? msg.slice(0, 300) : '';
  } catch (err) {
    return '';
  }
}

async function convert(problem, statement) {
  const phase = await contestPhase(problem.contestId);
  if (!phaseAllows(phase, problem)) return pausedReply(phase);
  const settings = await getSettings();
  if (!settings.llm) {
    return { status: 'error', message: 'Add an API key in Settings to simplify problems that are not in the library yet.' };
  }
  const llm = settings.llm;
  if (!statement || statement.length < 20) {
    return { status: 'error', message: "Couldn't read the statement on this page." };
  }

  return enqueue(async () => {
    const [prompt, terms] = await Promise.all([systemPrompt(), hintTerms()]);
    const messages = [
      { role: 'system', content: prompt },
      { role: 'user', content: CFSChecks.buildUserMessage(problem, statement) }
    ];
    let output = await callChat(llm, messages);
    let issues = CFSChecks.runChecks(statement, output, terms);
    if (CFSChecks.hasIssues(issues)) {
      messages.push({ role: 'assistant', content: output }, { role: 'user', content: CFSChecks.feedback(issues) });
      output = await callChat(llm, messages);
      issues = CFSChecks.runChecks(statement, output, terms);
    }
    const record = {
      simplified: output,
      source: 'personal',
      model: llm.model,
      warnings: issues.missing.length ? ['missing-limits'] : [],
      savedAt: Date.now()
    };
    if (issues.hints.length) return { status: 'flagged', ...record };
    await chrome.storage.local.set({ [cacheKey(problem)]: record });
    return { status: 'ok', ...record };
  });
}

async function testConnection(config) {
  const preset = CFS_PROVIDERS[config.provider];
  if (!preset) return { ok: false, message: 'Choose a provider first.' };
  const llm = resolveLlm(config.provider, config);
  if (!llm) {
    if (preset.needsKey && !String(config.apiKey || '').trim()) return { ok: false, message: 'Enter an API key first.' };
    return { ok: false, message: 'Enter a model name (and base URL) first.' };
  }
  try {
    const reply = await callChat(llm, [{ role: 'user', content: 'Reply with the single word OK.' }]);
    return { ok: true, message: `Connected. ${llm.model} replied: ${reply.slice(0, 40)}` };
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  }
}

// ---------------------------------------------------------------- messages
const handlers = {
  async 'cfs:prefs'() {
    const s = await getSettings();
    return { defaultView: s.defaultView, autoConvert: s.autoConvert, canConvert: Boolean(s.llm) };
  },
  async 'cfs:setView'(msg) {
    if (msg.view === 'simplified' || msg.view === 'original') await chrome.storage.sync.set({ defaultView: msg.view });
    return { ok: true };
  },
  async 'cfs:phase'(msg) {
    return { phase: await contestPhase(msg.contestId) };
  },
  async 'cfs:get'(msg) {
    const phase = await contestPhase(msg.problem.contestId);
    if (!phaseAllows(phase, msg.problem)) return pausedReply(phase);
    return lookup(msg.problem);
  },
  async 'cfs:convert'(msg) {
    return convert(msg.problem, msg.statement);
  },
  async 'cfs:test'(msg) {
    return testConnection(msg.config || {});
  },
  async 'cfs:openOptions'() {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && handlers[msg.type];
  if (!handler) return false;
  handler(msg, sender).then(sendResponse, (err) => sendResponse({ status: 'error', message: err.message || String(err) }));
  return true; // keep the channel open for the async answer
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install') return;
  const cfg = await bundledConfig();
  if (!cfg.libraryUrl) chrome.runtime.openOptionsPage(); // developer build: help with first setup
});
