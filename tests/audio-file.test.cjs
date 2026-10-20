'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {audioMime,readManagedAudio,MAX_AUDIO_FILE_BYTES}=require('../backend/audio-file.cjs');
function wav(){const b=Buffer.alloc(60);b.write('RIFF');b.writeUInt32LE(52,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(16,40);return b;}
test('audio signature guards distinguish supported containers from misleading extensions',()=>{
 assert.equal(audioMime('voice.wav',wav()),'audio/wav');for(const name of ['voice.txt','voice.mp3','voice.m4a'])assert.throws(()=>audioMime(name,wav()));assert.throws(()=>audioMime('voice.wav',Buffer.from('<html>not an audio file</html>')));
 for(const [name,signature,offset,mime]of [['clip.ogg','OggS',0,'audio/ogg'],['clip.flac','fLaC',0,'audio/flac'],['clip.m4a','ftyp',4,'audio/mp4'],['clip.mp3','ID3',0,'audio/mpeg']]){const b=Buffer.alloc(20);b.write(signature,offset);assert.equal(audioMime(name,b),mime);}
});
test('managed audio reads only the selected stored copy, verifies digest and returns owned binary without paths',t=>{
 const parent=path.resolve(__dirname,'../.test-tmp/audio-file');fs.mkdirSync(parent,{recursive:true});const folder=fs.mkdtempSync(path.join(parent,'audio-'));t.after(()=>{assert.equal(path.dirname(path.resolve(folder)),parent);fs.rmSync(folder,{recursive:true,force:true});});
 const file=path.join(folder,'stored.bin'),bytes=wav();fs.writeFileSync(file,bytes);const store={state:{files:[{id:'file-one',name:'clip.wav',_sha256:crypto.createHash('sha256').update(bytes).digest('hex')}]},filePath:id=>{assert.equal(id,'file-one');return file;}};
 const result=readManagedAudio(store,'file-one');assert.equal(result.mimeType,'audio/wav');assert.deepEqual(Buffer.from(result.audio),bytes);assert.equal('path'in result,false);assert.throws(()=>readManagedAudio(store,'unknown'));
 fs.writeFileSync(file,Buffer.from('changed bytes longer than twelve'));assert.throws(()=>readManagedAudio(store,'file-one'),/已经变化/);
 fs.writeFileSync(file,Buffer.alloc(MAX_AUDIO_FILE_BYTES+1));assert.throws(()=>readManagedAudio(store,'file-one'),/25 MB/);fs.unlinkSync(file);assert.throws(()=>readManagedAudio(store,'file-one'),error=>!error.message.includes(folder));
});
