'use strict';

// Independently authored OOXML model. Archive relationships are local lookups;
// no URL, workbook script, macro, drawing image or external workbook is opened.
const JSZip=require('jszip');
const ExcelJS=require('../build/spreadsheet-exceljs.cjs');
const FormulaParser=require('fast-formula-parser');
const SSF=require('ssf');
const {DOMParser}=require('@xmldom/xmldom');
const {validateDocxPreviewZip:validateOOXMLZip}=require('../scripts/docx-zip.cjs');
const LIMITS=Object.freeze({sheets:256,cells:500000,rows:1048576,columns:16384,rowRecords:100000,columnSpan:65536,merges:5000,mergeArea:500000,formulas:10000,rangeCells:100000,depth:100,string:32767,charts:128,chartSeries:64,chartPoints:20000});
const MAIN='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PALETTE=['#4472c4','#ed7d31','#a5a5a5','#ffc000','#5b9bd5','#70ad47','#264478','#9e480e'];
const n=(value,fallback=0)=>value!==null&&value!==undefined&&!(typeof value==='string'&&value.trim()==='')&&Number.isFinite(Number(value))?Number(value):fallback;
const clamp=(value,lo,hi)=>Math.min(hi,Math.max(lo,value));
const text=node=>(node?.textContent||'').slice(0,LIMITS.string);
function children(node,name){return Array.from(node?.childNodes||[]).filter(x=>x.nodeType===1&&(!name||x.localName===name));}
const first=(node,name)=>children(node,name)[0];
const descendants=(node,name)=>Array.from(node?.getElementsByTagNameNS('*',name)||[]);
const attr=(node,key,fallback='')=>node?.getAttribute(key)||fallback;
const value=(node,name)=>text(first(node,name));
function xml(source){
 if(typeof source!=='string'||/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source))throw Error('Unsupported XML');
 let invalid=false;
 const doc=new DOMParser({onError:()=>{invalid=true;}}).parseFromString(source,'application/xml');
 if(invalid||!doc?.documentElement||descendants(doc,'parsererror').length)throw Error('Invalid XML');
 return doc;
}
function columnName(index){let out='';for(let v=index;v>0;v=Math.floor((v-1)/26))out=String.fromCharCode(65+(v-1)%26)+out;return out;}
function address(ref){const m=/^\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})$/.exec(ref||'');if(!m)return null;let col=0;for(const c of m[1].toUpperCase())col=col*26+c.charCodeAt(0)-64;const row=Number(m[2]);return col<=LIMITS.columns&&row<=LIMITS.rows?{row,col}:null;}
function range(ref){const[a,b]=String(ref||'').split(':'),start=address(a),end=address(b||a);return start&&end?{top:Math.min(start.row,end.row),left:Math.min(start.col,end.col),bottom:Math.max(start.row,end.row),right:Math.max(start.col,end.col)}:null;}
function safeLink(raw){try{if(typeof raw!=='string'||raw.length>8192||/[\u0000-\u001f\u007f]/.test(raw))return null;const u=new URL(raw);return ['http:','https:','mailto:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}}
function resolvePart(base,target){
 if(!target||/[\\\u0000-\u001f?#]/.test(target)||/^[a-z][\w+.-]*:/i.test(target))return null;
 const parts=target.startsWith('/')?[]:base.split('/').slice(0,-1);
 for(const part of target.split('/')){if(!part||part==='.')continue;if(part==='..'){if(!parts.length)return null;parts.pop();}else{let decoded;try{decoded=decodeURIComponent(part);}catch{return null;}if(/[\\/:\u0000-\u001f]/.test(decoded)||decoded==='.'||decoded==='..')return null;parts.push(part);}}
 return parts.join('/');
}
const relsName=part=>part.split('/').slice(0,-1).concat('_rels',part.split('/').at(-1)+'.rels').join('/');
function color(node,theme){if(!node)return null;const rgb=attr(node,'rgb');let hex=/^[\da-f]{8}$/i.test(rgb)?rgb.slice(2):/^[\da-f]{6}$/i.test(rgb)?rgb:null;
 if(!hex&&node.hasAttribute('theme'))hex=theme[n(attr(node,'theme'))]?.slice(1);
 if(!hex&&node.hasAttribute('indexed'))hex=['000000','ffffff','ff0000','00ff00','0000ff','ffff00','ff00ff','00ffff'][n(attr(node,'indexed'))%8];
 if(!hex)return null;const tint=clamp(n(attr(node,'tint')), -1,1),channels=hex.match(/../g).map(v=>parseInt(v,16));return '#'+channels.map(v=>Math.round(tint<0?v*(1+tint):v+(255-v)*tint).toString(16).padStart(2,'0')).join('');
}
function styles(doc,theme){
 const fonts=children(first(doc?.documentElement,'fonts'),'font').map(font=>({bold:!!first(font,'b')&&attr(first(font,'b'),'val','1')!=='0',italic:!!first(font,'i'),underline:!!first(font,'u'),strike:!!first(font,'strike'),size:clamp(n(attr(first(font,'sz'),'val'),11),5,100),name:attr(first(font,'name'),'val'),color:color(first(font,'color'),theme)}));
 const fills=children(first(doc?.documentElement,'fills'),'fill').map(fill=>{const pattern=first(fill,'patternFill');return attr(pattern,'patternType')==='solid'?color(first(pattern,'fgColor'),theme):null;});
 const borders=children(first(doc?.documentElement,'borders'),'border').map(border=>Object.fromEntries(['left','right','top','bottom'].map(side=>{const node=first(border,side);return[side,attr(node,'style')?{style:attr(node,'style'),color:color(first(node,'color'),theme)||'#888'}:null];})));
 const formats=new Map(children(first(doc?.documentElement,'numFmts'),'numFmt').map(x=>[n(attr(x,'numFmtId')),attr(x,'formatCode')]));
 return children(first(doc?.documentElement,'cellXfs'),'xf').map(x=>{const alignment=first(x,'alignment'),id=n(attr(x,'numFmtId'));return{font:fonts[n(attr(x,'fontId'))]||{},fill:fills[n(attr(x,'fillId'))]||null,border:borders[n(attr(x,'borderId'))]||{},numFmt:formats.get(id)||SSF.get_table()[id]||'General',alignment:{horizontal:attr(alignment,'horizontal'),vertical:attr(alignment,'vertical'),wrapText:attr(alignment,'wrapText')==='1',rotation:clamp(n(attr(alignment,'textRotation')),-90,90),indent:clamp(n(attr(alignment,'indent')),0,20)}};});
}
function display(cell,date1904){
 if(cell.error)return cell.error;
 if(cell.value===null||cell.value===undefined)return cell.formula?'='+cell.formula:'';
 if(typeof cell.value==='boolean')return cell.value?'TRUE':'FALSE';
 if(typeof cell.value==='number')try{return String(SSF.format(cell.style?.numFmt||'General',cell.value,{date1904}));}catch{}
 return String(cell.value).slice(0,LIMITS.string);
}
function mapFormulaTokens(formula,{reference=value=>value[0],number=value=>value}={}){
 let out='',i=0;
 while(i<formula.length){
  const rest=formula.slice(i),ch=formula[i];
  if(ch==='"'||ch==="'"){const quote=ch;let j=i+1;while(j<formula.length){if(formula[j]===quote){if(formula[j+1]===quote){j+=2;continue;}j++;break;}j++;}out+=formula.slice(i,j);i=j;continue;}
  if(ch==='['){const close=formula.indexOf(']',i+1),j=close<0?formula.length:close+1;out+=formula.slice(i,j);i=j;continue;}
  const numeric=/^(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/.exec(rest);
  if(numeric){out+=number(numeric[0]);i+=numeric[0].length;continue;}
  const cell=/^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d{0,6})/.exec(rest);
  if(cell&&!/[A-Za-z0-9_.(!]/.test(rest[cell[0].length]||' ')&&address(cell[2]+cell[4])){out+=reference(cell);i+=cell[0].length;continue;}
  const identifier=/^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest);
  if(identifier){out+=identifier[0];i+=identifier[0].length;}else{out+=ch;i++;}
 }
 return out;
}
function translateFormula(formula,from,to){const a=address(from),b=address(to);if(!a||!b)return formula;return mapFormulaTokens(formula,{reference:cell=>{const p=address(cell[2]+cell[4]),row=p.row+(cell[3]?0:b.row-a.row),col=p.col+(cell[1]?0:b.col-a.col);return row>0&&row<=LIMITS.rows&&col>0&&col<=LIMITS.columns?cell[1]+columnName(col)+cell[3]+row:'#REF!';}});}
function evaluableFormula(formula){return mapFormulaTokens(formula,{number:value=>{const m=/^(.+)[Ee]([+-]?\d+)$/.exec(value);return m?'('+m[1]+'*10^('+m[2]+'))':value;}});}

async function parseSpreadsheet(input,{onlyFirstSheet=false}={}){
 const bytes=input instanceof Uint8Array?input:new Uint8Array(input);
 const admission=validateOOXMLZip(bytes);
 const zip=await JSZip.loadAsync(bytes,{checkCRC32:false,createFolders:false});
 const cache=new Map();
 async function part(name,optional=false){if(!zip.file(name)){if(optional)return null;throw Error('Missing workbook part');}if(!cache.has(name))cache.set(name,xml(await zip.file(name).async('string')));return cache.get(name);}
 async function relationships(name){const doc=await part(relsName(name),true),map=new Map();for(const r of descendants(doc,'Relationship'))map.set(attr(r,'Id'),{target:attr(r,'Target'),external:attr(r,'TargetMode')==='External',type:attr(r,'Type'),path:attr(r,'TargetMode')==='External'?null:resolvePart(name,attr(r,'Target'))});return map;}
 const roots=await relationships(''),office=[...roots.values()].find(r=>r.type.endsWith('/officeDocument')&&!r.external);
 const workbookPart=office?.path||'xl/workbook.xml',workbook=await part(workbookPart),root=workbook.documentElement;
 if(root.localName!=='workbook')throw Error('Not an XLSX workbook');
 const links=await relationships(workbookPart),sheetNodes=children(first(root,'sheets'),'sheet');
 if(sheetNodes.length>LIMITS.sheets)throw Error('Workbook has too many sheets');
 const named=new Map(descendants(root,'definedName').map(x=>[attr(x,'name').toLowerCase(),text(x)]));
 const date1904=['1','true'].includes(attr(first(root,'workbookPr'),'date1904'));
 const stylePart=[...links.values()].find(r=>r.type.endsWith('/styles')&&!r.external)?.path;
 const stringPart=[...links.values()].find(r=>r.type.endsWith('/sharedStrings')&&!r.external)?.path;
 const themePart=[...links.values()].find(r=>r.type.endsWith('/theme')&&!r.external)?.path;
 const themeDoc=themePart?await part(themePart,true):null;
 const theme=children(descendants(themeDoc,'clrScheme')[0]).map(x=>{const y=children(x)[0];return '#'+(attr(y,'lastClr')||attr(y,'val')||'000000');});
 const styleTable=styles(stylePart?await part(stylePart,true):null,theme);
 const shared=stringPart?children((await part(stringPart)).documentElement,'si').map(si=>descendants(si,'t').map(text).join('')):[];
 const sheets=[];let cellsCount=0,rowRecords=0,mergeRecords=0,mergeArea=0;
 for(const node of sheetNodes){
  const relationship=links.get(node.getAttributeNS(REL,'id')||attr(node,'r:id'));
  if(!relationship?.path||relationship.external||!relationship.type.endsWith('/worksheet'))continue;
  const doc=await part(relationship.path),sheetRoot=doc.documentElement,view=first(first(sheetRoot,'sheetViews'),'sheetView'),pane=first(view,'pane');
  const sheet={name:attr(node,'name').slice(0,240),state:attr(node,'state','visible'),part:relationship.path,rowCount:0,columnCount:0,cells:[],rows:[],columns:[],merges:[],charts:[],unrenderedCharts:0,frozenRows:attr(pane,'state').startsWith('frozen')?n(attr(pane,'ySplit')):0,frozenCols:attr(pane,'state').startsWith('frozen')?n(attr(pane,'xSplit')):0,defaultRowHeight:clamp(n(attr(first(sheetRoot,'sheetFormatPr'),'defaultRowHeight'),15)*4/3,8,200),defaultColumnWidth:90};
  const formulaMasters=new Map();
  for(const row of children(first(sheetRoot,'sheetData'),'row')){
   if(++rowRecords>LIMITS.rowRecords)throw Error('Row metadata limit');
   const index=n(attr(row,'r'));if(index<1||index>LIMITS.rows)continue;
   sheet.rows.push({index,height:clamp(n(attr(row,'ht'),sheet.defaultRowHeight*3/4)*4/3,8,300),hidden:attr(row,'hidden')==='1'});
   for(const node of children(row,'c')){
    const loc=address(attr(node,'r'));if(!loc)continue;if(++cellsCount>LIMITS.cells)throw Error('Workbook has too many cells');
    const type=attr(node,'t'),raw=first(node,'v'),f=first(node,'f'),inline=first(node,'is');let val=raw?text(raw):null,error=null;
    if(type==='s')val=shared[n(val)]??'';else if(type==='inlineStr')val=descendants(inline,'t').map(text).join('');else if(type==='b')val=val==='1';else if(type==='e'){error=val||'#VALUE!';val=null;}else if(type==='d'){const dt=Date.parse(val);val=Number.isFinite(dt)?dt/86400000+(date1904?24107:25569):val;}else if(type!=='str'&&val!==null&&val!=='')val=Number.isFinite(Number(val))?Number(val):val;
    let formula=f?text(f):null;
    if(f&&attr(f,'t')==='shared'){const si=attr(f,'si');if(formula)formulaMasters.set(si,{formula,ref:attr(node,'r')});else{const master=formulaMasters.get(si);if(master)formula=translateFormula(master.formula,master.ref,attr(node,'r'));}}
    const cell={...loc,value:val,error,formula:formula||null,cached:!!raw,style:styleTable[n(attr(node,'s'))]||{},link:null};
    sheet.cells.push(cell);sheet.rowCount=Math.max(sheet.rowCount,loc.row);sheet.columnCount=Math.max(sheet.columnCount,loc.col);
   }
  }
  const normalizedColumns=new Map();let columnSpan=0;
  for(const col of children(first(sheetRoot,'cols'),'col')){const min=n(attr(col,'min'),1),max=n(attr(col,'max'),min);if(!Number.isInteger(min)||!Number.isInteger(max)||min<1||max<min||max>LIMITS.columns)throw Error('Invalid column metadata');columnSpan+=max-min+1;if(columnSpan>LIMITS.columnSpan)throw Error('Column metadata limit');const width=clamp(n(attr(col,'width'),12)*7+6,24,600),hidden=attr(col,'hidden')==='1';for(let index=min;index<=max;index++)normalizedColumns.set(index,{width,hidden});}
  let lastColumn=null;for(const[index,definition]of [...normalizedColumns].sort((a,b)=>a[0]-b[0])){if(lastColumn&&index===lastColumn.max+1&&definition.width===lastColumn.width&&definition.hidden===lastColumn.hidden)lastColumn.max=index;else{lastColumn={min:index,max:index,...definition};sheet.columns.push(lastColumn);}}
  sheet.ignoredMerges=0;
  for(const merge of children(first(sheetRoot,'mergeCells'),'mergeCell')){if(++mergeRecords>LIMITS.merges)throw Error('Merge metadata limit');const box=range(attr(merge,'ref'));if(!box){sheet.ignoredMerges++;continue;}if(sheet.merges.some(m=>box.top<=m.bottom&&box.bottom>=m.top&&box.left<=m.right&&box.right>=m.left)){sheet.ignoredMerges++;continue;}mergeArea+=(box.bottom-box.top+1)*(box.right-box.left+1);if(mergeArea>LIMITS.mergeArea)throw Error('Merge expansion limit');sheet.merges.push(box);sheet.rowCount=Math.max(sheet.rowCount,box.bottom);sheet.columnCount=Math.max(sheet.columnCount,box.right);}
  const rels=await relationships(relationship.path),map=new Map(sheet.cells.map(c=>[c.row+':'+c.col,c]));
  for(const h of children(first(sheetRoot,'hyperlinks'),'hyperlink')){
   const rel=rels.get(h.getAttributeNS(REL,'id')||attr(h,'r:id')),url=rel?.external?safeLink(rel.target):null,box=range(attr(h,'ref'));if(!url||!box||(box.bottom-box.top+1)*(box.right-box.left+1)>LIMITS.rangeCells)continue;
   for(let row=box.top;row<=box.bottom;row++)for(let col=box.left;col<=box.right;col++){const key=row+':'+col;let cell=map.get(key);if(!cell){if(++cellsCount>LIMITS.cells)throw Error('Workbook has too many cells');cell={row,col,value:attr(h,'display'),style:{},link:null};sheet.cells.push(cell);map.set(key,cell);}cell.link=url;}
  }
  Object.defineProperty(sheet,'_rels',{value:rels});Object.defineProperty(sheet,'_xml',{value:doc});Object.defineProperty(sheet,'_cells',{value:map});sheets.push(sheet);
 }
 const hasChart=Object.keys(zip.files).some(name=>/^xl\/charts\/[^/]+\.xml$/.test(name));
 let parser='ooxml',fallback=false;
 if(!hasChart){
  try{const book=new ExcelJS.Workbook();await book.xlsx.load(bytes);parser='exceljs';
   for(const sheet of sheets){const ws=book.getWorksheet(sheet.name);if(!ws)continue;for(const cell of sheet.cells){const parsed=ws.getCell(cell.row,cell.col);if(parsed.value&&typeof parsed.value==='object'&&parsed.value.richText)cell.richText=parsed.value.richText.map(r=>({text:String(r.text||'').slice(0,LIMITS.string),bold:!!r.font?.bold,italic:!!r.font?.italic}));}}
  }catch{fallback=true;}
 }
 const byName=new Map(sheets.map(s=>[s.name.toLowerCase(),s])),memo=new Map(),visiting=new Set(),parserCache=new Map();let formulaCount=0,depth=0;
 function target(name,current){return name?byName.get(String(name).toLowerCase()):current;}
 function evaluate(sheet,row,col){const cell=sheet?._cells.get(row+':'+col);if(!cell)return 0;if(!cell.formula||cell.cached)return cell.error?FormulaParser.FormulaError.VALUE:cell.value??0;
  const key=sheet.name+':'+row+':'+col;if(memo.has(key))return memo.get(key);if(visiting.has(key))throw Error('Circular formula');if(++formulaCount>LIMITS.formulas||depth>=LIMITS.depth)throw Error('Formula limit');depth++;visiting.add(key);
  try{const parserKey=sheet.name+':'+depth;let parser=parserCache.get(parserKey);if(!parser){parser=new FormulaParser({functions:{WEBSERVICE:()=>{throw Error('External function unavailable');}},onCell:ref=>{const selected=target(ref.sheet,sheet);if(!selected)throw FormulaParser.FormulaError.REF;return evaluate(selected,ref.row,ref.col);},onRange:ref=>{const selected=target(ref.sheet,sheet),from=ref.from,to=ref.to;if(!selected)throw FormulaParser.FormulaError.REF;if(!from||!to||(to.row-from.row+1)*(to.col-from.col+1)>LIMITS.rangeCells)throw Error('Range limit');const out=[];for(let r=from.row;r<=to.row;r++){const values=[];for(let c=from.col;c<=to.col;c++)values.push(evaluate(selected,r,c));out.push(values);}return out;},onVariable:name=>{const ref=named.get(String(name).toLowerCase());if(!ref)throw FormulaParser.FormulaError.NAME;const match=/^(?:'((?:[^']|'')+)'|([^!]+))!([$A-Z\d:]+)$/i.exec(ref);if(!match)throw FormulaParser.FormulaError.REF;const box=range(match[3]);if(!box)throw FormulaParser.FormulaError.REF;return {sheet:(match[1]||match[2]).replace(/''/g,"'"),from:{row:box.top,col:box.left},to:{row:box.bottom,col:box.right}};}});parserCache.set(parserKey,parser);}
   const result=parser.parse(evaluableFormula(cell.formula.replace(/^=/,'')),{sheet:sheet.name,row,col});
   if(result instanceof Error||result&&typeof result==='object'||typeof result==='number'&&!Number.isFinite(result))throw Error('Unsupported formula result');memo.set(key,result);cell.value=result;cell.calculated=true;return result;
  }finally{visiting.delete(key);depth--;}
 }
 for(const sheet of sheets)for(const cell of sheet.cells){
  if(cell.formula){const h=/^HYPERLINK\(\s*"((?:[^"]|"")*)"\s*[,;]\s*"((?:[^"]|"")*)"\s*\)$/i.exec(cell.formula);if(h){cell.link=safeLink(h[1].replace(/""/g,'"'));if(!cell.cached)cell.value=h[2].replace(/""/g,'"');}
   else if(!cell.cached)try{evaluate(sheet,cell.row,cell.col);}catch{cell.calculationUnavailable=true;}}
  cell.text=display(cell,date1904);
 }
 let chartPoints=0;const reservePoints=count=>{chartPoints+=count;if(chartPoints>LIMITS.chartPoints)throw Error('Chart point limit');};
 async function chartFor(partName,anchor){
  const doc=await part(partName),area=descendants(doc,'plotArea')[0],supported=children(area).find(x=>x.localName==='lineChart'||x.localName==='barChart'&&attr(first(x,'barDir'),'val')==='col');
  if(!supported)return null;
  function sequence(parent,numeric){const holder=children(parent).find(x=>/^(str|num)(Cache|Lit|Ref)$/.test(x.localName));if(!holder)return [];const data=first(holder,'numCache')||first(holder,'strCache')||holder,points=children(data,'pt');if(points.length){const result=[];for(const p of points){const index=n(attr(p,'idx'));if(index>10000)throw Error('Chart limit');result[index]=numeric?n(value(p,'v'),null):value(p,'v');}reservePoints(result.length);return Array.from(result,x=>x??(numeric?null:''));}
   const formula=value(holder,'f'),m=/^(?:'((?:[^']|'')+)'|([^!]+))!([$A-Z\d:]+)$/i.exec(formula);if(!m)return [];const sheet=byName.get((m[1]||m[2]).replace(/''/g,"'").toLowerCase()),box=range(m[3]);if(!sheet||!box||(box.bottom-box.top+1)*(box.right-box.left+1)>10000)return [];const result=[];for(let row=box.top;row<=box.bottom;row++)for(let col=box.left;col<=box.right;col++){const cell=sheet._cells.get(row+':'+col);result.push(numeric?(typeof cell?.value==='number'?cell.value:null):cell?.text||'');}reservePoints(result.length);return result;
  }
  const seriesNodes=children(supported,'ser');if(seriesNodes.length>LIMITS.chartSeries)throw Error('Chart series limit');
  const series=seriesNodes.map((ser,index)=>{const tx=first(ser,'tx'),name=value(tx,'v')||descendants(tx,'v').map(text).join('')||'系列 '+(index+1);return{name,values:sequence(first(ser,'val'),true),categories:sequence(first(ser,'cat'),false),color:color(descendants(ser,'srgbClr')[0]?{getAttribute:k=>k==='rgb'?attr(descendants(ser,'srgbClr')[0],'val'):'',hasAttribute:()=>false}:null,theme)||PALETTE[index%PALETTE.length]};}).filter(s=>s.values.length);
  if(!series.length)return null;const title=descendants(first(doc.documentElement,'chart'),'title').flatMap(x=>descendants(x,'t').map(text)).join('');
  return{type:supported.localName==='lineChart'?'line':'column',title,series,anchor};
 }
 let chartCount=0;
 for(const sheet of sheets)for(const drawing of descendants(sheet._xml,'drawing')){
  const rel=sheet._rels.get(drawing.getAttributeNS(REL,'id')||attr(drawing,'r:id'));if(!rel?.path||rel.external)continue;const doc=await part(rel.path),rels=await relationships(rel.path);
  for(const node of children(doc.documentElement))for(const chart of descendants(node,'chart')){if(++chartCount>LIMITS.charts)throw Error('Too many charts');const reference=rels.get(chart.getAttributeNS(REL,'id')||attr(chart,'r:id'));if(!reference?.path||reference.external)continue;const from=first(node,'from'),to=first(node,'to'),anchor={from:{row:n(value(from,'row')),col:n(value(from,'col'))},to:{row:n(value(to,'row'),n(value(from,'row'))+12),col:n(value(to,'col'),n(value(from,'col'))+8)}};
   const model=await chartFor(reference.path,anchor);if(model)sheet.charts.push(model);else sheet.unrenderedCharts++;
  }
 }
 let activeTab=clamp(n(attr(first(first(root,'bookViews'),'workbookView'),'activeTab')),0,Math.max(0,sheets.length-1));if(!sheets.length)activeTab=-1;
 if(onlyFirstSheet){const index=sheets.findIndex(s=>s.cells.some(c=>c.text!==''));const sheet=sheets[index<0?0:index];if(sheet){sheet.cells=sheet.cells.filter(c=>c.row<=20&&c.col<=20);sheet.rows=sheet.rows.filter(r=>r.index<=20);sheet.rowCount=Math.min(sheet.rowCount,20);sheet.columnCount=Math.min(sheet.columnCount,20);sheet.merges=sheet.merges.filter(m=>m.top<=20&&m.left<=20).map(m=>({...m,bottom:Math.min(m.bottom,20),right:Math.min(m.right,20)}));sheet.charts=[];sheets.splice(0,sheets.length,sheet);activeTab=0;}}
 for(const sheet of sheets){delete sheet.part;sheet.cells.sort((a,b)=>a.row-b.row||a.col-b.col);}
 return{schema:'muse-owned-spreadsheet-v1',parser,fallback,date1904,activeTab,sheets,admission:{inputBytes:admission.inputBytes,expandedBytes:admission.actualExpandedBytes,entries:admission.entryCount}};
}
module.exports={parseSpreadsheet,columnName,address,range,safeLink,resolvePart,translateFormula,evaluableFormula,LIMITS};
