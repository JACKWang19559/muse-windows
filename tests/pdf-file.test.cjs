'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {readManagedPdf}=require('../backend/pdf-file.cjs');
const {pdfMime,isPdfFile,MAX_PDF_FILE_BYTES}=require('../backend/pdf-format.cjs');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const binary=()=>Buffer.concat([Buffer.from('%PDF-1.7\r\n%'),Buffer.from([0,255,128,1,13,10,0]),Buffer.from('\r\n%%EOF')]);
function fixture(t,bytes=binary(),name='sample.pdf'){
 const parent=path.resolve(__dirname,'../.test-tmp/pdf-file');fs.mkdirSync(parent,{recursive:true});const dir=fs.mkdtempSync(path.join(parent,'pdf-'));
 t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),parent);assert(path.basename(dir).startsWith('pdf-'));fs.rmSync(dir,{recursive:true,force:true});});
 const stored=path.join(dir,'managed.bin');fs.writeFileSync(stored,bytes);const file={id:'pdf_fixture',name,size:bytes.length,sha256:digest(bytes)},calls=[];
 const store={getFile(id){calls.push(['get',id]);if(id!==file.id)throw Error('文件不存在。');return{...file};},filePath(id){calls.push(['path',id]);assert.equal(id,file.id);return stored;}};
 return{dir,stored,file,store,calls,input:()=>({id:file.id,expectedName:file.name,expectedSha256:file.sha256})};
}

test('PDF classification shares an exact case-insensitive suffix and rejects paths and misleading names',()=>{
 for(const name of ['report.pdf','report.PDF','报告.版本1.PdF']){assert.equal(pdfMime(name),'application/pdf');assert.equal(isPdfFile(name),true);}
 for(const name of ['pdf','.pdf','report.pdf.exe','report.pdf/child','folder/report.pdf','folder\\report.PDF','report.pdf?download','bad\0.pdf',null,{},42]){assert.equal(pdfMime(name),null);assert.equal(isPdfFile(name),false);}
 assert.equal(MAX_PDF_FILE_BYTES,25*1024*1024);
});

test('managed PDF preserves exact nontext bytes in an independently owned ArrayBuffer',t=>{
 const bytes=binary(),f=fixture(t,bytes),result=readManagedPdf(f.store,f.input());
 assert.deepEqual(Object.keys(result).sort(),['id','name','mimeType','size','sha256','pdf'].sort());assert.equal(Object.prototype.toString.call(result.pdf),'[object ArrayBuffer]');assert.deepEqual(Buffer.from(result.pdf),bytes);
 assert.equal(result.mimeType,'application/pdf');assert.equal(result.sha256,digest(bytes));assert.equal(result.size,bytes.length);assert(!JSON.stringify(result).includes(f.dir));
 new Uint8Array(result.pdf).fill(0);assert.deepEqual(fs.readFileSync(f.stored),bytes);assert.deepEqual(Buffer.from(readManagedPdf(f.store,f.input()).pdf),bytes);
});

test('PDF byte reader deliberately does not treat a filename as successful PDF parsing',t=>{
 const bytes=Buffer.concat([Buffer.from('\ufeffnot a PDF\r\n'),Buffer.from([0,255,128])]),f=fixture(t,bytes,'opaque.PDF');
 assert.deepEqual(Buffer.from(readManagedPdf(f.store,f.input()).pdf),bytes);assert.deepEqual(fs.readFileSync(f.stored),bytes);
 const nonpdf=fixture(t,bytes,'opaque.txt');assert.throws(()=>readManagedPdf(nonpdf.store,nonpdf.input()),/格式不支持/);assert.deepEqual(nonpdf.calls,[['get',nonpdf.file.id]]);
});

test('PDF reads reject caller paths unknown fields accessors inherited identities and invalid hashes before filesystem access',t=>{
 const f=fixture(t);let getterCalls=0;const getter={id:f.file.id,get expectedName(){getterCalls++;return f.file.name;}};
 for(const input of [null,[],{},getter,Object.create(f.input()),{...f.input(),path:f.stored},{...f.input(),rootDir:f.dir},{...f.input(),mimeType:'application/pdf'},{...f.input(),id:f.stored},{...f.input(),expectedName:''},{...f.input(),expectedName:'a'.repeat(241)},{...f.input(),expectedName:'bad\0.pdf'},{...f.input(),expectedSha256:'invalid'},{...f.input(),[Symbol('extra')]:true}])assert.throws(()=>readManagedPdf(f.store,input));
 assert.equal(getterCalls,0);assert.deepEqual(f.calls,[]);assert.throws(()=>readManagedPdf(f.store,{...f.input(),id:'missing_pdf'}),/不存在/);assert.equal(f.calls.some(([kind])=>kind==='path'),false);
});

