// Helpers for the extension tests (run with: cd tests/js && npm install && npm test)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const EXT = path.join(ROOT, 'extension');
export const FIXTURES = path.join(ROOT, 'tests', 'fixtures');

export const read = (file) => fs.readFileSync(file, 'utf8');
export const fixture = (name) => read(path.join(FIXTURES, name));
export const squash = (s) => s.replace(/\s+/g, ' ').trim();

// Wait for pending promises / timers inside the page to settle.
export async function settle(times = 10) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

// In-memory stand-in for chrome.storage.{sync,local}.
export function storageArea(data = {}) {
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return clone(data);
      if (typeof keys === 'string') return keys in data ? { [keys]: clone(data[keys]) } : {};
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (k in data) out[k] = clone(data[k]);
        return out;
      }
      const out = {};
      for (const [k, def] of Object.entries(keys)) out[k] = k in data ? clone(data[k]) : def;
      return out;
    },
    async set(items) { Object.assign(data, clone(items)); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; }
  };
}

// A Codeforces-like page with the content scripts loaded and chrome.runtime stubbed.
// `answer(msg)` returns the background's reply for each message.
export async function openProblemPage({ html, url, answer }) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const sent = [];
  window.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(msg, callback) {
        const copy = JSON.parse(JSON.stringify(msg)); // like Chrome, messages are serialized
        sent.push(copy);
        Promise.resolve(answer(copy)).then((reply) => callback && callback(JSON.parse(JSON.stringify(reply))));
      }
    }
  };
  const typeset = [];
  window.document.addEventListener('cfs:typeset', (e) => typeset.push(e.detail));
  window.eval(read(path.join(EXT, 'content', 'render.js')));
  window.eval(read(path.join(EXT, 'content', 'content.js')));
  await settle(20);
  return { dom, window, document: window.document, sent, typeset };
}
