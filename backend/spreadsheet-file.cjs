'use strict';
const {readManagedBinary}=require('./managed-binary.cjs');
const {spreadsheetMime,MAX_SPREADSHEET_FILE_BYTES}=require('./spreadsheet-format.cjs');
function readManagedSpreadsheet(store,input){return readManagedBinary(store,input,{label:'Excel 工作簿',mimeForName:spreadsheetMime,maxBytes:MAX_SPREADSHEET_FILE_BYTES,payload:'spreadsheet'});}
module.exports={readManagedSpreadsheet};
