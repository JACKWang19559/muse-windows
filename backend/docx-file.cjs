'use strict';
const {readManagedBinary}=require('./managed-binary.cjs');
const {docxMime,MAX_DOCX_FILE_BYTES}=require('./docx-format.cjs');
function readManagedDocx(store,input){return readManagedBinary(store,input,{label:'Word 文档',mimeForName:docxMime,maxBytes:MAX_DOCX_FILE_BYTES,payload:'docx'});}
module.exports={readManagedDocx};
