/* CF Simplify: pure helpers used by content.js.
   - extractStatement(): turns a .problem-statement element into plain text
     with LaTeX math (used only for conversions with a personal key).
   - renderMarkdown(): turns the simplified Markdown into safe HTML. Math is
     left as spans for MathJax (see mathjax-bridge.js) with a readable fallback. */
(function (root) {
  'use strict';
  const CFS = (root.CFS = root.CFS || {});

  // ------------------------------------------------------------------ escaping
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

  // ------------------------------------------------------------------ statement → text
  const BLOCK_TAGS = new Set(['p', 'div', 'ul', 'ol', 'table', 'center', 'blockquote', 'section',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dl', 'dt', 'dd', 'tr']);
  const REMOVE_SELECTOR = [
    '.cfs-card', '.header', '.sample-tests', 'button', 'style',
    '[class^="MathJax"]', '[class*=" MathJax"]', '[class^="mjx-"]', 'mjx-container'
  ].join(',');

  function walk(node, out) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        out.push(child.nodeValue.replace(/\s+/g, ' '));
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toLowerCase();
      const cls = child.classList;
      if (tag === 'script') {
        const type = (child.getAttribute('type') || '').toLowerCase();
        if (type.startsWith('math/tex')) {
          const tex = child.textContent.trim();
          out.push(type.includes('mode=display') ? '\n$$' + tex + '$$\n' : '$' + tex + '$');
        }
        continue;
      }
      if (cls.contains('section-title')) {
        out.push('\n\n### ' + child.textContent.trim() + '\n\n');
        continue;
      }
      if (cls.contains('tex-span')) {
        const inner = [];
        walk(child, inner);
        out.push('$' + inner.join('').trim() + '$');
        continue;
      }
      if (cls.contains('tex-font-style-tt')) {
        out.push('`' + child.textContent + '`');
        continue;
      }
      if (tag === 'br') { out.push('\n'); continue; }
      if (tag === 'img') {
        if (cls.contains('tex-formula')) {
          const alt = (child.getAttribute('alt') || '').trim();
          out.push(alt ? '$' + alt + '$' : ' [formula image] ');
        } else {
          out.push(' [figure] ');
        }
        continue;
      }
      if (tag === 'sub' || tag === 'sup') {
        out.push(tag === 'sub' ? '_{' : '^{');
        walk(child, out);
        out.push('}');
        continue;
      }
      if (tag === 'li') {
        out.push('\n- ');
        walk(child, out);
        continue;
      }
      if (tag === 'pre') {
        out.push('\n```\n' + child.textContent.replace(/^\n+|\n+$/g, '') + '\n```\n');
        continue;
      }
      if (tag === 'td' || tag === 'th') {
        walk(child, out);
        out.push(' | ');
        continue;
      }
      const block = BLOCK_TAGS.has(tag);
      if (block) out.push('\n\n');
      walk(child, out);
      if (block) out.push('\n\n');
    }
  }

  function finalizeText(text) {
    let s = text.replace(/\u00a0/g, ' ');
    s = s.replace(/\${6}([\s\S]+?)\${6}/g, (m, t) => '\n$$' + t.trim() + '$$\n');
    s = s.replace(/\${3}([\s\S]+?)\${3}/g, (m, t) => '$' + t.trim() + '$');
    s = s.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n');
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  CFS.extractStatement = function extractStatement(statementEl) {
    const clone = statementEl.cloneNode(true);
    clone.querySelectorAll(REMOVE_SELECTOR).forEach((n) => n.remove());
    const out = [];
    walk(clone, out);
    return finalizeText(out.join(''));
  };

  // ------------------------------------------------------------------ TeX fallback
  const GREEK = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
    theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ',
    sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω'
  };
  const SYMBOLS = {
    le: '≤', leq: '≤', leqslant: '≤', ge: '≥', geq: '≥', geqslant: '≥', ne: '≠', neq: '≠', lt: '<', gt: '>',
    cdot: '·', times: '×', div: '÷', ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮',
    oplus: '⊕', otimes: '⊗', in: '∈', notin: '∉', ni: '∋', sum: '∑', prod: '∏',
    to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐', leftrightarrow: '↔', iff: '⇔', implies: '⇒',
    infty: '∞', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', langle: '⟨', rangle: '⟩',
    land: '∧', wedge: '∧', lor: '∨', vee: '∨', neg: '¬', lnot: '¬',
    subseteq: '⊆', subset: '⊂', supseteq: '⊇', supset: '⊃', cup: '∪', cap: '∩', setminus: '∖',
    emptyset: '∅', varnothing: '∅', approx: '≈', equiv: '≡', sim: '∼', pm: '±', mp: '∓',
    mid: '∣', vert: '|', lvert: '|', rvert: '|', Vert: '‖', forall: '∀', exists: '∃', circ: '∘',
    bmod: ' mod ', mod: ' mod ', gcd: 'gcd', lcm: 'lcm', max: 'max', min: 'min', log: 'log', ln: 'ln',
    lg: 'lg', exp: 'exp', sin: 'sin', cos: 'cos', det: 'det', deg: 'deg', dim: 'dim', arg: 'arg',
    prime: '′', ell: 'ℓ', star: '⋆', ast: '∗', bullet: '•', dagger: '†', uparrow: '↑', downarrow: '↓',
    quad: '\u2003', qquad: '\u2003\u2003', lbrace: '{', rbrace: '}', backslash: '\\', percent: '%'
  };
  const DROP = new Set(['displaystyle', 'textstyle', 'scriptstyle', 'left', 'right', 'big', 'Big', 'bigg', 'Bigg',
    'bigl', 'bigr', 'Bigl', 'Bigr', 'limits', 'nolimits', 'middle']);
  const WRAPPERS = new Set(['mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'mathcal', 'mathbb', 'mathfrak',
    'boldsymbol', 'operatorname', 'overline', 'underline', 'hat', 'tilde', 'bar', 'vec', 'widehat', 'widetilde']);
  const TEXT_WRAPPERS = new Set(['text', 'textrm', 'textbf', 'textit', 'texttt', 'textsf', 'mbox']);
  const SINGLE = { ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ', '{': '{', '}': '}', '%': '%', '$': '$', '&': '&', '#': '#', '_': '_', '|': '‖' };

  function texToHtml(tex) {
    const s = String(tex);
    let i = 0;
    let out = '';

    const readGroup = () => { // i is just after '{'
      let depth = 1;
      const start = i;
      while (i < s.length && depth > 0) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === '{') depth++;
        else if (s[i] === '}') depth--;
        i++;
      }
      return s.slice(start, depth === 0 ? i - 1 : i);
    };
    const readArg = () => {
      while (s[i] === ' ') i++;
      if (s[i] === '{') { i++; return readGroup(); }
      if (s[i] === '\\') {
        let j = i + 1;
        if (/[a-zA-Z]/.test(s[j] || '')) while (j < s.length && /[a-zA-Z]/.test(s[j])) j++;
        else j++;
        const cmd = s.slice(i, j);
        i = j;
        return cmd;
      }
      return i < s.length ? s[i++] : '';
    };

    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        let j = i + 1;
        if (/[a-zA-Z]/.test(s[j] || '')) while (j < s.length && /[a-zA-Z]/.test(s[j])) j++;
        else j++;
        const name = s.slice(i + 1, j);
        i = j;
        if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
          const a = readArg();
          const b = readArg();
          out += '(' + texToHtml(a) + ')/(' + texToHtml(b) + ')';
        } else if (name === 'binom') {
          const a = readArg();
          const b = readArg();
          out += 'C(' + texToHtml(a) + ', ' + texToHtml(b) + ')';
        } else if (name === 'sqrt') {
          out += '√(' + texToHtml(readArg()) + ')';
        } else if (name === 'pmod') {
          out += ' (mod ' + texToHtml(readArg()) + ')';
        } else if (TEXT_WRAPPERS.has(name)) {
          out += '<span class="cfs-tex-text">' + escapeHtml(readArg()) + '</span>';
        } else if (WRAPPERS.has(name)) {
          out += texToHtml(readArg());
        } else if (DROP.has(name)) {
          // nothing
        } else if (Object.prototype.hasOwnProperty.call(GREEK, name)) {
          out += GREEK[name];
        } else if (Object.prototype.hasOwnProperty.call(SYMBOLS, name)) {
          out += escapeHtml(SYMBOLS[name]);
        } else if (name.length === 1 && !/[a-zA-Z]/.test(name)) {
          out += escapeHtml(Object.prototype.hasOwnProperty.call(SINGLE, name) ? SINGLE[name] : name);
        } else {
          out += escapeHtml(name);
        }
        continue;
      }
      if (c === '^' || c === '_') {
        i++;
        const tag = c === '^' ? 'sup' : 'sub';
        out += '<' + tag + '>' + texToHtml(readArg()) + '</' + tag + '>';
        continue;
      }
      if (c === '{') { i++; out += texToHtml(readGroup()); continue; }
      if (c === '}') { i++; continue; }
      if (c === '~' || c === '&') { out += ' '; i++; continue; }
      out += escapeHtml(c);
      i++;
    }
    return out;
  }
  CFS.texToHtml = texToHtml;

  // ------------------------------------------------------------------ markdown → HTML
  function renderMarkdown(markdown) {
    const maths = [];
    let src = String(markdown || '').replace(/\r\n?/g, '\n');
    // Codeforces-style delimiters, in case a model copies them.
    src = src.replace(/\${6}([\s\S]+?)\${6}/g, (m, t) => '$$' + t + '$$');
    src = src.replace(/\${3}([\s\S]+?)\${3}/g, (m, t) => '$' + t + '$');
    // Pull math out first so Markdown rules never touch it.
    src = src.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$((?:\\\$|[^$\n])+?)\$|\\\(([\s\S]+?)\\\)/g,
      (m, d1, d2, i1, i2) => {
        const display = d1 !== undefined || d2 !== undefined;
        const tex = (d1 !== undefined ? d1 : d2 !== undefined ? d2 : i1 !== undefined ? i1 : i2).trim();
        maths.push({ tex, display });
        return '\u0000' + (maths.length - 1) + '\u0000';
      });

    const mathSpan = (k) => {
      const m = maths[k];
      if (!m) return '';
      return '<span class="cfs-math' + (m.display ? ' cfs-math-display' : '') + '" data-tex="' + escapeHtml(m.tex) +
        '" data-display="' + (m.display ? '1' : '0') + '"><span class="cfs-tex">' + texToHtml(m.tex) + '</span></span>';
    };
    const inline = (text) => {
      let s = escapeHtml(text);
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
      s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![\w*])/g, '$1<em>$2</em>');
      s = s.replace(/\u0000(\d+)\u0000/g, (m, k) => mathSpan(Number(k)));
      return s;
    };

    const lines = src.split('\n');
    let html = '';
    let para = [];
    const lists = []; // stack of { type, indent }

    const flushPara = () => {
      if (para.length) {
        html += '<p>' + inline(para.join(' ')) + '</p>';
        para = [];
      }
    };
    const closeListsTo = (indent) => {
      while (lists.length && lists[lists.length - 1].indent > indent) {
        html += '</li></' + lists.pop().type + '>';
      }
    };
    const closeAllLists = () => closeListsTo(-1);

    for (let n = 0; n < lines.length; n++) {
      const raw = lines[n];
      const line = raw.replace(/\t/g, '    ');

      if (/^\s*```/.test(line)) { // fenced code block
        flushPara();
        closeAllLists();
        const code = [];
        n++;
        while (n < lines.length && !/^\s*```/.test(lines[n])) code.push(lines[n++]);
        html += '<pre><code>' + escapeHtml(code.join('\n').replace(/\u0000(\d+)\u0000/g, (m, k) => {
          const mm = maths[Number(k)];
          return mm ? (mm.display ? '$$' + mm.tex + '$$' : '$' + mm.tex + '$') : '';
        })) + '</code></pre>';
        continue;
      }
      if (!line.trim()) { flushPara(); continue; }

      const heading = line.match(/^\s*#{1,6}\s+(.*?)\s*#*\s*$/);
      if (heading) {
        flushPara();
        closeAllLists();
        html += '<h4 class="cfs-h">' + inline(heading[1]) + '</h4>';
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); closeAllLists(); continue; }

      const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (item) {
        flushPara();
        const indent = item[1].length;
        const type = /\d/.test(item[2]) ? 'ol' : 'ul';
        closeListsTo(indent);
        const top = lists[lists.length - 1];
        if (!top || top.indent < indent) {
          html += '<' + type + '><li>';
          lists.push({ type, indent });
        } else if (top.type !== type) {
          html += '</li></' + lists.pop().type + '><' + type + '><li>';
          lists.push({ type, indent });
        } else {
          html += '</li><li>';
        }
        html += inline(item[3]);
        continue;
      }

      if (lists.length && /^\s{2,}\S/.test(line) && !para.length) { // continuation of a list item
        html += ' ' + inline(line.trim());
        continue;
      }
      closeAllLists();
      para.push(line.trim());
    }
    flushPara();
    closeAllLists();
    return html;
  }
  CFS.renderMarkdown = renderMarkdown;
  CFS.escapeHtml = escapeHtml;
})(globalThis);
