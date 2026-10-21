import {parseSpreadsheet} from '../backend/spreadsheet-model.cjs';
self.addEventListener('message',async event=>{
 const {id,bytes,onlyFirstSheet}=event.data||{};
 if(!Number.isSafeInteger(id)||!(bytes instanceof ArrayBuffer))return;
 try{const workbook=await parseSpreadsheet(bytes,{onlyFirstSheet:onlyFirstSheet===true});self.postMessage({id,workbook});}
 catch{self.postMessage({id,error:'文件损坏、格式不支持，或超出预览资源限制。可下载原文件查看。'});}
 finally{try{new Uint8Array(bytes).fill(0);}catch{}}
});
