'use strict';
const MAX_SPREADSHEET_FILE_BYTES=25*1024*1024;
const SPREADSHEET_MIME='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const isSpreadsheetFile=name=>typeof name==='string'&&!/[\\/:\0]/.test(name)&&/\.xlsx$/i.test(name);
const spreadsheetMime=name=>isSpreadsheetFile(name)?SPREADSHEET_MIME:null;
function spreadsheetLink(raw){try{if(typeof raw!=='string'||raw.length>8192||/[\u0000-\u001f\u007f]/.test(raw))return null;const u=new URL(raw);return ['http:','https:','mailto:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}}
module.exports={MAX_SPREADSHEET_FILE_BYTES,SPREADSHEET_MIME,isSpreadsheetFile,spreadsheetMime,spreadsheetLink};
