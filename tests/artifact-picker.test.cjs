'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { pickerBootstrap } = require('../backend/artifact-picker.cjs');

// Run the same dependency-free function string inserted into a preview. This
// fake DOM verifies protocol/description boundaries, not browser rendering or
// the browser's unforgeable Event.isTrusted implementation.
function fixture() {
  const listeners = new Map(), posts = [], created = [], accesses = [];
  let now = 1000;
  class Element {
    constructor(name, options = {}) {
      this.nodeType = 1; this.tagName = name.toUpperCase();
      this.id = options.id || ''; this.classList = options.classes || [];
      this.parentElement = null; this.children = []; this.style = {};
      this.attributes = new Map(); this.removed = false; this.rectReads = 0;
      this.innerText = options.text; this.textContent = options.fallbackText || '';
      this.rect = options.rect || { left: 10, top: 20, width: 100, height: 50 };
    }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getBoundingClientRect() { this.rectReads++; return this.rect; }
    remove() { this.removed = true; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  }
  const html = new Element('html'), body = html.appendChild(new Element('body'));
  const document = {
    body, documentElement: html,
    createElement(name) { assert.equal(name, 'div', 'picker must only create its visual overlay'); const element = new Element(name); created.push(element); return element; },
    addEventListener(type, listener, capture) { assert.equal(capture, true); if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener, capture) { assert.equal(capture, true); listeners.get(type)?.delete(listener); }
  };
  const forbidden = name => () => { accesses.push(name); throw new Error(`Unexpected capability: ${name}`); };
  const context = vm.createContext({ document, innerWidth: 1280, innerHeight: 720,
    Date: { now: () => now }, post: message => posts.push(JSON.parse(JSON.stringify(message))),
    fetch: forbidden('fetch'), XMLHttpRequest: forbidden('XMLHttpRequest'), WebSocket: forbidden('WebSocket'),
    navigator: new Proxy({}, { get: (_, key) => forbidden(`navigator.${String(key)}`)() }),
    require: undefined, process: undefined, Buffer: undefined,
    window: new Proxy({}, { get: (_, key) => forbidden(`window.${String(key)}`)() })
  }, { codeGeneration: { strings: false, wasm: false } });
  const picker = vm.runInContext(`(${pickerBootstrap.toString()})(post)`, context, { timeout: 1000 });
  function dispatch(type, target = body, options = {}) {
    const event = { target, isTrusted: true, clientX: 33, clientY: 44, ...options,
      defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; }
    };
    for (const listener of [...(listeners.get(type) || [])]) listener(event);
    return event;
  }
  return { picker, posts, body, html, created, listeners, accesses, dispatch,
    node: (name, options, parent = body) => parent.appendChild(new Element(name, options)),
    enable: (requestId = 'pick_1') => picker.set({ enabled: true, requestId }),
    advance: milliseconds => { now += milliseconds; },
    get overlay() { return created.find(element => !element.removed); }
  };
}

test('injected picker starts disabled and untrusted clicks cannot select, consume, or turn it off', () => {
  const f = fixture(), target = f.node('button', { text: 'Choose me' });
  assert.equal(f.dispatch('click', target).defaultPrevented, false);
  f.dispatch('mousemove', target); assert.equal(f.created.length, 0); assert.deepEqual(f.posts, []);
  f.enable(); const synthetic = f.dispatch('click', target, { isTrusted: false });
  assert.equal(synthetic.defaultPrevented, false); assert.equal(synthetic.propagationStopped, false); assert.deepEqual(f.posts, []);
  f.dispatch('click', target); assert.equal(f.posts.length, 1); assert.equal(f.posts[0].requestId, 'pick_1');
});

