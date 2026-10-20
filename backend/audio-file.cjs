'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const MAX_AUDIO_FILE_BYTES=25*1024*1024;
const AUDIO_EXTENSIONS=new Set(['wav','mp3','ogg','m4a','mp4','flac','webm','aac']);
function audioMime(name,bytes){
  const ext=path.extname(name).slice(1).toLowerCase();
  if(!AUDIO_EXTENSIONS.has(ext)||bytes.length<12)throw new Error('此文件不支持内置音频播放。');
  const ascii=(at,len)=>bytes.subarray(at,at+len).toString('ascii');
  if(ext==='wav'&&ascii(0,4)==='RIFF'&&ascii(8,4)==='WAVE')return 'audio/wav';
  if(ext==='mp3'&&(ascii(0,3)==='ID3'||bytes[0]===255&&(bytes[1]&224)===224))return 'audio/mpeg';
  if(ext==='ogg'&&ascii(0,4)==='OggS')return 'audio/ogg';
  if(ext==='flac'&&ascii(0,4)==='fLaC')return 'audio/flac';
  if(['m4a','mp4'].includes(ext)&&ascii(4,4)==='ftyp')return 'audio/mp4';
  if(ext==='webm'&&bytes.subarray(0,4).toString('hex')==='1a45dfa3')return 'audio/webm';
  if(ext==='aac'&&bytes[0]===255&&(bytes[1]&246)===240)return 'audio/aac';
  throw new Error('文件扩展名与音频格式不符，无法播放。');
}
function readManagedAudio(store,fileId){
  const item=store.state.files.find(file=>file.id===fileId);if(!item)throw new Error('音频文件已不存在。');
  let fd,bytes;
  try{
    const file=store.filePath(fileId);fd=fs.openSync(file,'r');const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.size>MAX_AUDIO_FILE_BYTES)throw new Error('音频文件超过 25 MB 或不是普通文件。');
    bytes=fs.readFileSync(fd);if(bytes.length>MAX_AUDIO_FILE_BYTES)throw new Error('音频文件超过 25 MB。');
    if(item._sha256&&crypto.createHash('sha256').update(bytes).digest('hex')!==item._sha256)throw new Error('文件副本已经变化，请重新导入。');
    const mimeType=audioMime(item.name,bytes);return {audio:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length),mimeType};
  }catch(error){if(error?.code)throw new Error('无法读取工作台中的音频副本。');throw error;}
  finally{bytes?.fill(0);if(fd!==undefined)fs.closeSync(fd);}
}
module.exports={readManagedAudio,audioMime,AUDIO_EXTENSIONS,MAX_AUDIO_FILE_BYTES};
