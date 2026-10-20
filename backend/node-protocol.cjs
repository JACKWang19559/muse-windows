'use strict';

const { types } = require('node:util');

// These fields/types are recovered from HatchNodeProtocol Swift metadata. The
// validation limits, defaults and JSON restrictions below are our host policy;
// they are not claims about Muse's original decoder or authorization behavior.
const NODE_ARG_TYPES = Object.freeze(['string', 'integer', 'number', 'boolean', 'object', 'array']);
const JSON_LIMITS = Object.freeze({ maxDepth: 64, maxNodes: 100000, maxStringChars: 8 * 1024 * 1024 });
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ACTION_KEYS = new Set(['description', 'required', 'optional', 'permissions', 'datatype', 'timeoutMs']);
const ARG_KEYS = new Set(['type', 'description', 'enumValues']);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

class ProtocolValidationError extends TypeError {
  constructor(path, reason) {
    super(`${path}: ${reason}`);
    this.name = 'ProtocolValidationError';
    this.code = 'ERR_NODE_PROTOCOL';
    this.path = path;
  }
}

function invalid(path, reason) { throw new ProtocolValidationError(path, reason); }
function childPath(path, key) { return `${path}[${JSON.stringify(String(key).slice(0, 80))}]`; }
function isRecord(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function requireRecord(value, path) {
  if (!isRecord(value)) invalid(path, 'expected a plain JSON object');
}

// Do not JSON.stringify untrusted input: getters/toJSON can execute code, and it
// silently drops undefined, symbols and non-enumerable properties. Inspect own
// descriptors and copy only data that has a lossless JSON representation.
function copyJson(value, path, state = { nodes: 0, stringChars: 0, ancestors: new Set() }, depth = 0) {
  if (depth > JSON_LIMITS.maxDepth) invalid(path, 'JSON nesting limit exceeded');
  if (++state.nodes > JSON_LIMITS.maxNodes) invalid(path, 'JSON value count limit exceeded');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    state.stringChars += value.length;
    if (state.stringChars > JSON_LIMITS.maxStringChars) invalid(path, 'JSON string size limit exceeded');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(path, 'expected a finite JSON number');
    return value === 0 ? 0 : value; // JSON has no separate negative zero.
  }
  if (typeof value !== 'object') invalid(path, 'value is not JSON data');
  if (types.isProxy(value)) invalid(path, 'proxy objects are not JSON data');
  if (state.ancestors.has(value)) invalid(path, 'cyclic JSON data');
  const array = Array.isArray(value);
  if (array ? Object.getPrototypeOf(value) !== Array.prototype : !isRecord(value)) {
    invalid(path, 'expected a plain JSON object or array');
  }
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) invalid(path, 'array must be dense and have no extra properties');
  if (keys.length > JSON_LIMITS.maxNodes - state.nodes + (array ? 1 : 0)) invalid(path, 'JSON value count limit exceeded');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  state.ancestors.add(value);
  try {
    if (array) {
      const output = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[index];
        const itemPath = `${path}[${index}]`;
        if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable) {
          invalid(itemPath, 'array must contain enumerable data elements');
        }
        output.push(copyJson(descriptor.value, itemPath, state, depth + 1));
      }
      return output;
    }
    const output = {};
    for (const key of keys) {
      if (typeof key !== 'string') invalid(path, 'symbol keys are not JSON data');
      const itemPath = childPath(path, key);
      if (BAD_KEYS.has(key)) invalid(itemPath, 'unsafe object key');
      state.stringChars += key.length;
      if (state.stringChars > JSON_LIMITS.maxStringChars) invalid(path, 'JSON string size limit exceeded');
      const descriptor = descriptors[key];
      if (!hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid(itemPath, 'expected an enumerable data property');
      output[key] = copyJson(descriptor.value, itemPath, state, depth + 1);
    }
    return output;
  } finally {
    state.ancestors.delete(value);
  }
}

function knownKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(childPath(path, key), 'unknown field');
  }
}
function optionalString(source, key, target, path) {
  if (!hasOwn(source, key) || source[key] === null) return;
  if (typeof source[key] !== 'string') invalid(childPath(path, key), 'expected a string or null');
  target[key] = source[key];
}
function stringList(value, path) {
  if (!Array.isArray(value)) invalid(path, 'expected a string array');
  for (let index = 0; index < value.length; index++) {
    if (typeof value[index] !== 'string') invalid(`${path}[${index}]`, 'expected a string');
  }
  return [...new Set(value)];
}
function parseArgSpec(value, path) {
  requireRecord(value, path);
  knownKeys(value, ARG_KEYS, path);
  if (!hasOwn(value, 'type') || !NODE_ARG_TYPES.includes(value.type)) invalid(childPath(path, 'type'), 'unknown argument type');
  const result = { type: value.type };
  optionalString(value, 'description', result, path);
  if (hasOwn(value, 'enumValues') && value.enumValues !== null) {
    // The original metadata only supplies string enum values. Reject ambiguous
    // non-string enums instead of guessing a string-to-number coercion policy.
    if (value.type !== 'string') invalid(childPath(path, 'enumValues'), 'string enums require type string');
    result.enumValues = stringList(value.enumValues, childPath(path, 'enumValues'));
    if (result.enumValues.length === 0) invalid(childPath(path, 'enumValues'), 'enum must contain at least one value');
  }
  return result;
}
function parseArgDictionary(value, path) {
  requireRecord(value, path);
  const result = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!name.length) invalid(path, 'argument names must not be empty');
    result[name] = parseArgSpec(entry, childPath(path, name));
  }
  return result;
}

/** Parse a field-based action specification; no authorization is granted here. */
function parseActionSpec(value) {
  const input = copyJson(value, 'spec');
  requireRecord(input, 'spec');
  knownKeys(input, ACTION_KEYS, 'spec');
  const result = {
    required: hasOwn(input, 'required') ? parseArgDictionary(input.required, 'spec.required') : {},
    optional: hasOwn(input, 'optional') ? parseArgDictionary(input.optional, 'spec.optional') : {},
    permissions: hasOwn(input, 'permissions') ? stringList(input.permissions, 'spec.permissions') : []
  };
  for (const name of Object.keys(result.required)) {
    if (hasOwn(result.optional, name)) invalid(childPath('spec.optional', name), 'argument is also declared required');
  }
  optionalString(input, 'description', result, 'spec');
  optionalString(input, 'datatype', result, 'spec');
  if (hasOwn(input, 'timeoutMs') && input.timeoutMs !== null) {
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > 0xffffffff) {
      invalid('spec.timeoutMs', 'expected UInt32 or null');
    }
    result.timeoutMs = input.timeoutMs;
  }
  return result;
}

function validateType(spec, value, path) {
  let valid = false;
  switch (spec.type) {
    case 'string': valid = typeof value === 'string'; break;
    case 'boolean': valid = typeof value === 'boolean'; break;
    case 'integer': valid = Number.isSafeInteger(value); break;
    case 'number': valid = typeof value === 'number' && Number.isFinite(value); break;
    case 'object': valid = isRecord(value); break;
    case 'array': valid = Array.isArray(value); break;
  }
  if (!valid) invalid(path, `expected ${spec.type}${spec.type === 'integer' ? ' (safe integer)' : ''}`);
  if (spec.enumValues && !spec.enumValues.includes(value)) invalid(path, 'value is outside the declared enum');
}

/** Validate, deep-copy and return arguments. Failures throw ProtocolValidationError. */
function validateArguments(spec, args) {
  const normalized = parseActionSpec(spec);
  const result = copyJson(args, 'args');
  requireRecord(result, 'args');
  for (const name of Object.keys(normalized.required)) {
    if (!hasOwn(result, name)) invalid(childPath('args', name), 'required argument is missing');
  }
  for (const [name, value] of Object.entries(result)) {
    const entry = hasOwn(normalized.required, name) ? normalized.required[name]
      : hasOwn(normalized.optional, name) ? normalized.optional[name] : undefined;
    if (!entry) invalid(childPath('args', name), 'undeclared argument');
    validateType(entry, value, childPath('args', name));
  }
  return result;
}

/** Convert only the recovered argument shape; permissions/timeouts stay host-side. */
function toFunctionTool(name, spec) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) invalid('name', 'expected 1–64 ASCII letters, digits, underscores or hyphens');
  const normalized = parseActionSpec(spec);
  const properties = {};
  for (const [key, entry] of Object.entries({ ...normalized.required, ...normalized.optional })) {
    const schema = { type: entry.type };
    if (hasOwn(entry, 'description')) schema.description = entry.description;
    if (hasOwn(entry, 'enumValues')) schema.enum = [...entry.enumValues];
    if (entry.type === 'array') schema.items = {}; // Item shape is not recovered.
    properties[key] = schema;
  }
  const fn = {
    name,
    parameters: { type: 'object', properties, required: Object.keys(normalized.required), additionalProperties: false }
  };
  if (hasOwn(normalized, 'description')) fn.description = normalized.description;
  return { type: 'function', function: fn };
}

module.exports = { NODE_ARG_TYPES, JSON_LIMITS, ProtocolValidationError, parseActionSpec, validateArguments, toFunctionTool };
