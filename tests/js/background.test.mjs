import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { EXT, read, storageArea } from './helpers.mjs';

// ------------------------------------------------------------------ MathJax bridge
function bridgePage(makeMathJax) {
  const { window } = new JSDOM('<!doctype html><body><div id="box"></div></body>', { runScripts: 'outside-only' });
  if (makeMathJax) window.MathJax = makeMathJax(window);
  window.eval(read(path.join(EXT, 'content', 'mathjax-bridge.js')));
  const box = window.document.getElementById('box');
  box.innerHTML = '<span class="cfs-math" data-tex="a_i \\le 10^9" data-display="0">fallback</span>' +
    '<span class="cfs-math cfs-math-display" data-tex="\\sum a_i" data-display="1">fallback</span>';
  window.document.dispatchEvent(new window.CustomEvent('cfs:typeset', { detail: 'box' }));
  return { window, box };
}

test('bridge hands math to MathJax 2 as script tags', () => {
  const queued = [];
  const { box } = bridgePage(() => ({ Hub: { Queue: (job) => queued.push(job) } }));
  const scripts = [...box.querySelectorAll('script')];
  assert.deepEqual(scripts.map((s) => [s.type, s.text]), [['math/tex', 'a_i \\le 10^9'], ['math/tex; mode=display', '\\sum a_i']]);
  assert.equal(queued.length, 1);
  assert.equal(queued[0][0], 'Typeset');
  assert.equal(queued[0][2].id, 'box');
});

test('bridge supports MathJax 3 and leaves the fallback when MathJax is missing', () => {
  const calls = [];
  const { box } = bridgePage((win) => ({
    tex2chtml: (tex, opts) => { calls.push([tex, opts.display]); const n = win.document.createElement('mjx-container'); n.textContent = 'M'; return n; },
    startup: { document: { clear() {}, updateDocument() {} } }
  }));
  assert.deepEqual(calls, [['a_i \\le 10^9', false], ['\\sum a_i', true]]);
  assert.equal(box.querySelectorAll('mjx-container').length, 2);
  const plain = bridgePage(null).box;
  assert.equal(plain.querySelectorAll('.cfs-math')[0].textContent, 'fallback');
});

// ------------------------------------------------------------------ background service worker
const sync = storageArea();
const local = storageArea();
let listener = null;
let optionsOpened = 0;
const net = { calls: [], library: {}, llm: [], phaseList: null, failCodeforces: false };

globalThis.chrome = {
  storage: { sync, local },
  runtime: {
    getURL: (p) => 'chrome-extension://test/' + p,
    onMessage: { addListener: (fn) => { listener = fn; } },
    onInstalled: { addListener() {} },
    openOptionsPage: async () => { optionsOpened++; }
  },
  action: { onClicked: { addListener() {} } }
};
globalThis.importScripts = (...files) => {
  for (const f of files) vm.runInThisContext(read(path.join(EXT, f)), { filename: f });
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  net.calls.push({ url, init });
  if (url.startsWith('chrome-extension://test/')) {
    return new Response(fs.readFileSync(path.join(EXT, url.slice('chrome-extension://test/'.length))));
  }
  if (url.startsWith('https://codeforces.com/api/')) {
    if (net.failCodeforces) throw new TypeError('Failed to fetch');
    if (url.includes('contest.list')) return json({ status: 'OK', result: net.phaseList });
    if (url.includes('contest.standings')) return json({ status: 'OK', result: { contest: { id: 100500, phase: 'FINISHED' } } });
  }
  if (url.startsWith('https://lib.example.github.io/cfs/')) {
    const entry = net.library[url.slice('https://lib.example.github.io/cfs/'.length)];
    return entry ? json(entry) : new Response('<h1>404</h1>', { status: 404 });
  }
  if (url === 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions') {
    const next = net.llm.shift();
    if (!next) throw new Error('unexpected LLM call');
    return next.status ? json(next.body, next.status) : json({ choices: [{ message: { content: next } }] });
  }
  throw new Error('unexpected fetch ' + url);
};

vm.runInThisContext(read(path.join(EXT, 'background.js')), { filename: 'background.js' });

function send(msg) {
  return new Promise((resolve) => {
    const keepOpen = listener(msg, {}, resolve);
    assert.equal(keepOpen, true);
  });
}
const llmCalls = () => net.calls.filter((c) => c.url.includes('chat/completions'));
const problem = (index, contestId = 1234, kind = 'contest') => ({ contestId, index, name: 'Test', kind });

const CLEAN = '## Task\nGiven $n$, print it.\n\n## Input\n- $n$ ($1 \\le n \\le 10^9$).\n\n## Output\n- $n$.';
const HINTED = CLEAN.replace('print it', 'use a greedy idea and print it');
const STATEMENT = 'Story.\n\n### Input\n\nOne integer $n$ ($1 \\le n \\le 10^9$).\n\n### Output\n\nPrint $n$.';

test.beforeEach(() => {
  net.calls.length = 0;
  net.phaseList = [
    { id: 1234, phase: 'FINISHED' },
    { id: 1300, phase: 'CODING' }
  ];
  net.failCodeforces = false;
});

test('contest phases come from the API and finished ones are remembered', async () => {
  assert.deepEqual(await send({ type: 'cfs:phase', contestId: 1234 }), { phase: 'FINISHED' });
  assert.equal(local.data['phase:1234'].phase, 'FINISHED');
  const before = net.calls.length;
  assert.deepEqual(await send({ type: 'cfs:phase', contestId: 1234 }), { phase: 'FINISHED' });
  assert.equal(net.calls.length, before, 'no second API call');
  assert.deepEqual(await send({ type: 'cfs:phase', contestId: 1300 }), { phase: 'CODING' });
  assert.deepEqual(await send({ type: 'cfs:phase', contestId: 100500 }), { phase: 'FINISHED' }, 'gym via standings');
  net.failCodeforces = true;
  assert.deepEqual(await send({ type: 'cfs:phase', contestId: 4321 }), { phase: 'UNKNOWN' });
});

