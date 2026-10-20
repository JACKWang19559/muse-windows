'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {readManagedVideo}=require('../backend/video-file.cjs');
const {readManagedImage}=require('../backend/image-file.cjs');
const {VIDEO_MIMES,MAX_VIDEO_FILE_BYTES,videoMime,isVideoFile,isPreviewMediaFile}=require('../backend/video-format.cjs');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const binary=()=>Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.from([0,255,128,1,13,10,0,37])]);
function fixture(t,bytes=binary(),name='sample.mp4'){
 const parent=path.resolve(__dirname,'../.test-tmp/video-file');fs.mkdirSync(parent,{recursive:true});const dir=fs.mkdtempSync(path.join(parent,'video-'));
 t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),parent);assert(path.basename(dir).startsWith('video-'));fs.rmSync(dir,{recursive:true,force:true});});
 const stored=path.join(dir,'managed.bin');fs.writeFileSync(stored,bytes);const file={id:'video_fixture',name,size:bytes.length,sha256:digest(bytes)},calls=[];
 const store={getFile(id){calls.push(['get',id]);if(id!==file.id)throw Error('文件不存在。');return{...file};},filePath(id){calls.push(['path',id]);assert.equal(id,file.id);return stored;}};
 return{dir,stored,file,store,calls,input:()=>({id:file.id,expectedName:file.name,expectedSha256:file.sha256})};
}
test('video suffix declarations cover six formats without asserting actual codec support',()=>{
 assert.deepEqual(Object.keys(VIDEO_MIMES),['mp4','webm','mov','m4v','avi','mkv']);
 for(const[ext,mime]of Object.entries(VIDEO_MIMES)){assert.equal(videoMime('video.'+ext.toUpperCase()),mime);assert.equal(isVideoFile('video.'+ext),true);assert.equal(isPreviewMediaFile('video.'+ext),true);}
 for(const name of ['mp4','video.mp4.exe','video.mp4/child','video.mov\\child','still.png',null,{}]){assert.equal(videoMime(name),null);assert.equal(isVideoFile(name),false);}
 assert.equal(isPreviewMediaFile('still.svg'),true);assert.equal(isPreviewMediaFile('notes.txt'),false);assert.equal(MAX_VIDEO_FILE_BYTES,25*1024*1024);
});
test('managed video returns an owned exact binary copy with only public metadata',t=>{
 const bytes=binary(),f=fixture(t,bytes),r=readManagedVideo(f.store,f.input());assert.deepEqual(Object.keys(r).sort(),['id','name','mimeType','size','sha256','video'].sort());
 assert.equal(Object.prototype.toString.call(r.video),'[object ArrayBuffer]');assert.deepEqual(Buffer.from(r.video),bytes);assert.equal(r.mimeType,'video/mp4');assert.equal(r.size,bytes.length);assert.equal(r.sha256,digest(bytes));
 new Uint8Array(r.video).fill(0);assert.deepEqual(fs.readFileSync(f.stored),bytes);assert.deepEqual(Buffer.from(readManagedVideo(f.store,f.input()).video),bytes);assert(!JSON.stringify(r).includes(f.dir));
 assert.deepEqual(f.calls,[['get',f.file.id],['path',f.file.id],['get',f.file.id],['path',f.file.id]]);
});
test('all declared containers preserve raw bytes and never decode, transcode or apply text normalization',t=>{
 const bytes=Buffer.concat([Buffer.from('\ufefffake-container\r\n'),Buffer.from([0,255,0,128,13,10])]);
 for(const[ext,mime]of Object.entries(VIDEO_MIMES)){const f=fixture(t,bytes,'container.'+ext),r=readManagedVideo(f.store,f.input());assert.equal(r.mimeType,mime);assert.deepEqual(Buffer.from(r.video),bytes);assert.deepEqual(fs.readFileSync(f.stored),bytes);}
});
test('video request accepts only own data fields and never consumes renderer paths or getters',t=>{
 const f=fixture(t);let getterCalls=0;const getter={id:f.file.id,get expectedName(){getterCalls++;return f.file.name;}};
 const inputs=[null,[],{},getter,Object.create(f.input()),{...f.input(),path:f.stored},{...f.input(),sourcePath:f.stored},{...f.input(),mimeType:'video/mp4'},{...f.input(),id:f.stored},{...f.input(),expectedName:''},{...f.input(),expectedName:'a'.repeat(241)},{...f.input(),expectedName:'bad\0.mp4'},{...f.input(),expectedSha256:'no-hash'},{...f.input(),[Symbol('extra')]:true}];
 for(const input of inputs)assert.throws(()=>readManagedVideo(f.store,input));assert.equal(getterCalls,0);assert.deepEqual(f.calls,[]);
 assert.throws(()=>readManagedVideo(f.store,{...f.input(),id:'missing_video'}),/不存在/);assert.equal(f.calls.some(([kind])=>kind==='path'),false);
});
test('video filename and digest fences reject stale selections while optional digest remains supported',t=>{
 const f=fixture(t),old=f.input();f.file.name='renamed.MOV';assert.throws(()=>readManagedVideo(f.store,old),/文件名已变化/);assert.equal(f.calls.some(([kind])=>kind==='path'),false);
 assert.throws(()=>readManagedVideo(f.store,{...f.input(),expectedSha256:'0'.repeat(64)}),/已变化/);const r=readManagedVideo(f.store,{...f.input(),expectedSha256:f.file.sha256.toUpperCase()});assert.equal(r.mimeType,'video/quicktime');assert.deepEqual(Buffer.from(r.video),binary());
 assert.deepEqual(Buffer.from(readManagedVideo(f.store,{id:f.file.id,expectedName:f.file.name}).video),binary());
});
test('image and video readers cannot be used interchangeably by changing request metadata',t=>{
 const video=fixture(t),image=fixture(t,Buffer.from('<svg/>'),'still.svg');assert.throws(()=>readManagedImage(video.store,video.input()),/格式不支持/);assert.deepEqual(video.calls,[['get',video.file.id]]);
 assert.throws(()=>readManagedVideo(image.store,image.input()),/格式不支持/);assert.deepEqual(image.calls,[['get',image.file.id]]);const opaque=fixture(t,binary(),'source.bin');assert.throws(()=>readManagedVideo(opaque.store,opaque.input()),/格式不支持/);assert.deepEqual(opaque.calls,[['get',opaque.file.id]]);
});
test('stored size and hash reject binary tampering even without caller-supplied digest',t=>{
 const f=fixture(t),bytes=fs.readFileSync(f.stored);bytes[bytes.length-1]^=1;fs.writeFileSync(f.stored,bytes);assert.throws(()=>readManagedVideo(f.store,{id:f.file.id,expectedName:f.file.name}),/已变化/);
 delete f.file.sha256;fs.appendFileSync(f.stored,Buffer.from([0]));assert.throws(()=>readManagedVideo(f.store,{id:f.file.id,expectedName:f.file.name}),/已变化/);
});
test('filesystem errors close video descriptors and omit internal filesystem paths',t=>{
 const f=fixture(t),open=fs.openSync,read=fs.readSync,close=fs.closeSync;let selected,closed=0;
 fs.openSync=(filename,...args)=>{const fd=open(filename,...args);if(filename===f.stored&&args[0]==='r')selected=fd;return fd;};
 fs.readSync=(fd,...args)=>{if(fd===selected)throw Object.assign(Error('PRIVATE_PATH '+f.stored),{code:'EIO'});return read(fd,...args);};fs.closeSync=fd=>{if(fd===selected)closed++;return close(fd);};
 try{assert.throws(()=>readManagedVideo(f.store,f.input()),e=>/无法读取/.test(e.message)&&!e.message.includes(f.dir)&&!e.message.includes('PRIVATE_PATH'));assert.equal(closed,1);}finally{fs.openSync=open;fs.readSync=read;fs.closeSync=close;}
 fs.unlinkSync(f.stored);assert.throws(()=>readManagedVideo(f.store,f.input()),e=>/无法读取/.test(e.message)&&!e.message.includes(f.dir));
});
test('25MiB is an inclusive video byte cap while directories and larger sources fail closed',t=>{
 const bytes=Buffer.alloc(MAX_VIDEO_FILE_BYTES,157),f=fixture(t,bytes),r=readManagedVideo(f.store,f.input());assert.equal(r.size,MAX_VIDEO_FILE_BYTES);assert.equal(new Uint8Array(r.video).at(-1),157);
 fs.truncateSync(f.stored,MAX_VIDEO_FILE_BYTES+1);assert.throws(()=>readManagedVideo(f.store,f.input()),/25 MiB/);assert.throws(()=>readManagedVideo({...f.store,filePath:()=>f.dir},f.input()),e=>!e.message.includes(f.dir));
});
test('a source growing after stat reads at most cap plus one byte and closes its video descriptor',t=>{
 const f=fixture(t),open=fs.openSync,read=fs.readSync,close=fs.closeSync;let selected,grown=false,readBytes=0,closed=0,maxRequest=0;
 fs.openSync=(filename,...args)=>{const fd=open(filename,...args);if(filename===f.stored&&args[0]==='r')selected=fd;return fd;};
 fs.readSync=(fd,...args)=>{if(fd===selected){maxRequest=Math.max(maxRequest,args[2]);if(!grown){grown=true;fs.truncateSync(f.stored,MAX_VIDEO_FILE_BYTES+1);}}const count=read(fd,...args);if(fd===selected)readBytes+=count;return count;};fs.closeSync=fd=>{if(fd===selected)closed++;return close(fd);};
 try{assert.throws(()=>readManagedVideo(f.store,f.input()),/25 MiB/);assert.equal(grown,true);assert.equal(readBytes,MAX_VIDEO_FILE_BYTES+1);assert(maxRequest<=64*1024);assert.equal(closed,1);}finally{fs.openSync=open;fs.readSync=read;fs.closeSync=close;}
});
