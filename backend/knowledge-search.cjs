'use strict';
const crypto = require('node:crypto');
const { types } = require('node:util');
const MAX_RECORDS = 5000, MAX_TERMS = 100000, MAX_POSTINGS = 300000, MAX_INDEX_BYTES = 16 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,100}$/, SHA = /^[a-f0-9]{64}$/;
const own = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
function invalid(reason) { const error = new TypeError(`记忆索引无效：${reason}`); error.code = 'ERR_MEMORY_INDEX'; throw error; }
function record(value,keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid('需要普通 JSON 对象');
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) invalid('包含未知字段');
    const descriptor = Object.getOwnPropertyDescriptor(value,key);
    if (!descriptor.enumerable || !own(descriptor,'value')) invalid('数据不能包含访问器或隐藏字段');
    result[key] = descriptor.value;
  }
  return result;
}
function dataField(value,key) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid('记忆条目格式无效');
  const descriptor = Object.getOwnPropertyDescriptor(value,key);
  if (!descriptor || !descriptor.enumerable || !own(descriptor,'value')) invalid(`条目缺少数据字段 ${key}`);
  return descriptor.value;
}
function array(value,max) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) invalid('列表格式或数量无效');
  const result = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value,String(index));
    if (!descriptor?.enumerable || !own(descriptor,'value')) invalid('列表须稠密且没有访问器');
    result.push(descriptor.value);
  }
  return result;
}
function identifier(value) { if (typeof value !== 'string' || !ID.test(value)) invalid('标识符无效'); return value; }
function workspace(value) { return value === null ? null : identifier(value); }
function revision(value) { if (!Number.isSafeInteger(value) || value < 1) invalid('版本须为正整数'); return value; }
function digest(value) { if (typeof value !== 'string' || !SHA.test(value)) invalid('校验值无效'); return value; }
function validText(value,maxBytes,maxPoints) {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > maxBytes || Array.from(value).length > maxPoints || Buffer.from(value).toString('utf8') !== value) invalid('文本格式或大小无效');
  return value;
}
function iso(value) { if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid('构建时间须为规范 UTC ISO'); return value; }
function scopeOf(value) { return value && typeof value === 'object' ? workspace(record(value,['workspaceId']).workspaceId ?? null) : workspace(value ?? null); }
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function selectedRecords(memories,workspaceId) {
  const output = [], seen = new Set();
  for (const source of array(memories,MAX_RECORDS)) {
    if (workspace(dataField(source,'workspaceId')) !== workspaceId) continue;
    const value = { id:identifier(dataField(source,'id')),name:validText(dataField(source,'name'),4096,1000),contentMarkdown:validText(dataField(source,'contentMarkdown'),1024*1024,200000),workspaceId,revision:revision(dataField(source,'revision')),digest:digest(dataField(source,'digest')) };
    if (seen.has(value.id)) invalid('记忆条目标识符重复');
    seen.add(value.id); output.push(value);
  }
  return output.sort((a,b)=>compare(a.id,b.id));
}
function sourceDigest(records) {
  const state = crypto.createHash('sha256');
  state.update('muse-memory-source-v1\n');
  for (const value of records) { state.update(JSON.stringify(value)); state.update('\n'); }
  return state.digest('hex');
}
function memorySourceDigest(memories,scope = null) { return sourceDigest(selectedRecords(memories,scopeOf(scope))); }

