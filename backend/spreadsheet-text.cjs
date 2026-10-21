'use strict';
const {Worker,isMainThread,parentPort,workerData}=require('node:worker_threads');
const MAX_TEXT=200000;
if(!isMainThread&&workerData?.kind==='muse-owned-xlsx-text'){
 (async()=>{const {parseSpreadsheet,columnName}=require('./spreadsheet-model.cjs'),book=await parseSpreadsheet(workerData.bytes);let text='',truncated=false;
  outer:for(const sheet of book.sheets){text+='['+sheet.name+']\n';for(const cell of sheet.cells)if(cell.text!==''){const line=columnName(cell.col)+cell.row+': '+cell.text+'\n';if(text.length+line.length>MAX_TEXT){text+=line.slice(0,MAX_TEXT-text.length);truncated=true;break outer;}text+=line;}}
  parentPort.postMessage({text,truncated});
 })().catch(()=>parentPort.postMessage({error:true}));
}
function extractSpreadsheetText(input){
 const bytes=Uint8Array.from(input).buffer;
 return new Promise((resolve,reject)=>{
  let worker,done=false,timer;
  const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);void worker?.terminate();if(error)reject(Error('Spreadsheet text unavailable'));else resolve(result);};
  try{worker=new Worker(__filename,{workerData:{kind:'muse-owned-xlsx-text',bytes},transferList:[bytes],resourceLimits:{maxOldGenerationSizeMb:256,stackSizeMb:4}});
   timer=setTimeout(()=>finish(true),30000);
   worker.once('message',result=>{if(result?.error||typeof result?.text!=='string'||result.text.length>MAX_TEXT||typeof result.truncated!=='boolean')finish(true);else finish(false,result);});
   worker.once('error',()=>finish(true));worker.once('exit',()=>{if(!done)finish(true);});
  }catch{finish(true);}
 });
}
module.exports={extractSpreadsheetText};
