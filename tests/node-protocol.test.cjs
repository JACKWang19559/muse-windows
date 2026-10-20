'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NODE_ARG_TYPES, JSON_LIMITS, ProtocolValidationError,
  parseActionSpec, validateArguments, toFunctionTool
} = require('../backend/node-protocol.cjs');

const action = (required = {}, optional = {}) => ({ required, optional, permissions: [] });
const typed = type => action({ value: { type } });
function rejectsProtocol(fn, pattern) {
  assert.throws(fn, error => error instanceof ProtocolValidationError
    && error.code === 'ERR_NODE_PROTOCOL' && (!pattern || pattern.test(error.message)));
}

test('recovers exactly the six argument kinds and normalizes absent containers', () => {
  assert.deepEqual(NODE_ARG_TYPES, ['string', 'integer', 'number', 'boolean', 'object', 'array']);
  assert.deepEqual(parseActionSpec({}), { required: {}, optional: {}, permissions: [] });
  assert.deepEqual(parseActionSpec({ description: null, datatype: null, timeoutMs: null }), { required: {}, optional: {}, permissions: [] });
  assert.deepEqual(validateArguments({}, {}), {});
});

test('preserves metadata and UInt32 boundaries without guessing a timeout', () => {
  const raw = { description: 'Read a workspace entry', required: { path: { type: 'string', description: 'Relative path', enumValues: ['a', 'b', 'a'] } }, optional: { mode: { type: 'string', enumValues: null } }, permissions: ['files.read', 'files.read'], datatype: 'custom/result', timeoutMs: 0 };
  const parsed = parseActionSpec(raw);
  assert.deepEqual(parsed, { required: { path: { type: 'string', description: 'Relative path', enumValues: ['a', 'b'] } }, optional: { mode: { type: 'string' } }, permissions: ['files.read'], description: raw.description, datatype: 'custom/result', timeoutMs: 0 });
  assert.equal(parseActionSpec({ timeoutMs: 0xffffffff }).timeoutMs, 0xffffffff);
  assert.equal(Object.hasOwn(parseActionSpec({}), 'timeoutMs'), false);
  for (const timeoutMs of [-1, 0x100000000, 1.1, '100', Infinity, NaN]) rejectsProtocol(() => parseActionSpec({ timeoutMs }));
});

test('rejects ambiguous schemas, overlap, unknown fields and incorrect metadata types', () => {
  const invalidSpecs = [null, [], 'json', { required: null }, { optional: [] }, { permissions: null }, { permissions: ['read', 3] }, { description: false }, { datatype: {} }, { extra: 1 }, action({ path: { type: 'string', extra: true } }), action({ path: {} }), action({ path: { type: 'String' } }), action({ path: { type: 'null' } }), action({ '': { type: 'string' } }), action({ path: { type: 'string' } }, { path: { type: 'integer' } }), action({ path: { type: 'string', enumValues: [] } }), action({ path: { type: 'string', enumValues: ['x', 1] } }), action({ path: { type: 'integer', enumValues: ['1'] } })];
  for (const spec of invalidSpecs) rejectsProtocol(() => parseActionSpec(spec));
});

test('validates all six types, optional omission and returns detached JSON data', () => {
  const spec = action({ text: { type: 'string' }, count: { type: 'integer' }, ratio: { type: 'number' }, flag: { type: 'boolean' }, config: { type: 'object' }, entries: { type: 'array' } }, { note: { type: 'string' } });
  const input = { text: '', count: -3, ratio: 0.25, flag: false, config: { nested: [null, { value: 3 }] }, entries: [true, 'a', null] };
  const output = validateArguments(spec, input);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  assert.notEqual(output.config, input.config);
  assert.notEqual(output.config.nested, input.config.nested);
  output.config.nested[1].value = 10;
  assert.equal(input.config.nested[1].value, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(output)), output);
});

test('does not coerce types or accept null as a declared container', () => {
  const samples = {
    string: [1, false, null, [], {}],
    integer: ['2', true, null, 0.5, Number.MAX_SAFE_INTEGER + 1],
    number: ['2', false, null, {}, Infinity, -Infinity, NaN],
    boolean: ['true', 0, null, {}, []],
    object: [null, [], 'x', 0],
    array: [null, {}, 'x', 0]
  };
  for (const [type, values] of Object.entries(samples)) {
    for (const value of values) rejectsProtocol(() => validateArguments(typed(type), { value }));
  }
  assert.equal(validateArguments(typed('integer'), { value: Number.MAX_SAFE_INTEGER }).value, Number.MAX_SAFE_INTEGER);
  assert.equal(validateArguments(typed('number'), { value: Number.MAX_VALUE }).value, Number.MAX_VALUE);
  assert.equal(Object.is(validateArguments(typed('number'), { value: -0 }).value, -0), false);
});

test('requires own declared arguments and rejects all undeclared fields', () => {
  const spec = action({ path: { type: 'string' } }, { recursive: { type: 'boolean' } });
  rejectsProtocol(() => validateArguments(spec, {}), /required argument/);
  rejectsProtocol(() => validateArguments(spec, { path: 'a', recursive: undefined }), /not JSON data/);
  rejectsProtocol(() => validateArguments(spec, { path: 'a', extra: 1 }), /undeclared argument/);
  rejectsProtocol(() => validateArguments({}, { toString: 'owned' }), /undeclared argument/);
  rejectsProtocol(() => validateArguments(spec, Object.create({ path: 'inherited' })));
  assert.deepEqual(validateArguments(action({ toString: { type: 'string' } }), { toString: 'own' }), { toString: 'own' });
});