// Compatibility decomposition handles full-width text and decomposed accents.
// Each normalized code unit retains the original UTF-16 span for highlights.
function normalized(text,map = false) {
  let output = '',offset = 0; const spans = [];
  for (const point of text) {
    const value = point.normalize('NFKD').toLowerCase().replace(/ς/g,'σ');
    output += value;
    if (map) for (let i = 0; i < value.length; i++) spans.push({start:offset,end:offset+point.length});
    offset += point.length;
  }
  return {text:output,spans};
}
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
function frequencies(text) {
  const terms = new Map(), add = term => { if (term && term.length <= 128) terms.set(term,Math.min(200000,(terms.get(term)||0)+1)); };
  const input = normalized(text).text;
  for (const match of input.matchAll(/[\p{L}\p{N}\p{M}_]+/gu)) {
    let group = [],isCJK = null;
    const flush = () => {
      if (!group.length) return;
      if (isCJK) { if (group.length === 1) add(group[0]); else for (let index=0;index<group.length-1;index++) add(group[index]+group[index+1]); }
      else add(group.join(''));
      group = [];
    };
    for (const point of match[0]) { const next=CJK.test(point); if (isCJK !== null && next !== isCJK) flush(); isCJK=next;group.push(point); }
    flush();
  }
  return terms;
}
function tokenizeText(text) { validText(text,1024*1024,200000); return [...frequencies(text).keys()].sort(compare); }
function rawIndexHash(index) {
  return hash({schemaVersion:1,workspaceId:index.workspaceId,revision:index.revision,status:index.status,sourceDigest:index.sourceDigest,builtAt:index.builtAt,documents:index.documents,postings:index.postings,...index.errorCode?{errorCode:index.errorCode}:{}});
}
function rebuildMemoryIndex(memories,options = {}) {
  const value = record(options,['workspaceId','revision','builtAt']), workspaceId=workspace(value.workspaceId??null), nextRevision=revision(value.revision),builtAt=iso(value.builtAt);
  const records=selectedRecords(memories,workspaceId), common={schemaVersion:1,workspaceId,revision:nextRevision,status:'ready',sourceDigest:sourceDigest(records),builtAt};
  try {
    const byTerm=new Map();let postingCount=0;
    for (const entry of records) {
      const names=frequencies(entry.name),content=frequencies(entry.contentMarkdown),terms=new Set([...names.keys(),...content.keys()]);
      for (const term of terms) {
        if (!byTerm.has(term)) byTerm.set(term,[]);
        byTerm.get(term).push({id:entry.id,nameCount:names.get(term)||0,contentCount:content.get(term)||0});
        if (++postingCount>MAX_POSTINGS || byTerm.size>MAX_TERMS) throw Object.assign(new Error(),{capacity:true});
      }
    }
    const index={...common,documents:records.map(({id,revision,digest})=>({id,revision,digest})),postings:[...byTerm].sort(([a],[b])=>compare(a,b)).map(([term,documents])=>({term,documents}))};
    index.indexDigest=rawIndexHash(index);
    if (Buffer.byteLength(JSON.stringify(index))>MAX_INDEX_BYTES) throw Object.assign(new Error(),{capacity:true});
    return index;
  } catch(error) {
    const index={...common,status:'failed',documents:[],postings:[],errorCode:error?.capacity?'capacity':'build_failed'};
    return {...index,indexDigest:rawIndexHash(index)};
  }
}
function validateIndex(input,checkDigest) {
  const value=record(input,['schemaVersion','workspaceId','revision','status','sourceDigest','builtAt','indexDigest','documents','postings','errorCode']);
  if(value.schemaVersion!==1 || !['ready','failed'].includes(value.status))invalid('索引格式版本或状态无效');
  const result={schemaVersion:1,workspaceId:workspace(value.workspaceId),revision:revision(value.revision),status:value.status,sourceDigest:digest(value.sourceDigest),builtAt:iso(value.builtAt),documents:[],postings:[]};
  const docs=new Map();let previous='';
  for(const item of array(value.documents,MAX_RECORDS)){
    const doc=record(item,['id','revision','digest']),id=identifier(doc.id);
    if(compare(previous,id)>=0)invalid('文档必须按唯一标识符排序');previous=id;
    const normalized={id,revision:revision(doc.revision),digest:digest(doc.digest)};docs.set(id,normalized);result.documents.push(normalized);
  }
  previous='';let count=0;
  for(const item of array(value.postings,MAX_TERMS)){
    const entry=record(item,['term','documents']);
    if(typeof entry.term!=='string' || !entry.term || entry.term.length>128 || entry.term.includes('\0') || Buffer.from(entry.term).toString('utf8')!==entry.term || compare(previous,entry.term)>=0)invalid('索引词须唯一排序');previous=entry.term;
    const postings=[];let previousId='';
    for(const candidate of array(entry.documents,MAX_RECORDS)){
      const posting=record(candidate,['id','nameCount','contentCount']),id=identifier(posting.id);
      if(!docs.has(id)||compare(previousId,id)>=0 || !Number.isSafeInteger(posting.nameCount)||posting.nameCount<0||posting.nameCount>200000||!Number.isSafeInteger(posting.contentCount)||posting.contentCount<0||posting.contentCount>200000||posting.nameCount+posting.contentCount===0)invalid('索引关系无效');previousId=id;
      postings.push({id,nameCount:posting.nameCount,contentCount:posting.contentCount});if(++count>MAX_POSTINGS)invalid('索引超过容量');
    }
    if(!postings.length)invalid('索引词缺少文档');result.postings.push({term:entry.term,documents:postings});
  }
  if(value.status==='failed'){
    if(!['capacity','build_failed'].includes(value.errorCode)||result.documents.length||result.postings.length)invalid('失败索引包含不一致数据');result.errorCode=value.errorCode;
  }else if(own(value,'errorCode'))invalid('成功索引不能带错误码');
  if(checkDigest){result.indexDigest=digest(value.indexDigest);if(rawIndexHash(result)!==result.indexDigest)invalid('索引校验失败');}
  if(Buffer.byteLength(JSON.stringify(result))>MAX_INDEX_BYTES)invalid('索引校验失败');
  return result;
}
function validateMemoryIndex(input){return validateIndex(input,true);}
function indexHash(input){return rawIndexHash(validateIndex(input,false));}
function literalMatches(value,query) {
  const found=[];let offset=0;
  while(offset<=value.text.length-query.length && found.length<64){
    const position=value.text.indexOf(query,offset);if(position<0)break;
    const start=value.spans[position]?.start,end=value.spans[position+query.length-1]?.end;
    if(start!==undefined&&end!==undefined)found.push({start,length:end-start});offset=position+Math.max(1,query.length);
  }
  return found;
}
function snippet(text,matches) {
  const first=matches[0],start=Math.max(0,(first?.start||0)-80);let begin=start,end=Math.min(text.length,begin+400);
  if(begin&&/[\uDC00-\uDFFF]/.test(text[begin]))begin--;
  if(end<text.length&&/[\uDC00-\uDFFF]/.test(text[end]))end++;
  const prefix=begin?'…':'',result=prefix+text.slice(begin,end)+(end<text.length?'…':'');
  const highlights=[];
  for(const hit of matches.filter(hit=>hit.start>=begin&&hit.start+hit.length<=end).map(hit=>({start:prefix.length+hit.start-begin,length:hit.length})).sort((a,b)=>a.start-b.start||b.length-a.length)){
    const previous=highlights.at(-1);
    if(previous&&hit.start<=previous.start+previous.length)previous.length=Math.max(previous.start+previous.length,hit.start+hit.length)-previous.start;
    else highlights.push(hit);
  }
  return {snippet:result,highlights};
}
function searchMemories(memories,index,input={}) {
  const args=record(input,['workspaceId','query','limit','cursor','allowedIds']),workspaceId=workspace(args.workspaceId??null),limit=args.limit??20;
  if(typeof args.query!=='string'||args.query.length>500||args.query.includes('\0')||Buffer.from(args.query).toString('utf8')!==args.query||!Number.isSafeInteger(limit)||limit<1||limit>50)invalid('搜索条件无效');
  const query=args.query.trim(),queryNormalized=normalized(query).text;
  let allowed=null;
  if(own(args,'allowedIds')){const values=array(args.allowedIds,MAX_RECORDS).map(identifier);if(new Set(values).size!==values.length)invalid('允许条目重复');allowed=new Set(values);}
  if(index==null)return{status:'missing',reason:'index_missing'};
  let checked;try{checked=validateMemoryIndex(index);}catch{return{status:'failed',reason:'index_invalid'};}
  if(checked.workspaceId!==workspaceId)return{status:'missing',reason:'scope_index_missing'};
  const records=selectedRecords(memories,workspaceId),currentDigest=sourceDigest(records);
  if(currentDigest!==checked.sourceDigest)return{status:'stale',reason:'source_changed',indexRevision:checked.revision,sourceDigest:currentDigest};
  if(checked.status==='failed')return{status:'failed',reason:checked.errorCode,indexRevision:checked.revision,sourceDigest:currentDigest};
  const fingerprint=hash([workspaceId,currentDigest,checked.indexDigest,queryNormalized,allowed?[...allowed].sort(compare):null]);
  let offset=0;
  if(args.cursor!=null){
    if(typeof args.cursor!=='string'||args.cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(args.cursor))invalid('分页位置无效');
    let value;try{value=JSON.parse(Buffer.from(args.cursor,'base64url').toString('utf8'));}catch{invalid('分页位置无效');}
    if(!Array.isArray(value)||value.length!==3||value[0]!==fingerprint||!Number.isSafeInteger(value[1])||value[1]<0||value[2]!==1)invalid('搜索范围或索引已改变，请重新搜索');offset=value[1];
  }
  const terms=tokenizeText(query),scores=new Map(),termHits=new Map(),postings=new Map(checked.postings.map(entry=>[entry.term,entry.documents]));
  for(const term of terms)for(const hit of postings.get(term)||[]){if(allowed&&!allowed.has(hit.id))continue;scores.set(hit.id,(scores.get(hit.id)||0)+Math.min(5,hit.nameCount)*5+Math.min(5,hit.contentCount));termHits.set(hit.id,(termHits.get(hit.id)||0)+1);}
  const candidates=[];
  if(queryNormalized)for(const entry of records){
    if(allowed&&!allowed.has(entry.id))continue;
    const nameValue=normalized(entry.name,true),contentValue=normalized(entry.contentMarkdown,true);
    const nameMatches=literalMatches(nameValue,queryNormalized),contentMatches=literalMatches(contentValue,queryNormalized);
    let score=(scores.get(entry.id)||0)+(nameMatches.length?40:0)+(contentMatches.length?20:0);
    if(!score)continue;if(terms.length&&termHits.get(entry.id)===terms.length)score+=10;
    const matches=contentMatches.length?contentMatches:terms.slice(0,64).flatMap(term=>literalMatches(contentValue,term)).sort((a,b)=>a.start-b.start||a.length-b.length);
    candidates.push({id:entry.id,name:entry.name,workspaceId,revision:entry.revision,digest:entry.digest,score,...snippet(entry.contentMarkdown,matches)});
  }
  candidates.sort((a,b)=>b.score-a.score||compare(a.id,b.id));
  const hits=[];let bytes=0;
  for(const hit of candidates.slice(offset,offset+limit)){
    const size=Buffer.byteLength(JSON.stringify(hit))+1;
    if(hits.length&&bytes+size>40000)break;
    hits.push(hit);bytes+=size;
  }
  const next=offset+hits.length;
  return{status:'ready',indexRevision:checked.revision,sourceDigest:currentDigest,hits,total:candidates.length,nextCursor:next<candidates.length?Buffer.from(JSON.stringify([fingerprint,next,1])).toString('base64url'):null};
}
module.exports={MAX_RECORDS,MAX_INDEX_BYTES,tokenizeText,memorySourceDigest,rebuildMemoryIndex,validateMemoryIndex,indexHash,searchMemories};