test('semantic ancestor selection sends a bounded description with first three classes and a body-rooted path', () => {
  const f = fixture(), section = f.node('section', { id: 'controls', classes: ['panel'] });
  const button = f.node('button', { id: 'save', classes: ['primary', 'large', 'rounded', 'ignored'], text: 'Save changes' }, section);
  const icon = f.node('span', { text: 'decorative icon' }, button), textNode = { nodeType: 3, parentElement: icon };
  f.enable('semantic'); const event = f.dispatch('click', textNode);
  assert.equal(event.defaultPrevented, true); assert.equal(event.propagationStopped, true);
  assert.deepEqual(f.posts, [{ type: 'muse:selection', requestId: 'semantic', element: {
    tag: 'button', id: 'save', classes: ['primary', 'large', 'rounded'], text: 'Save changes',
    path: 'body > section#controls.panel > button#save.primary.large.rounded',
    viewport: { width: 1280, height: 720 }, click: { x: 33, y: 44 }
  } }]);
});

test('unknown tags fall back to the original element and missing innerText uses only textContent', () => {
  const f = fixture(), custom = f.node('custom-widget', { id: 'widget' }), inline = f.node('span', { fallbackText: 'fallback label' }, custom);
  f.enable(); f.dispatch('click', inline);
  assert.equal(f.posts[0].element.tag, 'span'); assert.equal(f.posts[0].element.text, 'fallback label');
  assert.equal(f.posts[0].element.path, 'body > custom-widget#widget > span');
});

test('description text is capped at 200 UTF-16 units plus the truncation marker', () => {
  const f = fixture(), exact = 'a'.repeat(198) + '😀', longer = 'b'.repeat(199) + '😀tail';
  assert.equal(exact.length, 200);
  f.enable('exact'); f.dispatch('click', f.node('p', { text: exact })); assert.equal(f.posts[0].element.text, exact);
  f.enable('long'); f.dispatch('click', f.node('p', { text: longer }));
  assert.equal(f.posts[1].element.text, longer.slice(0, 200) + '…'); assert.equal(f.posts[1].element.text.length, 201);
});

test('hover accepts only trusted moves, throttles for 40ms, and pads the semantic element by 4px', () => {
  const f = fixture(), button = f.node('button', { rect: { left: 12, top: 23, width: 90, height: 45 } });
  const span = f.node('span', {}, button); f.enable();
  f.dispatch('mousemove', span, { isTrusted: false }); assert.equal(f.created.length, 0);
  f.dispatch('mousemove', span); const overlay = f.overlay;
  assert.equal(button.rectReads, 1); assert.equal(span.rectReads, 0);
  assert.equal(overlay.attributes.has('data-muse-selection-overlay'), true);
  assert.match(overlay.style.cssText, /pointer-events:none/);
  assert.deepEqual({ left: overlay.style.left, top: overlay.style.top, width: overlay.style.width, height: overlay.style.height }, { left: '8px', top: '19px', width: '98px', height: '53px' });
  button.rect = { left: 100, top: 200, width: 20, height: 30 };
  f.advance(39); f.dispatch('mousemove', span); assert.equal(button.rectReads, 1); assert.equal(overlay.style.left, '8px');
  f.advance(1); f.dispatch('mousemove', span); assert.equal(button.rectReads, 2); assert.equal(overlay.style.left, '96px'); assert.equal(f.created.length, 1);
  assert.deepEqual(f.posts, []);
});

test('selection is one-shot and a later trusted click dismisses it once without blocking link behavior', () => {
  const f = fixture(), link = f.node('a', { text: 'Open details' }); f.enable('link'); f.dispatch('mousemove', link);
  const overlay = f.overlay, first = f.dispatch('click', link), second = f.dispatch('click', link);
  assert.equal(first.defaultPrevented, true); assert.equal(first.propagationStopped, true);
  assert.equal(second.defaultPrevented, false); assert.equal(second.propagationStopped, false);
  assert.equal(f.posts[0].type, 'muse:selection'); assert.deepEqual(f.posts[1], { type:'muse:selection-dismiss', requestId:'link' });
  assert.equal(f.posts.length, 2); assert.equal(overlay.removed, true);
  const third = f.dispatch('click', link); assert.equal(third.defaultPrevented, false); assert.equal(third.propagationStopped, false); assert.equal(f.posts.length, 2);
  f.advance(40); f.dispatch('mousemove', link); assert.equal(f.overlay, undefined);
});

