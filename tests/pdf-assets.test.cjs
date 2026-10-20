'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {readPdfAsset,createPdfAssetReader,PDF_ASSETS,PDFJS_VERSION,MAX_PDF_ASSET_BYTES}=require('../backend/pdf-assets.cjs');
const directories={'standard-font':'standard_fonts',cmap:'cmaps',wasm:'wasm'},installed=path.resolve(__dirname,'../node_modules/pdfjs-dist');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t,kind='standard-font',name='FoxitFixed.pfb'){
 const parent=path.resolve(__dirname,'../.test-tmp/pdf-assets');fs.mkdirSync(parent,{recursive:true});const dir=fs.mkdtempSync(path.join(parent,'assets-')),root=path.join(dir,'pdfjs'),directory=path.join(root,directories[kind]);fs.mkdirSync(directory,{recursive:true});
 const file=path.join(directory,name);fs.copyFileSync(path.join(installed,directories[kind],name),file);
 t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),parent);assert(path.basename(dir).startsWith('assets-'));fs.rmSync(dir,{recursive:true,force:true});});
 return{dir,root,directory,file,input:{kind,name},read:createPdfAssetReader({rootDir:root})};
}

test('all 184 fixed PDF assets match actual 5.4.296 bytes and every response is a bounded owned ArrayBuffer',()=>{
 assert.equal(PDFJS_VERSION,'5.4.296');assert.equal(JSON.parse(fs.readFileSync(path.join(installed,'package.json'))).version,PDFJS_VERSION);assert.equal(MAX_PDF_ASSET_BYTES,512*1024);
 assert.deepEqual(Object.fromEntries(Object.entries(PDF_ASSETS).map(([kind,files])=>[kind,Object.keys(files).length])),{'standard-font':14,cmap:168,wasm:2});
 for(const[kind,files]of Object.entries(PDF_ASSETS))for(const[name,expected]of Object.entries(files)){
  assert(Object.isFrozen(files));assert(Object.isFrozen(expected));const result=readPdfAsset({kind,name}),original=fs.readFileSync(path.join(installed,directories[kind],name));
  assert.equal(Object.prototype.toString.call(result),'[object ArrayBuffer]');assert.equal(result.byteLength,expected.size);assert(result.byteLength<=MAX_PDF_ASSET_BYTES);assert.equal(hash(Buffer.from(result)),expected.sha256);assert.deepEqual(Buffer.from(result),original);
 }
});

test('PDF asset caller cannot read arbitrary names paths URIs licenses JS or unknown kinds and cannot invoke getters',()=>{
 let calls=0;const getter={kind:'cmap',get name(){calls++;return'H.bcmap';}},read=createPdfAssetReader({rootDir:'unreachable-assets-root'});
 const inputs=[null,[],{},getter,Object.create({kind:'cmap',name:'H.bcmap'}),{kind:'cmap',name:'../H.bcmap'},{kind:'cmap',name:'H.bcmap',path:'untrusted'},{kind:'cmap',name:'H.bcmap',rootDir:'untrusted'},{kind:'cmap',name:'%2e%2e%2fH.bcmap'},{kind:'cmap',name:'file:///H.bcmap'},{kind:'cmap',name:'https://example.invalid/H.bcmap'},{kind:'cmap',name:'H.bcmap\0'},{kind:'cmap',name:'h.bcmap'},{kind:'cmap',name:'LICENSE'},{kind:'standard-font',name:'LICENSE_FOXIT'},{kind:'wasm',name:'openjpeg_nowasm_fallback.js'},{kind:'__proto__',name:'toString'},{kind:'font',name:'FoxitFixed.pfb'},{kind:'cmap',name:'H.bcmap',[Symbol('extra')]:1}];
 for(const input of inputs)assert.throws(()=>read(input),e=>/参数|不支持/.test(e.message)&&!e.message.includes('unreachable-assets-root'));assert.equal(calls,0);
});

test('returned font bytes are isolated from the installed resource and later requests',()=>{
 const input={kind:'standard-font',name:'FoxitFixed.pfb'},first=readPdfAsset(input),expected=PDF_ASSETS[input.kind][input.name];new Uint8Array(first).fill(0);
 const second=readPdfAsset(input);assert.notEqual(first,second);assert.equal(hash(Buffer.from(second)),expected.sha256);assert.equal(hash(fs.readFileSync(path.join(installed,'standard_fonts',input.name))),expected.sha256);
});

