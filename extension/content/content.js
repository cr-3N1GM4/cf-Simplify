/* CF Simplify content script.
   Adds a "Simplified statement" card to Codeforces problem pages, with a
   Simplified / Original switch. Pauses itself while the contest is running. */
(() => {
  'use strict';
  const CFS = globalThis.CFS;
  if (!CFS || globalThis.__cfsStarted) return;
  globalThis.__cfsStarted = true;

  // ---------------------------------------------------------------- routes
  const ROUTES = [
    [/^\/problemset\/problem\/(\d+)\/([A-Za-z0-9]+)\/?$/, 'problemset'],
    [/^\/problemset\/gymProblem\/(\d+)\/([A-Za-z0-9]+)\/?$/, 'gym'],
    [/^\/contest\/(\d+)\/problem\/([A-Za-z0-9]+)\/?$/, 'contest'],
    [/^\/gym\/(\d+)\/problem\/([A-Za-z0-9]+)\/?$/, 'gym'],
    [/^\/contest\/(\d+)\/problems\/?$/, 'contest'],
    [/^\/gym\/(\d+)\/problems\/?$/, 'gym']
  ];

  function parseRoute(pathname) {
    for (const [re, kind] of ROUTES) {
      const m = pathname.match(re);
      if (m) return { kind, contestId: Number(m[1]), index: m[2] ? m[2].toUpperCase() : '' };
    }
    return null;
  }

  // ---------------------------------------------------------------- messaging
  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ status: 'error', message: 'The extension is not responding. Reload the page.' });
          } else {
            resolve(response || { status: 'error', message: 'The extension sent no answer. Reload the page.' });
          }
        });
      } catch (err) {
        resolve({ status: 'error', message: 'The extension was updated. Reload the page to use it.' });
      }
    });
  }

  // ---------------------------------------------------------------- page reading
  function findProblems(route) {
    const holders = Array.from(document.querySelectorAll('.problemindexholder'));
    const pairs = holders.length
      ? holders.map((h) => [h, h.querySelector('.problem-statement')])
      : Array.from(document.querySelectorAll('.problem-statement')).map((st) => [null, st]);
    const found = [];
    for (const [holder, statement] of pairs) {
      if (!statement || statement.querySelector(':scope > .cfs-card')) continue;
      const title = (statement.querySelector('.header .title') || {}).textContent || '';
      const m = title.trim().match(/^([A-Za-z]\d*)\s*\.\s*(.*)$/);
      const index = ((holder && holder.getAttribute('problemindex')) || (m && m[1]) || route.index || '').toUpperCase();
      if (!index) continue;
      found.push({ statement, index, name: m ? m[2].trim() : title.trim() });
    }
    return found;
  }

  // Text of the contest status box in the sidebar, used only when the API can't be reached.
  function domPhase() {
    const el = document.querySelector('.contest-state-phase');
    if (!el) return null;
    const text = el.textContent.trim().toLowerCase();
    if (!text) return null;
    if (/finished|final standings|practice|закончен|завершен|дорешивание/.test(text)) return 'finished';
    return 'active';
  }

  async function checkGate(route) {
    const res = await send({ type: 'cfs:phase', contestId: route.contestId });
    const phase = (res && res.phase) || 'UNKNOWN';
    if (phase === 'FINISHED') return { open: true };
    if (phase !== 'UNKNOWN') return { open: false, reason: 'running' };
    const dom = domPhase();
    if (dom === 'finished') return { open: true };
    if (dom === 'active') return { open: false, reason: 'running' };
    if (route.kind === 'problemset') return { open: true };
    return { open: false, reason: 'unknown' };
  }

  // ---------------------------------------------------------------- small DOM helper
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const child of children) if (child) node.append(child);
    return node;
  }

  let uid = 0;

  // ---------------------------------------------------------------- the card
  class Card {
    constructor(problem, route, prefs) {
      this.problem = problem;
      this.route = route;
      this.prefs = prefs;
      this.view = prefs.defaultView === 'original' ? 'original' : 'simplified';
      this.result = null;

      uid += 1;
      this.bodyId = 'cfs-body-' + problem.index + '-' + uid;
      this.buttons = {
        simplified: el('button', { type: 'button', 'aria-pressed': 'false', onclick: () => this.choose('simplified') }, 'Simplified'),
        original: el('button', { type: 'button', 'aria-pressed': 'false', onclick: () => this.choose('original') }, 'Original')
      };
      this.toggle = el('div', { class: 'cfs-toggle', role: 'group', 'aria-label': 'Statement view' },
        this.buttons.simplified, this.buttons.original);
      this.toggle.hidden = true;
      this.body = el('div', { class: 'cfs-body', id: this.bodyId, 'aria-live': 'polite' });
      this.foot = el('div', { class: 'cfs-foot' });
      this.foot.hidden = true;
      this.root = el('section', { class: 'cfs-card', 'aria-label': 'Simplified statement' },
        el('div', { class: 'cfs-bar' },
          el('span', { class: 'cfs-mark', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')),
          el('span', { class: 'cfs-title', text: 'Simplified statement' }),
          this.toggle),
        this.body,
        this.foot);

      const st = problem.statement;
      const header = st.querySelector(':scope > .header');
      if (header) header.after(this.root);
      else st.prepend(this.root);
      // Everything except the title block, the examples and the note is story/spec text.
      this.storyNodes = Array.from(st.children).filter((node) => node !== this.root &&
        !node.classList.contains('header') && !node.classList.contains('sample-tests') && !node.classList.contains('note'));
    }

    choose(view) {
      this.view = view;
      this.applyView();
      send({ type: 'cfs:setView', view });
    }

    applyView() {
      const showSimplified = Boolean(this.result) && this.view === 'simplified';
      for (const node of this.storyNodes) node.classList.toggle('cfs-hidden', showSimplified);
      this.body.hidden = Boolean(this.result) && !showSimplified;
      this.foot.hidden = !this.result || !showSimplified;
      this.buttons.simplified.setAttribute('aria-pressed', String(this.view === 'simplified'));
      this.buttons.original.setAttribute('aria-pressed', String(this.view === 'original'));
      this.root.classList.toggle('cfs-collapsed', Boolean(this.result) && !showSimplified);
    }

    message(text, ...actions) {
      this.result = null;
      this.toggle.hidden = true;
      this.body.hidden = false;
      this.body.replaceChildren(el('p', { class: 'cfs-msg', text }));
      if (actions.length) this.body.append(el('div', { class: 'cfs-actions' }, ...actions));
      this.applyView();
    }

    button(label, onClick, primary) {
      return el('button', { type: 'button', class: primary ? 'cfs-btn cfs-btn-primary' : 'cfs-btn', onclick: onClick }, label);
    }

    showPaused(reason) {
      this.root.classList.add('cfs-paused');
      this.message(reason === 'unknown'
        ? "Paused: couldn't confirm that this contest is over. Codeforces rules don't allow AI summaries during a running contest. Reload the page to check again."
        : "Paused during this contest. Codeforces rules don't allow AI summaries of problems in a running contest. The simplified statement will be available once the contest is over.");
    }

    showMissing(res) {
      if (res.canConvert) {
        this.message('This problem is not in the shared library yet.',
          this.button('Simplify with my API key', () => this.convert(), true));
        return;
      }
      const text = res.libraryError
        ? `Couldn't reach the shared library (${res.libraryError}). Add your own free API key in Settings to simplify problems directly.`
        : res.libraryConfigured
          ? 'This problem is not in the shared library yet. Add your own free API key in Settings to simplify it now.'
          : 'No shared library is set up yet. Add a library address or your own free API key in Settings.';
      this.message(text, this.button('Open settings', () => send({ type: 'cfs:openOptions' })));
    }

    showError(text) {
      this.message(text, this.button('Try again', () => this.load()));
    }

    showFlagged(res) {
      this.message("The automatic check found phrases that could hint at a solution, so this version is hidden.",
        this.button('Try again', () => this.convert(), true),
        this.button('Show it anyway', () => this.showResult(res)));
    }

    showResult(res) {
      this.result = res;
      this.root.classList.remove('cfs-paused');
      this.toggle.hidden = false;
      this.body.innerHTML = CFS.renderMarkdown(res.simplified); // renderMarkdown escapes all text
      if ((res.warnings || []).includes('missing-limits')) {
        this.body.append(el('p', { class: 'cfs-note',
          text: 'Some limits in the original may be missing here. Check the Input section of the original.' }));
      }
      const source = res.source === 'library'
        ? 'From the shared library.'
        : `Simplified with your API key${res.model ? ' (' + res.model + ')' : ''}.`;
      this.foot.replaceChildren(el('span', { text: source }));
      if (res.source === 'library' && res.reportUrl) {
        const pid = String(this.route.contestId) + this.problem.index;
        const url = res.reportUrl + '?title=' + encodeURIComponent('Mistake in ' + pid) +
          '&body=' + encodeURIComponent('Problem: ' + location.href + '\n\nWhat is wrong:\n');
        this.foot.append(' ', el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: 'Report a mistake' }));
      }
      this.applyView();
      document.dispatchEvent(new CustomEvent('cfs:typeset', { detail: this.bodyId }));
    }

    handle(res) {
      if (!res) return this.showError('Something went wrong.');
      switch (res.status) {
        case 'ok': return this.showResult(res);
        case 'paused': return this.showPaused(res.reason || 'running');
        case 'flagged': return this.showFlagged(res);
        case 'missing':
          if (res.canConvert && res.autoConvert) return this.convert();
          return this.showMissing(res);
        default: return this.showError(res.message || 'Something went wrong.');
      }
    }

    request() {
      return {
        contestId: this.route.contestId,
        index: this.problem.index,
        name: this.problem.name,
        kind: this.route.kind,
        pageSaysFinished: domPhase() === 'finished'
      };
    }

    async load() {
      this.message('Loading the simplified statement…');
      this.handle(await send({ type: 'cfs:get', problem: this.request() }));
    }

    async convert() {
      this.message('Simplifying with your API key. This takes a few seconds…');
      const statement = CFS.extractStatement(this.problem.statement);
      this.handle(await send({ type: 'cfs:convert', problem: this.request(), statement }));
    }
  }

  // ---------------------------------------------------------------- start
  async function start() {
    const route = parseRoute(location.pathname);
    if (!route) return;
    const problems = findProblems(route);
    if (!problems.length) return;

    const prefs = await send({ type: 'cfs:prefs' });
    const cards = problems.map((p) => new Card(p, route, prefs || {}));
    for (const card of cards) card.message('Checking the contest status…');

    const gate = await checkGate(route);
    for (const card of cards) {
      if (gate.open) card.load();
      else card.showPaused(gate.reason);
    }
  }

  start();
})();
