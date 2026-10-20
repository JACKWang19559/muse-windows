'use strict';

// Injected into the isolated preview before authored scripts. This sends page
// descriptions only; it exposes no host API, filesystem or model credentials.
function pickerBootstrap(post) {
  const semantic = new Set('div section article main nav header footer aside p h1 h2 h3 h4 h5 h6 li ul ol button a img figure table tr td th form input textarea select label details summary'.split(' '));
  let enabled = false, requestId = '', lastSelectionId = '', overlay, lastMove = 0;
  const tag = node => String(node?.tagName || '').toLowerCase();
  const describe = node => tag(node) + (node.id ? '#' + node.id : '') + Array.from(node.classList || []).slice(0, 3).map(name => '.' + name).join('');
  const targetOf = source => {
    const original = source?.nodeType === 1 ? source : source?.parentElement;
    for (let current = original; current && current !== document.body; current = current.parentElement) if (semantic.has(tag(current))) return current;
    return original;
  };
  const clearHighlight = () => { overlay?.remove(); overlay = undefined; };
  // The original card dismisses on interaction outside it, including iframe
  // focus. An opaque Windows preview reports this intent on its private port;
  // the parent still checks the matching current selection/session identity.
  const dismissSelection = () => {
    if (!lastSelectionId) return;
    const selectedId = lastSelectionId; lastSelectionId = '';
    post({ type:'muse:selection-dismiss', requestId:selectedId });
  };
  const set = message => {
    if (typeof message.enabled !== 'boolean' || typeof message.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(message.requestId)) return;
    requestId = message.requestId; enabled = message.enabled; lastSelectionId = ''; clearHighlight();
  };
  const move = event => {
    if (!enabled || !event.isTrusted || Date.now() - lastMove < 40) return;
    lastMove = Date.now(); const element = targetOf(event.target); if (!element) return;
    const rect = element.getBoundingClientRect();
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.setAttribute('data-muse-selection-overlay', '');
      overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:2px solid #7c5ce7;background:rgba(124,92,231,.08);border-radius:4px';
      (document.body || document.documentElement).appendChild(overlay);
    }
    Object.assign(overlay.style, { left:rect.left - 4 + 'px', top:rect.top - 4 + 'px', width:rect.width + 8 + 'px', height:rect.height + 8 + 'px' });
  };
  const click = event => {
    if (!event.isTrusted) return;
    if (!enabled) { dismissSelection(); return; }
    event.preventDefault(); event.stopPropagation();
    const element = targetOf(event.target); enabled = false; clearHighlight();
    if (!element) return;
    const ancestors = [];
    for (let current = element; current; current = current.parentElement) {
      ancestors.unshift(describe(current));
      if (current === document.body) break;
      // This Windows preview bound avoids an unbounded document description.
      if (ancestors.length >= 64 && current !== document.body && current.parentElement) { post({ type:'muse:selection-error', requestId }); return; }
    }
    const rawText = element.innerText ?? element.textContent ?? '';
    const selection = { tag:tag(element), id:element.id || '', classes:Array.from(element.classList || []).slice(0, 3), text:rawText.length > 200 ? rawText.slice(0, 200) + '…' : rawText, path:ancestors.join(' > '), viewport:{ width:innerWidth, height:innerHeight }, click:{ x:event.clientX, y:event.clientY } };
    // Descriptions outside the documented Windows limit are rejected visibly
    // instead of silently attaching information about a different element.
    if (selection.id.length > 512 || selection.classes.some(value => value.length > 256) || selection.path.length > 8192) post({ type:'muse:selection-error', requestId });
    else { post({ type:'muse:selection', requestId, element:selection }); lastSelectionId = requestId; }
  };
  const escape = event => {
    if (!event.isTrusted || event.key !== 'Escape') return;
    if (enabled) { enabled = false; clearHighlight(); post({ type:'muse:selection-cancelled', requestId }); }
    else dismissSelection();
  };
  document.addEventListener('mousemove', move, true);
  document.addEventListener('click', click, true);
  document.addEventListener('keydown', escape, true);
  return { set, dispose() { enabled = false; requestId = ''; lastSelectionId = ''; clearHighlight(); document.removeEventListener('mousemove', move, true); document.removeEventListener('click', click, true); document.removeEventListener('keydown', escape, true); } };
}
module.exports = { pickerBootstrap };
