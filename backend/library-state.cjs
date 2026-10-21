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
function moveFields(value,allowed,required=allowed){
 if(!value||typeof value!=='object'||types.isProxy(value)||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw Error('固定顺序参数无效。');
 const descriptors=Object.getOwnPropertyDescriptors(value);
 for(const name of Reflect.ownKeys(descriptors))if(typeof name!=='string'||!allowed.includes(name)||!descriptors[name].enumerable||!Object.hasOwn(descriptors[name],'value'))throw Error('固定顺序参数包含不支持的字段。');
 if(required.some(name=>!Object.hasOwn(descriptors,name)))throw Error('固定顺序参数缺少必需的字段。');
 return descriptors;
}
function moveInput(value){
 const fields=moveFields(value,['item','position','expectedOrder']),item=input(fields.item.value),position=moveFields(fields.position.value,['before','after'],[]),names=Object.keys(position);
 if(names.length!==1)throw Error('请选择一个固定项之前或之后的位置。');
 if(fields.expectedOrder.value===undefined)throw Error('预期固定顺序必须是完整列表。');
 const edge=names[0],anchor=input(position[edge].value),expectedOrder=pinList(fields.expectedOrder.value);
 if(item.workspaceId!==anchor.workspaceId)throw Error('只能调整同一空间内的固定顺序。');
 if(key(item)===key(anchor))throw Error('不能将固定项移动到它自身之前或之后。');
 if(expectedOrder.some(p=>p.workspaceId!==item.workspaceId))throw Error('预期固定顺序包含其他空间的条目。');
 return{item,position:{[edge]:anchor},expectedOrder};
}
function movePins(value,current,files,artifacts){
 const {item,position,expectedOrder}=value,edge=Object.keys(position)[0],anchor=position[edge];
 target(item,files,artifacts);target(anchor,files,artifacts);
 const scoped=current.filter(p=>p.workspaceId===item.workspaceId);
 if(scoped.length!==expectedOrder.length||scoped.some((p,i)=>p.kind!==expectedOrder[i].kind||p.id!==expectedOrder[i].id||p.workspaceId!==expectedOrder[i].workspaceId))throw Error('固定顺序已变化，请刷新后重试。');
 const itemKey=key(item),anchorKey=key(anchor);
 if(!scoped.some(p=>key(p)===itemKey)||!scoped.some(p=>key(p)===anchorKey))throw Error('移动条目和参照条目都必须已固定。');
 const ordered=scoped.filter(p=>key(p)!==itemKey),index=ordered.findIndex(p=>key(p)===anchorKey);
 ordered.splice(index+(edge==='after'?1:0),0,item);
 // Keep other scopes in their original global slots; only refill this scope.
 let next=0;return current.map(p=>p.workspaceId===item.workspaceId?ordered[next++]:p);
}
module.exports={input,key,target,pinList,pins,moveInput,movePins};
