/* Automatic checks for a simplified statement.
   Mirrors builder/cfsimplify/checks.py; keep the two in step.
   Works in the service worker (importScripts) and in Node tests. */
(function (root) {
  'use strict';

  // ---------- output cleanup ----------
  function cleanOutput(text) {
    let s = String(text || '');
    s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
    const fenced = s.match(/^\s*```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n\s*```\s*$/i);
    if (fenced) s = fenced[1];
    return s.trim();
  }

  // ---------- the user message sent with the system prompt ----------
  function buildUserMessage(problem, statement) {
    const pid = String(problem.contestId) + String(problem.index);
    const name = problem.name ? ' "' + problem.name + '"' : '';
    return 'Rewrite this Codeforces problem statement following your instructions.\n\n' +
      'Problem: ' + pid + name + '\n\n' +
      '<statement>\n' + String(statement).trim() + '\n</statement>';
  }

  // ---------- sections ----------
  const FORMAL_RE = /^(input|output|interaction|входные|выходные|протокол)/;
  const NOTE_RE = /^(note|notes|example|examples|примечание|пример)/;

  function splitSections(text) {
    const sections = [];
    let current = { title: '', lines: [] };
    for (const line of String(text).split('\n')) {
      const m = line.match(/^#{2,4}\s+(.*)$/);
      if (m) {
        sections.push(current);
        current = { title: m[1].trim().toLowerCase(), lines: [] };
      } else {
        current.lines.push(line);
      }
    }
    sections.push(current);
    return sections;
  }

  // The parts of a statement where formal limits live (not the story, not the notes).
  function formalSections(text) {
    const sections = splitSections(text);
    const formal = sections.filter((s) => FORMAL_RE.test(s.title));
    const use = formal.length ? formal : sections.filter((s) => !NOTE_RE.test(s.title));
    return use.map((s) => s.lines.join('\n')).join('\n');
  }

  // ---------- numbers ----------
  function normalizeNumbers(text) {
    let s = String(text);
    s = s.replace(/\\[,;!:]|~/g, ' ');
    s = s.replace(/\\(?:cdot|times)(?![a-zA-Z])|[·×⋅]/g, '*');
    s = s.replace(/\{,\}/g, ',');
    s = s.replace(/\{\s*(\d+)\s*\}/g, '$1');
    s = s.replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
    s = s.replace(/\s*\^\s*/g, '^').replace(/\s*\*\s*/g, '*');
    return s;
  }

  // Map of value (decimal string) -> how it was written, for every number >= 100.
  function numberValues(text) {
    let s = normalizeNumbers(text);
    const found = new Map();
    const add = (value, form) => {
      if (value >= 100n && !found.has(value.toString())) found.set(value.toString(), form);
    };
    s = s.replace(/(\d+)\*(\d+)\^(\d+)/g, (m, a, b, c) => {
      if (Number(c) <= 60) add(BigInt(a) * BigInt(b) ** BigInt(c), m);
      return ' ';
    });
    s = s.replace(/(\d+)\^(\d+)/g, (m, b, c) => {
      if (Number(c) <= 60) add(BigInt(b) ** BigInt(c), m);
      return ' ';
    });
    s.replace(/\d{3,}/g, (m) => {
      add(BigInt(m), m);
      return m;
    });
    return found;
  }

  function missingNumbers(original, output) {
    const want = numberValues(formalSections(original));
    const have = numberValues(output);
    const missing = [];
    for (const [value, form] of want) if (!have.has(value)) missing.push(form);
    return missing;
  }

  // ---------- hint words ----------
  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function findHints(original, output, terms) {
    const orig = String(original).toLowerCase();
    const out = String(output).toLowerCase();
    const hits = [];
    for (const term of (terms && terms.terms) || []) {
      const t = term.toLowerCase();
      if (orig.includes(t)) continue;
      const re = new RegExp('(?<![a-z0-9])' + escapeRegExp(t) + '(?:s|es)?(?![a-z0-9])');
      if (re.test(out)) hits.push(term);
    }
    for (const pattern of (terms && terms.patterns) || []) {
      const re = new RegExp(pattern, 'i');
      const m = String(output).match(re);
      if (m && !re.test(String(original))) hits.push(m[0].trim());
    }
    return hits;
  }

  // ---------- format ----------
  function checkFormat(output) {
    const s = String(output);
    const problems = [];
    if (!s.trim()) return ['empty'];
    const has = (name) => new RegExp('^#{2,3}\\s*' + name + '\\b', 'im').test(s);
    if (!has('task')) problems.push('missing "## Task"');
    if (!has('interaction') && !(has('input') && has('output'))) problems.push('missing "## Input"/"## Output"');
    return problems;
  }

  function runChecks(original, output, terms) {
    return {
      hints: findHints(original, output, terms),
      missing: missingNumbers(original, output),
      format: checkFormat(output)
    };
  }

  function hasIssues(issues) {
    return issues.hints.length > 0 || issues.missing.length > 0 || issues.format.length > 0;
  }

  function feedback(issues) {
    const lines = ['Your rewrite needs fixing:'];
    if (issues.hints.length) {
      lines.push('- It uses words that can act as hints or add claims the statement does not make: ' +
        issues.hints.map((h) => '"' + h + '"').join(', ') +
        '. Remove them and describe only what the statement says.');
    }
    if (issues.missing.length) {
      lines.push('- These numbers or limits from the statement are missing: ' + issues.missing.join(', ') +
        '. Include every limit exactly as written.');
    }
    if (issues.format.length) {
      lines.push('- It does not follow the required format (## Task, ## Details, ## Input, ## Output, or ## Interaction for interactive problems).');
    }
    lines.push('Reply with the corrected rewrite only, in the same format.');
    return lines.join('\n');
  }

  root.CFSChecks = {
    cleanOutput, buildUserMessage, formalSections, numberValues, missingNumbers,
    findHints, checkFormat, runChecks, hasIssues, feedback
  };
})(globalThis);
