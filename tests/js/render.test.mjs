import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { EXT, fixture, read, squash } from './helpers.mjs';

vm.runInThisContext(read(path.join(EXT, 'shared', 'checks.js')), { filename: 'checks.js' });
const terms = JSON.parse(read(path.join(EXT, 'shared', 'hint-terms.json')));
const { CFSChecks } = globalThis;

test('checker agrees with the Python checker on every shared case', () => {
  for (const c of JSON.parse(fixture('check_cases.json'))) {
    const issues = CFSChecks.runChecks(c.original, c.output, terms);
    assert.deepEqual(issues.hints, c.hints, c.name + ' (hints)');
    assert.deepEqual(issues.missing, c.missing, c.name + ' (missing)');
    assert.deepEqual(issues.format, c.format, c.name + ' (format)');
  }
});

test('checker cleans model output and builds the same user message', () => {
  assert.equal(CFSChecks.cleanOutput('<think>x</think>\n```md\n## Task\nA\n```'), '## Task\nA');
  const msg = CFSChecks.buildUserMessage({ contestId: 4, index: 'A', name: 'Watermelon' }, '  body ');
  assert.ok(msg.includes('Problem: 4A "Watermelon"'));
  assert.ok(msg.endsWith('<statement>\nbody\n</statement>'));
  assert.equal(CFSChecks.numberValues('$2 \\cdot 10^{18}$').get('2000000000000000000'), '2*10^18');
});

function renderWindow(html = '<!doctype html><body></body>') {
  const { window } = new JSDOM(html, { runScripts: 'outside-only' });
  window.eval(read(path.join(EXT, 'content', 'render.js')));
  return window;
}

test('reads the statement from a MathJax-rendered page exactly like the builder does', () => {
  const window = renderWindow(fixture('modern_problem.rendered.html'));
  const text = window.CFS.extractStatement(window.document.querySelector('.problem-statement'));
  const golden = fixture('modern_problem.expected.txt').split('\n').slice(1).join('\n'); // drop "[B] name" line
  assert.equal(squash(text), squash(golden));
  assert.ok(!text.includes('RENDERED'), 'rendered MathJax output must be ignored');
});

test('reads raw $$$ math and old-style markup', () => {
  let window = renderWindow(fixture('modern_problem.html'));
  let text = window.CFS.extractStatement(window.document.querySelector('.problem-statement'));
  assert.ok(text.includes('$1 \\le n \\le 2 \\cdot 10^5$'));
  window = renderWindow(fixture('old_problem.html'));
  text = window.CFS.extractStatement(window.document.querySelector('.problem-statement'));
  const golden = fixture('old_problem.expected.txt').split('\n').slice(1).join('\n');
  assert.equal(squash(text), squash(golden));
});

test('renders the simplified Markdown with headings, nested lists and math', () => {
  const window = renderWindow();
  const md = [
    '## Task',
    'Given an array $a$ of $n$ integers, print **one** number.',
    '',
    '## Details',
    '- First rule with `code`.',
    '  - Nested rule $a_i \\ne 0$.',
    '- Second rule.',
    '',
    '$$S = \\sum_{i=1}^{n} a_i$$',
    '',
    '1. step one',
    '2. step two'
  ].join('\n');
  const box = window.document.createElement('div');
  box.innerHTML = window.CFS.renderMarkdown(md);
  const headings = [...box.querySelectorAll('h4.cfs-h')].map((h) => h.textContent);
  assert.deepEqual(headings, ['Task', 'Details']);
  assert.equal(box.querySelectorAll('ul').length, 2);
  assert.equal(box.querySelector('ul ul li').textContent.includes('Nested rule'), true);
  assert.equal(box.querySelectorAll('ol li').length, 2);
  assert.equal(box.querySelector('strong').textContent, 'one');
  assert.equal(box.querySelector('code').textContent, 'code');
  const maths = [...box.querySelectorAll('.cfs-math')];
  assert.deepEqual(maths.map((m) => m.getAttribute('data-tex')),
    ['a', 'n', 'a_i \\ne 0', 'S = \\sum_{i=1}^{n} a_i']);
  assert.equal(maths[3].getAttribute('data-display'), '1');
  assert.ok(maths[3].classList.contains('cfs-math-display'));
});

test('escapes everything that is not our own markup', () => {
  const window = renderWindow();
  const box = window.document.createElement('div');
  box.innerHTML = window.CFS.renderMarkdown('## Task\n<img src=x onerror="alert(1)"> and $"><script>x</script>$ **<b>bold</b>**');
  assert.equal(box.querySelector('img'), null);
  assert.equal(box.querySelector('script'), null);
  assert.equal(box.querySelector('b'), null);
  assert.ok(box.textContent.includes('<img src=x onerror="alert(1)">'));
  assert.equal(box.querySelector('.cfs-math').getAttribute('data-tex'), '"><script>x</script>');
});

test('TeX fallback is readable when MathJax is not available', () => {
  const { CFS } = renderWindow();
  assert.equal(CFS.texToHtml('1 \\le n \\le 2 \\cdot 10^5'), '1 ≤ n ≤ 2 · 10<sup>5</sup>');
  assert.equal(CFS.texToHtml('a_{i+1} \\oplus b'), 'a<sub>i+1</sub> ⊕ b');
  assert.equal(CFS.texToHtml('\\frac{n}{2}'), '(n)/(2)');
  assert.equal(CFS.texToHtml('\\text{if } x<y'), '<span class="cfs-tex-text">if </span> x&lt;y');
  assert.equal(CFS.texToHtml('\\left\\lfloor \\frac{a}{b} \\right\\rfloor'), '⌊ (a)/(b) ⌋');
});
