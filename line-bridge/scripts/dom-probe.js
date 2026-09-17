// LINE Chrome extension — deep DOM probe (read-only)
//
// document.body.innerText said the quoted text was absent, but it is visible in
// the Elements panel. That gap has three usual causes, and this tells us which:
//
//   1. Shadow DOM   — innerText does not cross a shadow root
//   2. iframe       — innerText only covers the top document
//   3. Not rendered — innerText skips nodes that are not visible (virtual lists)
//
// Run it in the DevTools Console on the LINE extension page, with the Keep Memo
// chat open. It only reads: no clicks, no network, no mutation.

(() => {
  const NEEDLE = 'LINEBRIDGE_TEST_B';   // the quoted text we are hunting for
  const out = { needle: NEEDLE };

  // --- 1. Cheap discriminators on the top document -------------------------
  out.topDocument = {
    innerText:   document.body.innerText.includes(NEEDLE),
    textContent: document.body.textContent.includes(NEEDLE),
    innerHTML:   document.body.innerHTML.includes(NEEDLE),
  };
  // textContent true + innerText false  => present but not rendered
  // all three false                     => it lives in a shadow root or an iframe

  // --- 2. Structure census -------------------------------------------------
  const allTop = Array.from(document.querySelectorAll('*'));
  out.counts = {
    elements: allTop.length,
    iframes: document.querySelectorAll('iframe').length,
    openShadowRoots: allTop.filter(el => el.shadowRoot).length,
  };

  // --- 3. Deep search through open shadow roots and same-origin iframes ----
  const hits = [];
  const notes = [];
  const seen = new Set();

  function walk(root, path, depth) {
    if (!root || depth > 12 || seen.has(root)) return;
    seen.add(root);
    let els;
    try { els = Array.from(root.querySelectorAll('*')); } catch (e) { return; }

    for (const el of els) {
      if (el.shadowRoot) {
        walk(el.shadowRoot, path + ' > ' + el.tagName.toLowerCase() + '::shadow', depth + 1);
      }
      if (el.tagName === 'IFRAME') {
        let doc = null;
        try { doc = el.contentDocument; } catch (e) { doc = null; }
        if (doc) walk(doc, path + ' > iframe[' + (el.src || 'about:blank').slice(0, 60) + ']', depth + 1);
        else notes.push('inaccessible iframe at ' + path + ' src=' + (el.src || '').slice(0, 80));
      }

      const t = el.textContent;
      if (t && t.includes(NEEDLE)) {
        // keep only the deepest element holding it
        const deeper = Array.from(el.children).some(c => c.textContent && c.textContent.includes(NEEDLE));
        if (!deeper) {
          hits.push({
            path,
            tag: el.tagName.toLowerCase(),
            cls: (typeof el.className === 'string' ? el.className : '').slice(0, 100),
            attrs: Array.from(el.attributes || [])
              .map(a => a.name + '=' + String(a.value).slice(0, 50)).slice(0, 10),
            text: t.trim().slice(0, 100),
            rendered: !!(el.offsetParent || el.getClientRects().length),
          });
        }
      }
    }
  }
  walk(document, 'document', 0);

  out.hits = hits;
  out.hitCount = hits.length;
  out.notes = notes.slice(0, 10);

  // --- 4. If found, show the bubble around the first hit -------------------
  if (hits.length) {
    // re-find it to grab surrounding markup
    const findDeep = (root, depth) => {
      if (!root || depth > 12) return null;
      let els; try { els = Array.from(root.querySelectorAll('*')); } catch (e) { return null; }
      for (const el of els) {
        if (el.shadowRoot) { const r = findDeep(el.shadowRoot, depth + 1); if (r) return r; }
        if (el.tagName === 'IFRAME') { try { if (el.contentDocument) { const r = findDeep(el.contentDocument, depth + 1); if (r) return r; } } catch (e) {} }
        if (el.textContent && el.textContent.includes(NEEDLE) &&
            !Array.from(el.children).some(c => c.textContent && c.textContent.includes(NEEDLE))) return el;
      }
      return null;
    };
    const leaf = findDeep(document, 0);
    if (leaf) {
      let bubble = leaf;
      for (let i = 0; i < 5 && bubble.parentElement; i++) bubble = bubble.parentElement;
      out.bubbleHTML = bubble.outerHTML.slice(0, 3000);
    }
  }

  const json = JSON.stringify(out, null, 2);
  console.log(json);
  try { copy(json); console.log('--- copied to clipboard ---'); } catch (e) {}
  return out;
})();
