import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, openProblemPage, settle } from './helpers.mjs';

const PAGE = fixture('modern_problem.rendered.html');
const URL_B = 'https://codeforces.com/contest/1234/problem/B';
const SIMPLE = '## Task\nGiven an array $a$ of $n$ integers, print the minimum number of adjacent swaps that make it non-decreasing.\n\n## Input\n- $t$ ($1 \\le t \\le 10^4$).\n\n## Output\n- One integer per test case.';

function background(overrides = {}) {
  return (msg) => {
    if (overrides[msg.type]) return overrides[msg.type](msg);
    switch (msg.type) {
      case 'cfs:prefs': return { defaultView: 'simplified', autoConvert: true, canConvert: false };
      case 'cfs:phase': return { phase: 'FINISHED' };
      case 'cfs:get': return { status: 'ok', simplified: SIMPLE, source: 'library', model: 'm', warnings: [], reportUrl: 'https://github.com/alice/cf-simplify/issues/new' };
      default: return { ok: true };
    }
  };
}

const storyOf = (document) => ({
  legend: document.querySelector('.problem-statement > .cfs-card + div'),
  input: document.querySelector('.input-specification'),
  output: document.querySelector('.output-specification'),
  samples: document.querySelector('.sample-tests'),
  note: document.querySelector('.note')
});

test('shows the library version in place of the story, and switches back', async () => {
  const { document, sent, typeset } = await openProblemPage({ html: PAGE, url: URL_B, answer: background() });
  const card = document.querySelector('.cfs-card');
  assert.ok(card, 'card mounted');
  assert.equal(card.previousElementSibling.className, 'header', 'card sits right under the title block');
  assert.deepEqual(sent.find((m) => m.type === 'cfs:get').problem, { contestId: 1234, index: 'B', name: 'Lantern Festival', kind: 'contest', pageSaysFinished: true });

  const body = card.querySelector('.cfs-body');
  assert.deepEqual([...body.querySelectorAll('h4')].map((h) => h.textContent), ['Task', 'Input', 'Output']);
  assert.equal(typeset[0], body.id, 'asked MathJax to typeset the card');
  const story = storyOf(document);
  for (const key of ['legend', 'input', 'output']) assert.ok(story[key].classList.contains('cfs-hidden'), key + ' hidden');
  for (const key of ['samples', 'note']) assert.ok(!story[key].classList.contains('cfs-hidden'), key + ' still visible');

  const foot = card.querySelector('.cfs-foot');
  assert.ok(foot.textContent.includes('From the shared library.'));
  const report = foot.querySelector('a');
  assert.ok(report.href.startsWith('https://github.com/alice/cf-simplify/issues/new?title=Mistake%20in%201234B'));

  const [simplifiedBtn, originalBtn] = card.querySelectorAll('.cfs-toggle button');
  assert.equal(simplifiedBtn.getAttribute('aria-pressed'), 'true');
  originalBtn.click();
  assert.equal(originalBtn.getAttribute('aria-pressed'), 'true');
  assert.ok(body.hidden && foot.hidden);
  for (const key of ['legend', 'input', 'output']) assert.ok(!story[key].classList.contains('cfs-hidden'));
  assert.deepEqual(sent.at(-1), { type: 'cfs:setView', view: 'original' });
  simplifiedBtn.click();
  assert.ok(!body.hidden && story.legend.classList.contains('cfs-hidden'));
});

test('pauses during a running contest and never asks for the text', async () => {
  const { document, sent } = await openProblemPage({
    html: PAGE, url: URL_B, answer: background({ 'cfs:phase': () => ({ phase: 'CODING' }) })
  });
  const card = document.querySelector('.cfs-card');
  assert.ok(card.textContent.includes('Paused during this contest'));
  assert.ok(card.classList.contains('cfs-paused'));
  assert.equal(sent.some((m) => m.type === 'cfs:get' || m.type === 'cfs:convert'), false);
  assert.ok(!storyOf(document).legend.classList.contains('cfs-hidden'));
  assert.ok(card.querySelector('.cfs-toggle').hidden);
});

test('when the API cannot be reached it trusts the sidebar, and otherwise stays paused', async () => {
  const unknown = { 'cfs:phase': () => ({ phase: 'UNKNOWN' }) };
  let page = await openProblemPage({ html: PAGE, url: URL_B, answer: background(unknown) }); // sidebar says Finished
  assert.ok(page.sent.some((m) => m.type === 'cfs:get'));

  const noSidebar = PAGE.replace('<span class="contest-state-phase">Finished</span>', '');
  page = await openProblemPage({ html: noSidebar, url: URL_B, answer: background(unknown) });
  assert.ok(page.document.querySelector('.cfs-card').textContent.includes("couldn't confirm"));
  assert.equal(page.sent.some((m) => m.type === 'cfs:get'), false);

  page = await openProblemPage({ html: noSidebar, url: 'https://codeforces.com/problemset/problem/1234/B', answer: background(unknown) });
  assert.ok(page.sent.some((m) => m.type === 'cfs:get'), 'problemset pages only list finished contests');
});

