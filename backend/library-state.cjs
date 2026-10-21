'use strict';
const { types } = require('node:util');
const ID=/^[A-Za-z0-9_-]{1,100}$/;
function input(value,pin=false){
 if(!value||typeof value!=='object'||types.isProxy(value)||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw Error('资料库参数无效。');
 const allowed=['kind','id','workspaceId',...(pin?['pinned','expectedPinned']:[])],d=Object.getOwnPropertyDescriptors(value);
 for(const key of Reflect.ownKeys(d))if(typeof key!=='string'||!allowed.includes(key)||!d[key].enumerable||!Object.hasOwn(d[key],'value'))throw Error('资料库参数包含不支持的字段。');
 if(allowed.some(key=>!Object.hasOwn(d,key)))throw Error('资料库参数缺少必需的字段。');
 if(typeof value.kind!=='string'||!['file','artifact'].includes(value.kind)||typeof value.id!=='string'||!ID.test(value.id)||value.workspaceId!==null&&(typeof value.workspaceId!=='string'||!ID.test(value.workspaceId)))throw Error('资料库条目或空间无效。');
 if(pin&&(typeof value.pinned!=='boolean'||typeof value.expectedPinned!=='boolean'))throw Error('固定状态无效。');
 return{kind:value.kind,id:value.id,workspaceId:value.workspaceId,...(pin?{pinned:value.pinned,expectedPinned:value.expectedPinned}:{})};
}
const key=p=>p.kind+':'+p.id;
function target(value,files,artifacts){const p=input(value),item=(p.kind==='file'?files:artifacts).find(x=>x.id===p.id);if(!item)throw Error('资料库条目已不存在，请刷新后重试。');if(item.workspaceId!==p.workspaceId)throw Error('条目所属空间已变化，请刷新后重试。');return item;}
function pinList(value){
 if(value===undefined)return[];
 if(types.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>20000||Reflect.ownKeys(value).length!==value.length+1)throw Error('资料库固定列表无效。');
 const seen=new Set(),result=[];
 for(let i=0;i<value.length;i++){
  const descriptor=Object.getOwnPropertyDescriptor(value,String(i));
  if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))throw Error('资料库固定列表无效。');
  const p=input(descriptor.value),k=key(p);if(seen.has(k))throw Error('资料库固定条目重复。');seen.add(k);result.push(p);
 }
 return result;
}
function pins(value,files,artifacts){
 const byKind={file:new Map(files.map(item=>[item.id,item])),artifact:new Map(artifacts.map(item=>[item.id,item]))};
 return pinList(value).map(p=>{const item=byKind[p.kind].get(p.id);if(!item)throw Error('资料库条目已不存在，请刷新后重试。');if(item.workspaceId!==p.workspaceId)throw Error('条目所属空间已变化，请刷新后重试。');return p;});
}
module.exports={input,key,target,pinList,pins};
