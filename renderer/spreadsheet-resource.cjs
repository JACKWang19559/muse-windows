'use strict';
const {isSpreadsheetFile,MAX_SPREADSHEET_FILE_BYTES,SPREADSHEET_MIME}=require('../backend/spreadsheet-format.cjs');
const spreadsheetKey=file=>JSON.stringify([file.id,file.name,file.sha256||'']);
const message=error=>(typeof error?.message==='string'?error.message:'').replace(/^Error invoking remote method 'muse:invoke': (?:Error: )?/,'').trim()||'无法读取工作簿，请重试。';
class SpreadsheetResource{
 constructor({readFile,onChange,createWorker=()=>new Worker(new URL('spreadsheet-worker.js',window.location.href)),setTimeout=(...args)=>globalThis.setTimeout(...args),clearTimeout=(...args)=>globalThis.clearTimeout(...args),timeoutMs=30000}){Object.assign(this,{readFile,onChange,createWorker,setTimeout,clearTimeout,timeoutMs});this.epoch=0;this.worker=null;this.timer=null;this.closed=false;}
 release(){if(this.timer!==null){this.clearTimeout(this.timer);this.timer=null;}if(this.worker){const worker=this.worker;this.worker=null;worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate();}}
 async load(file,{onlyFirstSheet=false}={}){
  if(this.closed)return;const epoch=++this.epoch,key=spreadsheetKey(file);this.release();const live=()=>!this.closed&&epoch===this.epoch;
  const fail=error=>{if(!live())return;this.release();this.onChange({key,status:'error',error:message(error)});};
  this.onChange({key,status:'loading'});let bytes;
  try{
   if(!isSpreadsheetFile(file.name))throw Error('此文件不支持 Excel 工作簿预览。');
   const result=await this.readFile({id:file.id,expectedName:file.name,...(file.sha256?{expectedSha256:file.sha256}:{})});bytes=result?.spreadsheet;
   if(!live()){if(bytes instanceof ArrayBuffer)new Uint8Array(bytes).fill(0);return;}
   if(result.id!==file.id||result.name!==file.name||result.mimeType!==SPREADSHEET_MIME||!(bytes instanceof ArrayBuffer)||bytes.byteLength!==result.size||!bytes.byteLength||bytes.byteLength>MAX_SPREADSHEET_FILE_BYTES||typeof result.sha256!=='string'||!/^[a-f0-9]{64}$/.test(result.sha256)||file.sha256&&file.sha256!==result.sha256)throw Error('工作簿副本已变化，请重新打开。');
   const worker=this.createWorker();this.worker=worker;
   worker.onmessage=event=>{if(!live()||this.worker!==worker||event.data?.id!==epoch)return;const workbook=event.data.workbook;if(event.data.error){fail(Error(event.data.error));return;}if(workbook?.schema!=='muse-owned-spreadsheet-v1'||!Array.isArray(workbook.sheets)||!Number.isInteger(workbook.activeTab)){fail(Error('工作簿预览数据无效。'));return;}this.release();this.onChange({key,status:'ready',workbook});};
   worker.onerror=event=>{event.preventDefault?.();fail(Error('工作簿解析中断，请重试。'));};worker.onmessageerror=()=>fail(Error('工作簿传输失败，请重试。'));
   this.timer=this.setTimeout(()=>fail(Error('工作簿解析超时，可下载原文件查看。')),this.timeoutMs);
   worker.postMessage({id:epoch,bytes,onlyFirstSheet},[bytes]);bytes=null;
  }catch(error){if(bytes instanceof ArrayBuffer&&bytes.byteLength)new Uint8Array(bytes).fill(0);fail(error);}
 }
 dispose(){if(this.closed)return;this.closed=true;this.epoch++;this.release();}
}
module.exports={SpreadsheetResource,spreadsheetKey};