test('Escape cancels once, removes hover, and does not select the next click', () => {
  const f = fixture(), target = f.node('button', { text: 'target' }); f.enable('escape'); f.dispatch('mousemove', target);
  f.dispatch('keydown', target, { key: 'Enter' }); assert.equal(f.posts.length, 0); assert.ok(f.overlay);
  f.dispatch('keydown', target, { key: 'Escape', isTrusted: false }); assert.equal(f.posts.length, 0); assert.ok(f.overlay);
  f.dispatch('keydown', target, { key: 'Escape' });
  assert.deepEqual(f.posts, [{ type: 'muse:selection-cancelled', requestId: 'escape' }]); assert.equal(f.overlay, undefined);
  f.dispatch('keydown', target, { key: 'Escape' }); assert.equal(f.dispatch('click', target).defaultPrevented, false); assert.equal(f.posts.length, 1);
});

test('a selected card dismisses on trusted Escape, while synthetic keys and clicks cannot dismiss or replay it', () => {
  const f = fixture(), target = f.node('button', { text:'selected' }); f.enable('last_success'); f.dispatch('click', target);
  const syntheticClick = f.dispatch('click', target, { isTrusted:false });
  const syntheticKey = f.dispatch('keydown', target, { key:'Escape', isTrusted:false });
  f.dispatch('keydown', target, { key:'Enter' });
  assert.equal(syntheticClick.defaultPrevented, false); assert.equal(syntheticClick.propagationStopped, false); assert.equal(syntheticKey.defaultPrevented, false); assert.equal(f.posts.length, 1);
  const escape = f.dispatch('keydown', target, { key:'Escape' });
  assert.equal(escape.defaultPrevented, false); assert.equal(escape.propagationStopped, false);
  assert.deepEqual(f.posts[1], { type:'muse:selection-dismiss', requestId:'last_success' });
  f.dispatch('keydown', target, { key:'Escape' }); f.dispatch('click', target); assert.equal(f.posts.length, 2);
});

test('new controls, failed selection and disposal revoke any previous successful dismissal identity', () => {
  const f = fixture(), target = f.node('button', { text:'target' });
  f.enable('selected_old'); f.dispatch('click', target); f.picker.set({ enabled:false, requestId:'parent_cleared' });
  f.dispatch('click', target); f.dispatch('keydown', target, { key:'Escape' }); assert.equal(f.posts.length, 1);
  f.enable('selected_again'); f.dispatch('click', target); f.enable('new_request');
  f.dispatch('click', f.node('div', { id:'x'.repeat(513) }));
  assert.deepEqual(f.posts.at(-1), { type:'muse:selection-error', requestId:'new_request' });
  const afterError = f.posts.length; f.dispatch('click', target); f.dispatch('keydown', target, { key:'Escape' }); assert.equal(f.posts.length, afterError);
  f.enable('new_selected'); f.dispatch('click', target); f.picker.dispose();
  const before = f.posts.length; f.dispatch('click', target); f.dispatch('keydown', target, { key:'Escape' }); assert.equal(f.posts.length, before);
  assert.equal(f.posts.some(item=>item.type==='muse:selection-dismiss'), false); assert.deepEqual(f.accesses, []);
});

test('explicit cancellation clears the old request and a new request reports only its own identity', () => {
  const f = fixture(), target = f.node('button', { text: 'latest' }); f.enable('old_request'); f.dispatch('mousemove', target);
  f.picker.set({ enabled: false, requestId: 'old_request' }); assert.equal(f.overlay, undefined);
  assert.equal(f.dispatch('click', target).defaultPrevented, false); assert.deepEqual(f.posts, []);
  f.enable('new_request'); f.dispatch('click', target);
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0].requestId, 'new_request');
  f.enable('third_request'); f.enable('fourth_request'); f.dispatch('keydown', target, { key: 'Escape' });
  assert.equal(f.posts[1].requestId, 'fourth_request');
});

