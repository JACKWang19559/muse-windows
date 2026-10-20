'use strict';
const MAX_DOCX_FILE_BYTES=25*1024*1024;
function docxMime(name){return typeof name==='string'&&name.length>5&&!/[\\/\0]/.test(name)&&/\.docx$/i.test(name)?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':null;}
const isDocxFile=name=>docxMime(name)!==null;
module.exports={MAX_DOCX_FILE_BYTES,docxMime,isDocxFile};