test('PDF filename and optional caller digest fences reject stale selection without changing data',t=>{
 const f=fixture(t),old=f.input();f.file.name='renamed.PDF';assert.throws(()=>readManagedPdf(f.store,old),/文件名已变化/);assert.equal(f.calls.some(([kind])=>kind==='path'),false);
 assert.throws(()=>readManagedPdf(f.store,{...f.input(),expectedSha256:'0'.repeat(64)}),/已变化/);assert.deepEqual(Buffer.from(readManagedPdf(f.store,{...f.input(),expectedSha256:f.file.sha256.toUpperCase()}).pdf),binary());
 assert.deepEqual(Buffer.from(readManagedPdf(f.store,{id:f.file.id,expectedName:f.file.name}).pdf),binary());
});

test('PDF stored hash and size reject a changed managed file without relying on a renderer digest',t=>{
 const f=fixture(t),bytes=fs.readFileSync(f.stored);bytes[bytes.length-1]^=1;fs.writeFileSync(f.stored,bytes);assert.throws(()=>readManagedPdf(f.store,{id:f.file.id,expectedName:f.file.name}),/已变化/);
 delete f.file.sha256;fs.appendFileSync(f.stored,Buffer.from([1]));assert.throws(()=>readManagedPdf(f.store,{id:f.file.id,expectedName:f.file.name}),/已变化/);
});

test('PDF read IO failures close the descriptor and never expose internal paths',t=>{
 const f=fixture(t),open=fs.openSync,read=fs.readSync,close=fs.closeSync;let selected,closed=0;
 fs.openSync=(filename,...args)=>{const fd=open(filename,...args);if(filename===f.stored&&args[0]==='r')selected=fd;return fd;};fs.readSync=(fd,...args)=>{if(fd===selected)throw Object.assign(Error('PRIVATE_PATH '+f.stored),{code:'EIO'});return read(fd,...args);};fs.closeSync=fd=>{if(fd===selected)closed++;return close(fd);};
 try{assert.throws(()=>readManagedPdf(f.store,f.input()),e=>/无法读取/.test(e.message)&&!e.message.includes(f.dir)&&!e.message.includes('PRIVATE_PATH'));assert.equal(closed,1);}finally{fs.openSync=open;fs.readSync=read;fs.closeSync=close;}
 fs.unlinkSync(f.stored);assert.throws(()=>readManagedPdf(f.store,f.input()),e=>/无法读取/.test(e.message)&&!e.message.includes(f.dir));
});

test('PDF byte cap accepts exactly 25MiB and rejects larger files and directories',t=>{
 const f=fixture(t,Buffer.alloc(MAX_PDF_FILE_BYTES,173)),result=readManagedPdf(f.store,f.input());assert.equal(result.size,MAX_PDF_FILE_BYTES);assert.equal(new Uint8Array(result.pdf).at(-1),173);
 fs.truncateSync(f.stored,MAX_PDF_FILE_BYTES+1);assert.throws(()=>readManagedPdf(f.store,f.input()),/25 MiB/);assert.throws(()=>readManagedPdf({...f.store,filePath:()=>f.dir},f.input()),e=>!e.message.includes(f.dir));
});

test('PDF growth after stat cannot allocate an unbounded response and always closes its descriptor',t=>{
 const f=fixture(t),open=fs.openSync,read=fs.readSync,close=fs.closeSync;let selected,grown=false,readBytes=0,maxRequest=0,closed=0;
 fs.openSync=(filename,...args)=>{const fd=open(filename,...args);if(filename===f.stored&&args[0]==='r')selected=fd;return fd;};
 fs.readSync=(fd,...args)=>{if(fd===selected){maxRequest=Math.max(maxRequest,args[2]);if(!grown){grown=true;fs.truncateSync(f.stored,MAX_PDF_FILE_BYTES+1);}}const count=read(fd,...args);if(fd===selected)readBytes+=count;return count;};fs.closeSync=fd=>{if(fd===selected)closed++;return close(fd);};
 try{assert.throws(()=>readManagedPdf(f.store,f.input()),/25 MiB/);assert.equal(readBytes,MAX_PDF_FILE_BYTES+1);assert(maxRequest<=64*1024);assert.equal(closed,1);}finally{fs.openSync=open;fs.readSync=read;fs.closeSync=close;}
});
