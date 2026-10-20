'use strict';
const crypto = require('node:crypto');
const { types } = require('node:util');

// Windows host policy. A package declares requirements; it never grants them.
const HOST_TOOL_NAMES = Object.freeze([
  'workspace_list_files','workspace_read_file','workspace_create_text_file','workspace_save_text_file',
  'muse_list_apps','muse_read_app','muse_create_app','muse_write_app','muse_build_app',
  'muse_list_schedules','muse_read_schedule','muse_create_schedule','muse_update_schedule','muse_pause_schedule','muse_delete_schedule','muse_run_schedule',
  'memory_search','memory_read','memory_create','memory_update','memory_delete','memory_rebuild_index'
]);
const CONSENT_POLICY_REVISION = 1;
const MAX_GUIDANCE_BYTES = 100 * 1024;
const KEYS = ['name','description','version','manifestVersion','guidanceMarkdown','toolRequirements'];
function invalid(reason) { const error = new TypeError(`技能包无效：${reason}`); error.code = 'ERR_SKILL_PACKAGE'; throw error; }
const own = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
function record(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid('需要普通 JSON 对象');
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) invalid('包含未知字段');
    const descriptor = Object.getOwnPropertyDescriptor(value,key);
    if (!descriptor.enumerable || !own(descriptor,'value')) invalid('字段必须是数据');
    result[key] = descriptor.value;
  }
  return result;
}
function text(value, maximum, label, empty = false) {
  if (typeof value !== 'string' || !empty && !value.trim() || value.length > maximum || value.includes('\0') || Buffer.from(value,'utf8').toString('utf8') !== value) invalid(label);
  return value;
}
function requirements(value) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 50 || Reflect.ownKeys(value).length !== value.length + 1) invalid('工具要求必须是普通字符串数组');
  const result = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value,String(index));
    if (!descriptor?.enumerable || !own(descriptor,'value') || typeof descriptor.value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(descriptor.value)) invalid('工具要求名称无效');
    result.push(descriptor.value);
  }
  if (new Set(result).size !== result.length) invalid('工具要求不能重复');
  return result.sort();
}
function canonicalSkill(input) {
  const value = record(input,KEYS);
  text(value.name,320,'名称必须为 1 至 160 字符');
  text(value.description,8000,'描述必须为 1 至 4000 字符');
  if (Array.from(value.name).length>160 || Array.from(value.description).length>4000) invalid('名称或描述过长');
  if (/[\p{Cc}\p{Cf}]/u.test(value.name)) invalid('名称不能包含控制字符');
  if (typeof value.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(value.version)) invalid('版本名称无效');
  if (value.manifestVersion !== 1) invalid('仅支持 manifestVersion 1');
  const guidance = text(value.guidanceMarkdown,200000,'指导文本过长',true);
  if (Buffer.byteLength(guidance) > MAX_GUIDANCE_BYTES || Array.from(guidance).length > 100000) invalid('指导文本超过 100 KiB 或 100000 个字符');
  return { name:value.name,description:value.description,version:value.version,manifestVersion:1,guidanceMarkdown:guidance,toolRequirements:requirements(value.toolRequirements) };
}
function skillContentDigest(input) { return crypto.createHash('sha256').update(JSON.stringify(canonicalSkill(input))).digest('hex'); }
function skillEligibility(toolRequirements, availableToolNames = HOST_TOOL_NAMES) {
  if (types.isProxy(availableToolNames)) invalid('主机工具列表不能是代理');
  const host = Array.isArray(availableToolNames) ? requirements(availableToolNames) : availableToolNames instanceof Set ? requirements([...Set.prototype.values.call(availableToolNames)]) : invalid('主机工具列表格式无效');
  const selected = requirements(toolRequirements), available = new Set(host);
  const ineligibleReasons = [];
  for (const name of selected) {
    if (!HOST_TOOL_NAMES.includes(name)) ineligibleReasons.push(`unknown_tool_requirement:${name}`);
    else if (!available.has(name)) ineligibleReasons.push(`unavailable_tool_requirement:${name}`);
  }
  return { eligible:ineligibleReasons.length === 0,ineligibleReasons };
}
function scalar(source) {
  const value = source.trim();
  if (!value) invalid('元数据不能为空');
  if (value.startsWith('"')) { let parsed; try { parsed = JSON.parse(value); } catch { invalid('双引号元数据须为 JSON 字符串'); } if (typeof parsed !== 'string') invalid('元数据须为字符串'); return parsed; }
  if (value.startsWith("'")) { if (!value.endsWith("'") || value.length < 2 || /(^|[^'])'([^']|$)/.test(value.slice(1,-1))) invalid('单引号元数据无效'); return value.slice(1,-1).replace(/''/g,"'"); }
  if (/^[!&*|>{\[\]}]/.test(value) || /[\r\n]/.test(value)) invalid('不支持 YAML 对象、标签、锚点或多行语法');
  return value;
}
function parseSkillPackage(markdown) {
  text(markdown,150000,'SKILL.md 必须是有界 UTF-8 文本');
  if (Buffer.byteLength(markdown) > MAX_GUIDANCE_BYTES + 16384) invalid('技能包过长');
  const source = markdown.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
  if (!source.startsWith('---\n')) invalid('SKILL.md 须以受限 frontmatter 开始');
  const closing = /\n---(?:\n|$)/g; closing.lastIndex=4;
  const matchEnd=closing.exec(source),end=matchEnd?.index??-1;
  if (end < 0 || end > 16384) invalid('缺少 frontmatter 结束行');
  const header = source.slice(4,end), guidanceMarkdown = source.slice(end + matchEnd[0].length);
  const metadata = {}; let arrayKey = null;
  for (const line of header.split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\s+-\s+/.test(line)) {
      if (arrayKey !== 'toolRequirements') invalid('列表只能用于 toolRequirements');
      metadata.toolRequirements.push(scalar(line.replace(/^\s+-\s+/,''))); continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9]*):(?:\s+(.*)|\s*)$/.exec(line);
    if (!match || !['name','description','version','toolRequirements'].includes(match[1]) || own(metadata,match[1])) invalid('元数据包含未知、嵌套或重复字段');
    const key = match[1], value = match[2] ?? ''; arrayKey = null;
    if (key === 'toolRequirements') {
      if (!value.trim()) { metadata[key] = []; arrayKey = key; }
      else { try { metadata[key] = JSON.parse(value); } catch { invalid('工具要求须为 JSON 数组或缩进列表'); } }
    } else metadata[key] = scalar(value);
  }
  const result = canonicalSkill({ ...metadata,manifestVersion:1,guidanceMarkdown,toolRequirements:metadata.toolRequirements ?? [] });
  return { ...result,digest:skillContentDigest(result),...skillEligibility(result.toolRequirements) };
}
module.exports = { HOST_TOOL_NAMES, CONSENT_POLICY_REVISION, MAX_GUIDANCE_BYTES, parseSkillPackage, skillContentDigest, skillEligibility };
