'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {readManagedImage}=require('../backend/image-file.cjs');
const {IMAGE_MIMES,MAX_IMAGE_FILE_BYTES,imageMime,isImageFile}=require('../backend/image-format.cjs');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const png=()=>Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=','base64');
function fixture(t,bytes=png(),name='sample.png'){
 const parent=path.resolve(__dirname,'../.test-tmp/image-file');fs.mkdirSync(parent,{recursive:true});const dir=fs.mkdtempSync(path.join(parent,'image-'));
 t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),parent);assert(path.basename(dir).startsWith('image-'));fs.rmSync(dir,{recursive:true,force:true});});
 const stored=path.join(dir,'managed.bin');fs.writeFileSync(stored,bytes);
 const file={id:'image_fixture',name,size:bytes.length,sha256:digest(bytes)},calls=[];
 const store={getFile(id){calls.push(['get',id]);if(id!==file.id)throw Error('文件不存在。');return{...file};},filePath(id){calls.push(['path',id]);assert.equal(id,file.id);return stored;}};
 return{dir,stored,file,store,calls,input:()=>({id:file.id,expectedName:file.name,expectedSha256:file.sha256})};
}
test('image format declarations recognize each supported suffix without promising browser decoding',()=>{
 assert.equal(Object.keys(IMAGE_MIMES).length,13);
 for(const [ext,mime]of Object.entries(IMAGE_MIMES)){assert.equal(imageMime('sample.'+ext.toUpperCase()),mime);assert.equal(isImageFile('sample.'+ext),true);}
 for(const name of ['png','picture.png.exe','sample.txt','sample.svg/child','sample.jpg\\child',null,{}]){assert.equal(imageMime(name),null);assert.equal(isImageFile(name),false);}
 assert.equal(imageMime('unsupported.heic'),'image/heic');assert.equal(MAX_IMAGE_FILE_BYTES,25*1024*1024);
});
test('managed image returns an exact owned binary copy and public metadata without filesystem paths',t=>{
 const bytes=png(),f=fixture(t,bytes),result=readManagedImage(f.store,f.input());
 assert.deepEqual(Object.keys(result).sort(),['id','name','mimeType','size','sha256','image'].sort());assert.equal(result.mimeType,'image/png');
 assert.equal(Object.prototype.toString.call(result.image),'[object ArrayBuffer]');assert.deepEqual(Buffer.from(result.image),bytes);assert.equal(result.sha256,digest(bytes));
 new Uint8Array(result.image).fill(0);assert.deepEqual(fs.readFileSync(f.stored),bytes);assert.deepEqual(Buffer.from(readManagedImage(f.store,f.input()).image),bytes);
 assert(!JSON.stringify(result).includes(f.dir));assert.deepEqual(f.calls,[['get',f.file.id],['path',f.file.id],['get',f.file.id],['path',f.file.id]]);
});
test('SVG image reading preserves BOM, CRLF and all original bytes without evaluating or rewriting XML',t=>{
 const bytes=Buffer.from('\ufeff<?xml version="1.0"?>\r\n<svg xmlns="http://www.w3.org/2000/svg"><text>汉字 &amp; text</text><script>throw new Error("MUST_NOT_RUN")</script></svg>\r\n');
 const f=fixture(t,bytes,'drawing.SVG'),result=readManagedImage(f.store,f.input());assert.equal(result.mimeType,'image/svg+xml');assert.deepEqual(Buffer.from(result.image),bytes);assert.deepEqual(fs.readFileSync(f.stored),bytes);
});
test('request accepts only own data fields and never interprets renderer paths or getters',t=>{
 const f=fixture(t);let getterCalls=0;const getter={id:f.file.id,get expectedName(){getterCalls++;return f.file.name;}};
 const inputs=[null,[],{},getter,Object.create(f.input()),{...f.input(),path:f.stored},{...f.input(),sourcePath:f.stored},{...f.input(),id:f.stored},{...f.input(),expectedName:''},{...f.input(),expectedName:'x'.repeat(241)},{...f.input(),expectedSha256:'not-a-digest'},{...f.input(),[Symbol('extra')]:true}];
 for(const input of inputs)assert.throws(()=>readManagedImage(f.store,input));assert.equal(getterCalls,0);assert.deepEqual(f.calls,[]);
 assert.throws(()=>readManagedImage(f.store,{...f.input(),id:'not_stored'}),/不存在/);assert.equal(f.calls.some(([kind])=>kind==='path'),false);
});
test('filename and supplied hash preconditions refuse stale images without returning data',t=>{
 const f=fixture(t),old=f.input();f.file.name='renamed.png';assert.throws(()=>readManagedImage(f.store,old),/文件名已变化/);assert.equal(f.calls.some(([kind])=>kind==='path'),false);
 assert.throws(()=>readManagedImage(f.store,{...f.input(),expectedSha256:'0'.repeat(64)}),/已变化/);
 assert.deepEqual(Buffer.from(readManagedImage(f.store,{...f.input(),expectedSha256:f.file.sha256.toUpperCase()}).image),png());
 assert.deepEqual(Buffer.from(readManagedImage(f.store,{id:f.file.id,expectedName:f.file.name}).image),png());
});
test('stored hash and size detect same-length tampering even when no expected hash is supplied',t=>{
 const f=fixture(t),bytes=fs.readFileSync(f.stored);bytes[bytes.length-1]^=1;fs.writeFileSync(f.stored,bytes);
 assert.throws(()=>readManagedImage(f.store,{id:f.file.id,expectedName:f.file.name}),/已变化/);
 delete f.file.sha256;fs.appendFileSync(f.stored,'one extra byte');assert.throws(()=>readManagedImage(f.store,{id:f.file.id,expectedName:f.file.name}),/已变化/);
});
test('unsupported suffixes fail before opening the managed source',t=>{
 const f=fixture(t,png(),'opaque.bin');assert.throws(()=>readManagedImage(f.store,f.input()),/格式不支持/);assert.deepEqual(f.calls,[['get',f.file.id]]);
});
test('filesystem read errors close the descriptor and expose no internal source path',t=>{
 const f=fixture(t),open=fs.openSync,read=fs.readSync,close=fs.closeSync;let selected,closed=0;
 fs.openSync=(filename,...args)=>{const fd=open(filename,...args);if(filename===f.stored&&args[0]==='r')selected=fd;return fd;};
 fs.readSync=(fd,...args)=>{if(fd===selected)throw Object.assign(Error('PRIVATE_PATH '+f.stored),{code:'EIO'});return read(fd,...args);};
 fs.closeSync=fd=>{if(fd===selected)closed++;return close(fd);};
 try{assert.throws(()=>readManagedImage(f.store,f.input()),error=>/无法读取/.test(error.message)&&!error.message.includes(f.dir)&&!error.message.includes('PRIVATE_PATH'));assert.equal(closed,1);}finally{fs.openSync=open;fs.readSync=read;fs.closeSync=close;}
 fs.unlinkSync(f.stored);assert.throws(()=>readManagedImage(f.store,f.input()),error=>/无法读取/.test(error.message)&&!error.message.includes(f.dir));
});
test('25MiB is an inclusive binary cap and oversized or directory sources cannot pass',t=>{
 const bytes=Buffer.alloc(MAX_IMAGE_FILE_BYTES,43),f=fixture(t,bytes);const result=readManagedImage(f.store,f.input());assert.equal(result.size,MAX_IMAGE_FILE_BYTES);assert.equal(new Uint8Array(result.image).at(-1),43);
 fs.truncateSync(f.stored,MAX_IMAGE_FILE_BYTES+1);assert.throws(()=>readManagedImage(f.store,f.input()),/25 MiB/);
 const directoryStore={...f.store,filePath:()=>f.dir};assert.throws(()=>readManagedImage(directoryStore,f.input()),error=>!error.message.includes(f.dir));
});
test('a file growing after descriptor stat is bounded at cap plus one byte and closes on rejection',t=>{
 const f=fixture(t),open=fs.openSync,read=fs.readSync,close=fs.closeSync;let selected,grown=false,readBytes=0,closed=0;
 fs.openSync=(filename,...args)=>{const fd=open(filename,...args);if(filename===f.stored&&args[0]==='r')selected=fd;return fd;};
 fs.readSync=(fd,...args)=>{if(fd===selected&&!grown){grown=true;fs.truncateSync(f.stored,MAX_IMAGE_FILE_BYTES+1);}const count=read(fd,...args);if(fd===selected)readBytes+=count;return count;};
 fs.closeSync=fd=>{if(fd===selected)closed++;return close(fd);};
 try{assert.throws(()=>readManagedImage(f.store,f.input()),/25 MiB/);assert.equal(grown,true);assert.equal(readBytes,MAX_IMAGE_FILE_BYTES+1);assert.equal(closed,1);}finally{fs.openSync=open;fs.readSync=read;fs.closeSync=close;}
});
