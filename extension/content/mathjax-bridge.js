/* Runs in the page's own JavaScript world (manifest "world": "MAIN") so it can
   use the MathJax that Codeforces already loads. content.js fires a
   "cfs:typeset" event with the id of the element to typeset. */
(() => {
  'use strict';
  if (window.__cfsBridge) return;
  window.__cfsBridge = true;

  const MAX_ATTEMPTS = 20;

  function typeset(root, attempt) {
    const spans = root.querySelectorAll('.cfs-math:not([data-cfs-done])');
    if (!spans.length) return;
    const MJ = window.MathJax;

    if (MJ && MJ.Hub && typeof MJ.Hub.Queue === 'function') { // MathJax 2 (Codeforces)
      spans.forEach((span) => {
        const script = document.createElement('script');
        script.type = span.getAttribute('data-display') === '1' ? 'math/tex; mode=display' : 'math/tex';
        script.text = span.getAttribute('data-tex') || '';
        span.textContent = '';
        span.appendChild(script);
        span.setAttribute('data-cfs-done', '1');
      });
      MJ.Hub.Queue(['Typeset', MJ.Hub, root]);
      return;
    }

    if (MJ && typeof MJ.tex2chtml === 'function') { // MathJax 3
      spans.forEach((span) => {
        try {
          const node = MJ.tex2chtml(span.getAttribute('data-tex') || '', { display: span.getAttribute('data-display') === '1' });
          span.textContent = '';
          span.appendChild(node);
          span.setAttribute('data-cfs-done', '1');
        } catch (err) { /* keep the readable fallback */ }
      });
      try {
        MJ.startup.document.clear();
        MJ.startup.document.updateDocument();
      } catch (err) { /* styles may already be present */ }
      return;
    }

    if (attempt < MAX_ATTEMPTS) setTimeout(() => typeset(root, attempt + 1), 500); // MathJax still loading
  }

  document.addEventListener('cfs:typeset', (event) => {
    const id = event.detail;
    const root = typeof id === 'string' ? document.getElementById(id) : null;
    if (root) typeset(root, 0);
  });
})();
