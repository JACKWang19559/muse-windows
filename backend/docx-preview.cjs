'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DOCX_URL}=require('./docx-preview-url.cjs');
function isDocxPreviewURL(value){try{const u=new URL(value);return u.protocol==='muse-docx:'&&u.hostname==='viewer'&&u.pathname==='/preview.html'&&!u.username&&!u.password&&!u.port&&!u.search&&(!u.hash||/^#[a-f0-9-]{36}$/.test(u.hash));}catch{return false;}}
function docxPreviewDocument(root,request){
 if(request.method!=='GET'||!isDocxPreviewURL(request.url))throw new Error('Invalid document preview request');
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'build','docx-preview.json'),'utf8'));
 const bytes=fs.readFileSync(path.join(root,'build','docx-preview.html'));
 const digest=crypto.createHash('sha256').update(bytes).digest('hex');
 if(manifest.schema!=='muse-owned-docx-preview-v1'||manifest.bytes!==bytes.length||manifest.sha256!==digest||typeof manifest.csp!=='string'||!/^sha256-[A-Za-z0-9+/]{43}=$/.test(manifest.scriptHash))throw new Error('Document preview is unavailable');
 const expected=`default-src 'none'; script-src '${manifest.scriptHash}'; script-src-attr 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src 'none'; media-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`;
 if(manifest.csp!==expected)throw new Error('Invalid document preview policy');
 return{bytes,csp:expected};
}
module.exports={DOCX_URL,isDocxPreviewURL,docxPreviewDocument};