test('checks string enum membership without changing whitespace or letter case', () => {
  const spec = action({ mode: { type: 'string', enumValues: ['read', ' write '] } });
  assert.deepEqual(validateArguments(spec, { mode: ' write ' }), { mode: ' write ' });
  rejectsProtocol(() => validateArguments(spec, { mode: 'READ' }), /declared enum/);
  rejectsProtocol(() => validateArguments(spec, { mode: 'write' }), /declared enum/);
});

test('rejects prototype pollution names at schema and nested argument boundaries', () => {
  for (const key of ['__proto__', 'prototype', 'constructor']) {
    const args = JSON.parse(`{"value":{"nested":{"${key}":{"polluted":true}}}}`);
    rejectsProtocol(() => validateArguments(typed('object'), args), /unsafe object key/);
    const spec = JSON.parse(`{"required":{"${key}":{"type":"string"}}}`);
    rejectsProtocol(() => parseActionSpec(spec), /unsafe object key/);
  }
  assert.equal({}.polluted, undefined);
});

test('rejects non-JSON values even deep inside unshaped object and array arguments', () => {
  const circular = {}; circular.self = circular;
  for (const value of [undefined, () => {}, Symbol('x'), 1n, NaN, Infinity, new Date(), new Map(), Buffer.from('x'), new (class Value { constructor() { this.x = 1; } })(), circular]) {
    rejectsProtocol(() => validateArguments(typed('object'), { value: { nested: [value] } }));
  }
  rejectsProtocol(() => validateArguments(typed('array'), { value: new Array(2) }), /dense/);
  const extras = [1]; extras.extra = true;
  rejectsProtocol(() => validateArguments(typed('array'), { value: extras }), /extra properties/);
});

test('does not run accessors, toJSON hooks or proxy traps', () => {
  let effects = 0;
  const getter = {}; Object.defineProperty(getter, 'x', { enumerable: true, get() { effects++; return 1; } });
  rejectsProtocol(() => validateArguments(typed('object'), { value: getter }), /data property/);
  const hook = { toJSON() { effects++; return {}; } };
  rejectsProtocol(() => validateArguments(typed('object'), { value: hook }), /not JSON data/);
  const proxy = new Proxy({}, { getPrototypeOf() { effects++; return Object.prototype; }, ownKeys() { effects++; return []; }, get() { effects++; return 1; } });
  rejectsProtocol(() => validateArguments(typed('object'), { value: proxy }), /proxy/);
  assert.equal(effects, 0);
});

test('rejects symbol and non-enumerable properties instead of silently dropping them', () => {
  const symbol = { [Symbol('hidden')]: 'x' };
  rejectsProtocol(() => validateArguments(typed('object'), { value: symbol }), /symbol keys/);
  const hidden = {}; Object.defineProperty(hidden, 'x', { value: 'hidden' });
  rejectsProtocol(() => validateArguments(typed('object'), { value: hidden }), /enumerable data property/);
  const array = [1]; Object.defineProperty(array, '0', { enumerable: false });
  rejectsProtocol(() => validateArguments(typed('array'), { value: array }), /enumerable data elements/);
});

test('accepts null-prototype records and duplicates shared acyclic values safely', () => {
  const shared = Object.assign(Object.create(null), { value: [1, null] });
  const args = Object.assign(Object.create(null), { value: { first: shared, second: shared } });
  const result = validateArguments(typed('object'), args);
  assert.deepEqual(result, { value: { first: { value: [1, null] }, second: { value: [1, null] } } });
  assert.notEqual(result.value.first, result.value.second);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
});

test('bounds recursive, broad and string-heavy inputs with protocol errors', () => {
  let nested = {};
  for (let i = 0; i < JSON_LIMITS.maxDepth + 1; i++) nested = { inner: nested };
  rejectsProtocol(() => validateArguments(typed('object'), { value: nested }), /nesting limit/);
  rejectsProtocol(() => validateArguments(typed('array'), { value: new Array(JSON_LIMITS.maxNodes).fill(null) }), /value count limit/);
  rejectsProtocol(() => validateArguments(typed('string'), { value: 'x'.repeat(JSON_LIMITS.maxStringChars + 1) }), /string size limit/);
});

test('function schema reflects declared shape without claiming nested structure or permissions', () => {
  const spec = { description: 'Read safely', required: { path: { type: 'string', enumValues: ['a', 'b'] }, count: { type: 'integer' } }, optional: { filters: { type: 'object' }, values: { type: 'array', description: 'JSON values' } }, permissions: ['files.read'], datatype: 'workspace', timeoutMs: 25 };
  assert.deepEqual(toFunctionTool('workspace_read', spec), {
    type: 'function',
    function: { name: 'workspace_read', description: 'Read safely', parameters: {
      type: 'object', properties: { path: { type: 'string', enum: ['a', 'b'] }, count: { type: 'integer' }, filters: { type: 'object' }, values: { type: 'array', description: 'JSON values', items: {} } }, required: ['path', 'count'], additionalProperties: false
    } }
  });
  const tool = toFunctionTool('workspace_read', spec);
  tool.function.parameters.properties.path.enum.push('c');
  assert.deepEqual(spec.required.path.enumValues, ['a', 'b']);
  for (const name of ['', 'invalid.name', 'a'.repeat(65), null, '工具']) rejectsProtocol(() => toFunctionTool(name, {}));
});

test('diagnostic messages contain no argument values', () => {
  const marker = 'test-only-sensitive-value';
  assert.throws(() => validateArguments(typed('integer'), { value: marker }), error => !error.message.includes(marker) && error.path === 'args["value"]');
});