test('invalid controls do not enable the picker or replace a valid active request', () => {
  const f = fixture(), target = f.node('p', { text: 'unchanged' });
  const invalid = [{ enabled: 1, requestId: 'x' }, { enabled: true, requestId: '' }, { enabled: true, requestId: 'x'.repeat(101) }, { enabled: true, requestId: 'a:b' }, { enabled: true, requestId: '中文' }, { enabled: true, requestId: 1 }];
  for (const control of invalid) f.picker.set(control);
  assert.equal(f.dispatch('click', target).defaultPrevented, false); assert.deepEqual(f.posts, []);
  f.enable('valid_identity'); for (const control of invalid) f.picker.set({ ...control, enabled: control.enabled === true ? false : control.enabled });
  f.dispatch('click', target); assert.equal(f.posts[0].requestId, 'valid_identity');
  f.enable('x'.repeat(100)); f.dispatch('click', target); assert.equal(f.posts[1].requestId.length, 100);
});

test('oversized identifiers and classes are rejected without disclosing an element payload', () => {
  for (const options of [{ id: 'i'.repeat(513) }, { classes: ['c'.repeat(257)] }]) {
    const f = fixture(); f.enable('oversized'); const event = f.dispatch('click', f.node('div', options));
    assert.equal(event.defaultPrevented, true); assert.deepEqual(f.posts, [{ type: 'muse:selection-error', requestId: 'oversized' }]);
    f.dispatch('click', f.body); assert.equal(f.posts.length, 1, 'an error also consumes the one-shot selection');
  }
  const f = fixture(); f.enable(); f.dispatch('click', f.node('div', { id: 'i'.repeat(512), classes: ['c'.repeat(256)] })); assert.equal(f.posts[0].type, 'muse:selection');
});

test('the full path must fit its limit rather than silently dropping ancestors', () => {
  const f = fixture(); let parent = f.body;
  for (let index = 0; index < 20; index++) parent = f.node('div', { id: 'p'.repeat(450) }, parent);
  f.enable('long_path'); f.dispatch('click', parent);
  assert.deepEqual(f.posts, [{ type: 'muse:selection-error', requestId: 'long_path' }]);
});

test('deep paths reject a 65-node description but preserve a complete 64-node path to body', () => {
  for (const depth of [63, 64]) {
    const f = fixture(); let parent = f.body;
    for (let index = 0; index < depth; index++) parent = f.node('div', {}, parent);
    f.enable('depth'); f.dispatch('click', parent);
    if (depth === 63) { assert.equal(f.posts[0].type, 'muse:selection'); const parts = f.posts[0].element.path.split(' > '); assert.equal(parts.length, 64); assert.equal(parts[0], 'body'); }
    else assert.deepEqual(f.posts, [{ type: 'muse:selection-error', requestId: 'depth' }]);
  }
});

test('dispose unregisters all capture listeners, clears overlay and cannot leak a later selection', () => {
  const f = fixture(), target = f.node('button', { text: 'target' }); f.enable(); f.dispatch('mousemove', target);
  assert.equal([...f.listeners.values()].reduce((sum, values) => sum + values.size, 0), 3);
  f.picker.dispose(); assert.equal(f.overlay, undefined); assert.equal([...f.listeners.values()].reduce((sum, values) => sum + values.size, 0), 0);
  f.dispatch('click', target); f.dispatch('keydown', target, { key: 'Escape' }); f.advance(40); f.dispatch('mousemove', target);
  f.enable('after_dispose'); f.dispatch('click', target); f.picker.dispose(); assert.deepEqual(f.posts, []); assert.equal(f.created.length, 1);
});

test('the picker does not read form values, serialize DOM, capture pixels or invoke network capabilities', () => {
  const f = fixture(), input = f.node('input', { id: 'field', text: '' });
  for (const property of ['value', 'outerHTML', 'innerHTML', 'src', 'href', 'files']) Object.defineProperty(input, property, { get() { f.accesses.push(property); throw new Error(`Must not read ${property}`); } });
  for (const name of ['getContext', 'toDataURL', 'captureStream']) input[name] = () => { f.accesses.push(name); throw new Error(`Must not call ${name}`); };
  f.enable('privacy'); f.dispatch('mousemove', input); f.dispatch('click', input);
  assert.deepEqual(f.accesses, []); assert.equal(f.posts[0].element.text, '');
  assert.deepEqual(Object.keys(f.posts[0].element).sort(), ['classes', 'click', 'id', 'path', 'tag', 'text', 'viewport']);
  assert.equal(JSON.stringify(f.posts).includes('Base64'), false);
});