test('PDF asset metadata and full pinned digest both reject tampered resources',t=>{
 const f=fixture(t),bytes=fs.readFileSync(f.file);bytes[0]^=1;fs.writeFileSync(f.file,bytes);assert.throws(()=>f.read(f.input),/重新安装/);
 fs.appendFileSync(f.file,Buffer.from([0]));assert.throws(()=>f.read(f.input),e=>/重新安装/.test(e.message)&&!e.message.includes(f.root));
});

test('PDF assets reject missing files and directories with path-free errors',t=>{
 const f=fixture(t);fs.unlinkSync(f.file);assert.throws(()=>f.read(f.input),e=>/重新安装/.test(e.message)&&!e.message.includes(f.root));fs.mkdirSync(f.file);assert.throws(()=>f.read(f.input),/重新安装/);
});

test('PDF asset directory and root junction aliases cannot escape fixed ordinary paths',t=>{
 const f=fixture(t),outside=path.join(f.dir,'outside'),alias=path.join(f.dir,'alias');fs.mkdirSync(outside);fs.renameSync(f.file,path.join(outside,f.input.name));fs.rmdirSync(f.directory);fs.symlinkSync(outside,f.directory,'junction');
 assert.throws(()=>f.read(f.input),/重新安装/);fs.unlinkSync(f.directory);fs.mkdirSync(f.directory);fs.copyFileSync(path.join(outside,f.input.name),f.file);fs.symlinkSync(f.root,alias,'junction');assert.throws(()=>createPdfAssetReader({rootDir:alias})(f.input),/重新安装/);
});

test('PDF asset growing after stat reads at most the declared size plus one byte',t=>{
 const f=fixture(t),expected=PDF_ASSETS[f.input.kind][f.input.name],open=fs.openSync,read=fs.readSync,close=fs.closeSync;let selected,grown=false,readBytes=0,maxRequest=0,closed=0;
 fs.openSync=(filename,...args)=>{const fd=open(filename,...args);if(filename===f.file&&args[0]===(fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)))selected=fd;return fd;};
 fs.readSync=(fd,...args)=>{if(fd===selected){maxRequest=Math.max(maxRequest,args[2]);if(!grown){grown=true;fs.truncateSync(f.file,MAX_PDF_ASSET_BYTES+1);}}const count=read(fd,...args);if(fd===selected)readBytes+=count;return count;};fs.closeSync=fd=>{if(fd===selected)closed++;return close(fd);};
 try{assert.throws(()=>f.read(f.input),/重新安装/);assert.equal(readBytes,expected.size+1);assert(maxRequest<=64*1024);assert.equal(closed,1);}finally{fs.openSync=open;fs.readSync=read;fs.closeSync=close;}
});

test('PDF asset read errors close descriptors and cannot leak the package path or raw IO message',t=>{
 const f=fixture(t),open=fs.openSync,read=fs.readSync,close=fs.closeSync;let selected,closed=0;
 fs.openSync=(filename,...args)=>{const fd=open(filename,...args);if(filename===f.file&&args[0]===(fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)))selected=fd;return fd;};fs.readSync=(fd,...args)=>{if(fd===selected)throw Object.assign(Error('PRIVATE_ASSET_PATH '+f.file),{code:'EIO'});return read(fd,...args);};fs.closeSync=fd=>{if(fd===selected)closed++;return close(fd);};
 try{assert.throws(()=>f.read(f.input),e=>/重新安装/.test(e.message)&&!e.message.includes(f.root)&&!e.message.includes('PRIVATE_ASSET_PATH'));assert.equal(closed,1);}finally{fs.openSync=open;fs.readSync=read;fs.closeSync=close;}
});

test('oversized PDF assets are rejected from metadata before any payload is read',t=>{
 const f=fixture(t,'wasm','openjpeg.wasm'),read=fs.readSync;let reads=0;fs.truncateSync(f.file,MAX_PDF_ASSET_BYTES+1);fs.readSync=(...args)=>{reads++;return read(...args);};
 try{assert.throws(()=>f.read(f.input),/重新安装/);assert.equal(reads,0);}finally{fs.readSync=read;}
});