test('missing problem without a key points to settings', async () => {
  const { document, sent } = await openProblemPage({
    html: PAGE, url: URL_B,
    answer: background({ 'cfs:get': () => ({ status: 'missing', canConvert: false, libraryConfigured: true }) })
  });
  const card = document.querySelector('.cfs-card');
  assert.ok(card.textContent.includes('not in the shared library yet'));
  card.querySelector('.cfs-btn').click();
  assert.deepEqual(sent.at(-1), { type: 'cfs:openOptions' });
});

test('missing problem with a key is simplified automatically from the page text', async () => {
  const { document, sent } = await openProblemPage({
    html: PAGE, url: URL_B,
    answer: background({
      'cfs:get': () => ({ status: 'missing', canConvert: true, autoConvert: true, libraryConfigured: true }),
      'cfs:convert': () => ({ status: 'ok', simplified: SIMPLE, source: 'personal', model: 'gemini-flash-latest', warnings: ['missing-limits'] })
    })
  });
  const convert = sent.find((m) => m.type === 'cfs:convert');
  assert.ok(convert.statement.includes('$1 \\le t \\le 10^4$'));
  assert.ok(!convert.statement.includes('RENDERED'));
  const card = document.querySelector('.cfs-card');
  assert.ok(card.querySelector('.cfs-foot').textContent.includes('Simplified with your API key (gemini-flash-latest).'));
  assert.equal(card.querySelector('.cfs-foot a'), null, 'no report link for personal results');
  assert.ok(card.querySelector('.cfs-note').textContent.includes('Some limits'));
});

test('a manual button appears when automatic simplification is off', async () => {
  let converted = false;
  const { document } = await openProblemPage({
    html: PAGE, url: URL_B,
    answer: background({
      'cfs:get': () => ({ status: 'missing', canConvert: true, autoConvert: false, libraryConfigured: false }),
      'cfs:convert': () => { converted = true; return { status: 'ok', simplified: SIMPLE, source: 'personal', model: 'x', warnings: [] }; }
    })
  });
  const card = document.querySelector('.cfs-card');
  assert.equal(converted, false);
  card.querySelector('.cfs-btn-primary').click();
  await settle();
  assert.equal(converted, true);
  assert.ok(card.querySelector('h4'));
});

test('a flagged result stays hidden until the person asks for it', async () => {
  const { document } = await openProblemPage({
    html: PAGE, url: URL_B,
    answer: background({
      'cfs:get': () => ({ status: 'missing', canConvert: true, autoConvert: true }),
      'cfs:convert': () => ({ status: 'flagged', simplified: SIMPLE, source: 'personal', model: 'x', warnings: [] })
    })
  });
  const card = document.querySelector('.cfs-card');
  assert.ok(card.textContent.includes('could hint at a solution'));
  assert.equal(card.querySelector('h4'), null);
  [...card.querySelectorAll('.cfs-btn')].find((b) => b.textContent === 'Show it anyway').click();
  assert.ok(card.querySelector('h4'));
});

test('errors offer a retry', async () => {
  let calls = 0;
  const { document } = await openProblemPage({
    html: PAGE, url: URL_B,
    answer: background({ 'cfs:get': () => (++calls === 1 ? { status: 'error', message: 'Network down.' } : { status: 'ok', simplified: SIMPLE, source: 'library', warnings: [] }) })
  });
  const card = document.querySelector('.cfs-card');
  assert.ok(card.textContent.includes('Network down.'));
  card.querySelector('.cfs-btn').click();
  await settle();
  assert.equal(calls, 2);
  assert.ok(card.querySelector('h4'));
});

test('respects "show original first"', async () => {
  const { document } = await openProblemPage({
    html: PAGE, url: URL_B,
    answer: background({ 'cfs:prefs': () => ({ defaultView: 'original', autoConvert: true }) })
  });
  const card = document.querySelector('.cfs-card');
  assert.ok(card.querySelector('.cfs-body').hidden);
  assert.ok(!storyOf(document).legend.classList.contains('cfs-hidden'));
  assert.equal(card.querySelectorAll('.cfs-toggle button')[1].getAttribute('aria-pressed'), 'true');
});

test('adds one card per problem on the complete-problemset page', async () => {
  const { document, sent } = await openProblemPage({
    html: fixture('contest_problems.html'), url: 'https://codeforces.com/contest/1234/problems', answer: background()
  });
  assert.equal(document.querySelectorAll('.cfs-card').length, 2);
  assert.deepEqual(sent.filter((m) => m.type === 'cfs:get').map((m) => m.problem.index), ['A', 'B']);
});

test('does nothing on pages that are not problems', async () => {
  const { document, sent } = await openProblemPage({
    html: PAGE, url: 'https://codeforces.com/contest/1234/standings', answer: background()
  });
  assert.equal(document.querySelector('.cfs-card'), null);
  assert.equal(sent.length, 0);
});
