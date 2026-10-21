import React,{useEffect,useRef,useState} from 'react';
import {SpreadsheetResource,spreadsheetKey} from './spreadsheet-resource.cjs';
import {cellStyle,sheetLayout} from './spreadsheet-layout.cjs';
import './spreadsheet-preview.css';

const cache=new Map(),queue=[];let active=0;
function pump(){while(active<2&&queue.length){const job=queue.shift();if(job.cancelled)continue;active++;job.started=true;job.run(()=>{if(job.finished)return;job.finished=true;active--;pump();});}}
function enqueue(run){const job={run,cancelled:false,started:false,finished:false};queue.push(job);pump();return()=>{job.cancelled=true;if(!job.started){const index=queue.indexOf(job);if(index>=0)queue.splice(index,1);}};}
function remember(key,model){cache.delete(key);cache.set(key,model);while(cache.size>32)cache.delete(cache.keys().next().value);}
export default function SpreadsheetThumbnail({file}){
 const root=useRef(null),canvas=useRef(null),key=spreadsheetKey(file),[sheet,setSheet]=useState(()=>cache.get(key)||null),[theme,setTheme]=useState(()=>document.documentElement.dataset.theme||'light');
 useEffect(()=>{const observer=new MutationObserver(()=>setTheme(document.documentElement.dataset.theme||'light'));observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});return()=>observer.disconnect();},[]);
 useEffect(()=>{
  let disposed=false,resource=null,finish=null,cancel=null;setSheet(cache.get(key)||null);
  if(cache.has(key))return;
  const start=()=>{if(disposed||cancel)return;cancel=enqueue(done=>{finish=done;if(disposed){done();return;}resource=new SpreadsheetResource({readFile:window.muse.readSpreadsheetFile,onChange:view=>{if(disposed)return;if(view.status==='ready'){const model=view.workbook.sheets[0]||null;if(model){remember(key,model);setSheet(model);}done();}else if(view.status==='error')done();}});void resource.load(file,{onlyFirstSheet:true});});};
  const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){observer.disconnect();start();}},{rootMargin:'120px'});if(root.current)observer.observe(root.current);
  return()=>{disposed=true;observer.disconnect();cancel?.();resource?.dispose();finish?.();};
 },[key]);
 useEffect(()=>{
  const target=canvas.current;if(!target)return;const width=160,height=110,dpr=Math.min(3,Math.max(2,devicePixelRatio||1));target.width=width*dpr;target.height=height*dpr;const ctx=target.getContext('2d');ctx.scale(dpr,dpr);const dark=theme==='dark';ctx.fillStyle=dark?'#232824':'#fff';ctx.fillRect(0,0,width,height);
  if(!sheet){ctx.fillStyle=dark?'#a8c3a1':'#39794c';ctx.font='bold 22px sans-serif';ctx.fillText('XLSX',12,65);return;}
  const layout=sheetLayout(sheet),cols=Math.min(6,sheet.columnCount),rows=Math.min(20,sheet.rowCount),scale=width/Math.max(1,layout.columns[cols]);ctx.save();ctx.scale(scale,scale);const cover=new Set();
  const draw=(row,col,merge)=>{const cell=layout.cells.get(row+':'+col),style=cellStyle(cell),x=layout.columns[col-1],y=layout.rows[row-1],w=layout.columns[Math.min(merge?.right||col,cols)]-x,h=layout.rows[Math.min(merge?.bottom||row,rows)]-y;if(w<=0||h<=0)return;ctx.fillStyle=style.background||(dark?'#232824':'#fff');ctx.fillRect(x,y,w,h);ctx.strokeStyle=dark?'#465041':'#dedede';ctx.lineWidth=.7;ctx.strokeRect(x,y,w,h);ctx.save();ctx.beginPath();ctx.rect(x+2,y+1,w-4,h-2);ctx.clip();ctx.fillStyle=style.color||(dark?'#e7ebe3':'#222');ctx.font=(style.fontStyle==='italic'?'italic ':'')+(style.fontWeight?'bold ':'')+(style.fontSize||13)+'px sans-serif';ctx.textBaseline='middle';ctx.textAlign=style.textAlign==='right'?'right':style.textAlign==='center'?'center':'left';ctx.fillText(cell?.text||'',ctx.textAlign==='right'?x+w-4:ctx.textAlign==='center'?x+w/2:x+4,y+h/2);ctx.restore();};
  for(const m of sheet.merges){if(m.top>rows||m.left>cols)continue;draw(m.top,m.left,m);for(let row=m.top;row<=Math.min(m.bottom,rows);row++)for(let col=m.left;col<=Math.min(m.right,cols);col++)cover.add(row+':'+col);}
  for(let row=1;row<=rows;row++)for(let col=1;col<=cols;col++)if(!cover.has(row+':'+col))draw(row,col);ctx.restore();
 },[sheet,theme]);
 return <span ref={root} className="spreadsheet-thumbnail" data-testid="spreadsheet-thumbnail" data-state={sheet?'ready':'pending'} aria-hidden="true"><canvas ref={canvas}/></span>;
}