test('nothing is served for a running contest', async () => {
  const paused = { status: 'paused', reason: 'running' };
  assert.deepEqual(await send({ type: 'cfs:get', problem: problem('A', 1300) }), paused);
  assert.deepEqual(await send({ type: 'cfs:convert', problem: problem('A', 1300), statement: STATEMENT }), paused);
});

test('when the API is down, only problemset pages or a finished status box are trusted', async () => {
  net.failCodeforces = true;
  assert.deepEqual(await send({ type: 'cfs:get', problem: problem('A', 5555) }), { status: 'paused', reason: 'unknown' });
  assert.equal((await send({ type: 'cfs:get', problem: { ...problem('A', 5556), pageSaysFinished: true } })).status, 'missing');
  assert.equal((await send({ type: 'cfs:get', problem: problem('A', 5557, 'problemset') })).status, 'missing');
});

test('without a library or key the page is told what is missing', async () => {
  const res = await send({ type: 'cfs:get', problem: problem('A') });
  assert.deepEqual(res, { status: 'missing', canConvert: false, autoConvert: true, libraryConfigured: false, libraryError: '' });
  assert.deepEqual(await send({ type: 'cfs:prefs' }), { defaultView: 'simplified', autoConvert: true, canConvert: false });
});

test('library entries are fetched once and then served from the cache', async () => {
  await sync.set({ libraryUrl: 'https://lib.example.github.io/cfs/' });
  net.library['problems/1234/A.json'] = { id: '1234A', simplified: CLEAN, model: 'gemini-flash-latest', warnings: [] };
  const res = await send({ type: 'cfs:get', problem: problem('A') });
  assert.equal(res.status, 'ok');
  assert.equal(res.source, 'library');
  assert.equal(res.simplified, CLEAN);
  assert.ok(net.calls.some((c) => c.url === 'https://lib.example.github.io/cfs/problems/1234/A.json'));
  net.calls.length = 0;
  assert.equal((await send({ type: 'cfs:get', problem: problem('A') })).source, 'library');
  assert.equal(net.calls.filter((c) => c.url.startsWith('https://lib.')).length, 0, 'served from the cache');
  const missing = await send({ type: 'cfs:get', problem: problem('B') });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.libraryConfigured, true);
});

test('with a key, a missing problem is simplified, checked, retried once and cached', async () => {
  await sync.set({ provider: 'gemini' });
  await local.set({ providerSettings: { gemini: { apiKey: 'AIza-test', model: '' } } });
  assert.equal((await send({ type: 'cfs:prefs' })).canConvert, true);
  assert.equal((await send({ type: 'cfs:get', problem: problem('C') })).canConvert, true);

  net.llm.push(HINTED, CLEAN);
  const res = await send({ type: 'cfs:convert', problem: problem('C'), statement: STATEMENT });
  assert.equal(res.status, 'ok');
  assert.equal(res.simplified, CLEAN);
  assert.equal(res.model, 'gemini-flash-latest');
  const [first, second] = llmCalls();
  assert.equal(first.init.headers.Authorization, 'Bearer AIza-test');
  const body = JSON.parse(first.init.body);
  assert.equal(body.model, 'gemini-flash-latest');
  assert.equal(body.messages[0].content, read(path.join(EXT, 'prompt.txt')));
  assert.ok(body.messages[1].content.includes('Problem: 1234C "Test"'));
  assert.ok(JSON.parse(second.init.body).messages.at(-1).content.includes('"greedy"'));

  net.calls.length = 0;
  const cached = await send({ type: 'cfs:get', problem: problem('C') });
  assert.equal(cached.source, 'personal');
  assert.equal(llmCalls().length, 0);
});

test('a rewrite that keeps hinting is returned as flagged and not saved', async () => {
  net.llm.push(HINTED, HINTED);
  const res = await send({ type: 'cfs:convert', problem: problem('D'), statement: STATEMENT });
  assert.equal(res.status, 'flagged');
  assert.equal(local.data['c:1234D'], undefined);
});

test('provider errors become plain-language messages', async () => {
  net.llm.push({ status: 401, body: { error: { message: 'API key not valid.' } } });
  let res = await send({ type: 'cfs:convert', problem: problem('E'), statement: STATEMENT });
  assert.equal(res.status, 'error');
  assert.match(res.message, /API key was rejected.*API key not valid/);
  net.llm.push({ status: 429, body: { error: { message: 'Quota exceeded for metric GenerateRequestsPerDayPerProjectPerModel-FreeTier' } } });
  res = await send({ type: 'cfs:convert', problem: problem('E'), statement: STATEMENT });
  assert.match(res.message, /free requests for today/);
});

test('settings page helpers: connection test and opening settings', async () => {
  net.llm.push('OK');
  let res = await send({ type: 'cfs:test', config: { provider: 'gemini', apiKey: 'k' } });
  assert.equal(res.ok, true);
  res = await send({ type: 'cfs:test', config: { provider: 'gemini', apiKey: '' } });
  assert.deepEqual(res, { ok: false, message: 'Enter an API key first.' });
  res = await send({ type: 'cfs:test', config: { provider: 'openrouter', apiKey: 'k' } });
  assert.equal(res.ok, false, 'OpenRouter needs a model name');
  await send({ type: 'cfs:openOptions' });
  assert.equal(optionsOpened, 1);
  await send({ type: 'cfs:setView', view: 'original' });
  assert.equal(sync.data.defaultView, 'original');
});
