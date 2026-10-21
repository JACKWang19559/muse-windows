'use strict';
const {isImageFile}=require('./image-format.cjs');
const {isVideoFile}=require('./video-format.cjs');
const AUDIO_EXTENSIONS=new Set(['wav','mp3','ogg','m4a','flac','aac']);

// Independent local adapters: original remote artifact types and fs services
// are not available in the Windows workspace. Classification never reads bytes.
const DOCUMENT_EXTENSIONS=new Set(['txt','text','md','markdown','mdx','pdf','doc','docx','odt','rtf','xls','xlsx','ods','csv','tsv','ppt','pptx','odp','json','jsonl','yaml','yml','toml','xml','html','htm','css','js','jsx','ts','tsx','py','rs','go','java','c','h','cpp','cs','sql','sh','ps1','log']);
const LIBRARY_VIEWS=Object.freeze(['all','documents','web','images','videos','audio','files']);
const LIBRARY_INTENTS=Object.freeze({document:'I want to create a document about ',image:'I want to create an image of ',video:'I want to create a video of ',web:'I want to create '});
function fileCategory(file){const name=typeof file?.name==='string'?file.name:'';if(isImageFile(name))return'images';if(isVideoFile(name))return'videos';const ext=/\.([^.\\/]+)$/.exec(name)?.[1].toLowerCase();if(AUDIO_EXTENSIONS.has(ext))return'audio';return DOCUMENT_EXTENSIONS.has(ext)?'documents':'files';}
function libraryItems({files=[],artifacts=[],workspaceId=null,pins=[]}={}){
 const scope=workspaceId??null;
 const orders=new Map(pins.filter(p=>p.workspaceId===scope).map((p,i)=>[(p.kind==='artifact'?'app:':'file:')+p.id,i]));
 return [...files.filter(x=>(x.workspaceId??null)===scope).map(file=>({key:'file:'+file.id,id:file.id,kind:'file',name:file.name,category:fileCategory(file),updatedAt:file.updatedAt||file.createdAt||null,createdAt:file.createdAt||null,size:Number.isFinite(file.size)?file.size:0,source:file})),...artifacts.filter(x=>(x.workspaceId??null)===scope).map(app=>({key:'app:'+app.id,id:app.id,kind:'artifact',name:app.name,category:'web',updatedAt:app.updatedAt||app.createdAt||null,createdAt:app.createdAt||null,size:null,source:app}))].map(item=>({...item,pinned:orders.has(item.key),pinnedOrder:orders.get(item.key)??null}));
}
function selectLibraryItems(items,{view='all',query='',sort='date'}={}){
 const category=LIBRARY_VIEWS.includes(view)?view:'all',needle=String(query).trim().toLocaleLowerCase();
 const matches=items.filter(x=>(category==='all'||category==='files'&&x.kind==='file'||x.category===category)&&(needle===''||x.name.toLocaleLowerCase().includes(needle)));
 const time=x=>Number.isFinite(Date.parse(x))?Date.parse(x):0,name=(a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true,sensitivity:'base'})||a.key.localeCompare(b.key);
 const artifactView=['all','documents','web'].includes(category);
 return matches.sort((a,b)=>artifactView&&(a.pinned||b.pinned)?Number(b.pinned)-Number(a.pinned)||(a.pinnedOrder??Number.MAX_SAFE_INTEGER)-(b.pinnedOrder??Number.MAX_SAFE_INTEGER)||a.key.localeCompare(b.key):sort==='name'?name(a,b):sort==='size'?(b.size??-1)-(a.size??-1)||name(a,b):time(b.createdAt)-time(a.createdAt)||name(a,b));
}
function libraryIntentTarget({kind,workspaceId=null,composerKey,narrow=false}){
 if(!Object.hasOwn(LIBRARY_INTENTS,kind))throw new Error('未知的创建需求。');
 return{prompt:LIBRARY_INTENTS[kind],key:narrow?`new:${workspaceId||'personal'}`:composerKey,route:narrow?{type:'welcome',workspaceId:workspaceId??null}:null};
}
module.exports={LIBRARY_VIEWS,LIBRARY_INTENTS,fileCategory,libraryItems,selectLibraryItems,libraryIntentTarget};
