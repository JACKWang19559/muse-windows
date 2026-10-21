import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {FileSpreadsheet,LoaderCircle,RefreshCw} from 'lucide-react';
import {SpreadsheetResource,spreadsheetKey} from './spreadsheet-resource.cjs';
import {columnName,cellStyle,sheetLayout,safeSpreadsheetLink} from './spreadsheet-layout.cjs';
import './spreadsheet-preview.css';

function Chart({chart}){
 const series=chart.series,count=Math.max(...series.map(s=>s.values.length),1),values=series.flatMap(s=>s.values.filter(Number.isFinite));let low=0,high=0;for(const v of values){low=Math.min(low,v);high=Math.max(high,v);}const span=high-low||1;
 const W=560,H=300,L=52,R=18,T=38,B=58,pw=W-L-R,ph=H-T-B,y=value=>T+ph-(value-low)/span*ph,step=pw/count,colors=['#4472c4','#ed7d31','#70ad47'];
 return <svg className="spreadsheet-chart" data-testid="spreadsheet-chart" data-chart-type={chart.type} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={chart.title||'工作表图表'}><rect width={W} height={H} fill="var(--surface,#fff)"/><text x={W/2} y={22} textAnchor="middle" fontSize="13" fontWeight="600">{chart.title}</text>
  {[0,.25,.5,.75,1].map(f=>{const value=low+span*f;return <g key={f}><line x1={L} x2={W-R} y1={y(value)} y2={y(value)} stroke="var(--border,#ddd)"/><text x={L-7} y={y(value)+4} textAnchor="end" fontSize="10">{Number(value.toPrecision(4))}</text></g>;})}
  <line x1={L} x2={W-R} y1={y(0)} y2={y(0)} stroke="var(--text-muted,#777)"/>
  {series.map((s,si)=>chart.type==='line'?<polyline key={si} fill="none" stroke={s.color||colors[si%3]} strokeWidth="2" points={s.values.map((v,i)=>Number.isFinite(v)?`${L+(i+.5)*step},${y(v)}`:null).filter(Boolean).join(' ')}/>:<g key={si}>{s.values.map((v,i)=>Number.isFinite(v)&&<rect key={i} x={L+(i+.12)*step+si*step*.76/series.length} y={Math.min(y(v),y(0))} width={Math.max(.4,step*.76/series.length-1)} height={Math.max(.5,Math.abs(y(v)-y(0)))} fill={s.color||colors[si%3]}/>)}</g>)}
  {(series[0]?.categories||[]).map((label,i)=>i%Math.max(1,Math.ceil(count/8))===0&&<text key={i} x={L+(i+.5)*step} y={H-B+16} textAnchor="middle" fontSize="10">{String(label).slice(0,12)}</text>)}
  {series.map((s,i)=><g key={i} transform={`translate(${L+i*Math.min(150,pw/series.length)},${H-17})`}><rect width="9" height="9" y="-8" fill={s.color||colors[i%3]}/><text x="14" fontSize="10">{s.name.slice(0,18)}</text></g>)}
 </svg>;
}
function Grid({sheet}){
 const ref=useRef(null),layout=useMemo(()=>sheetLayout(sheet),[sheet]),[viewport,setViewport]=useState({top:0,left:0,width:700,height:500});
 const update=()=>{const el=ref.current;if(el)setViewport({top:el.scrollTop,left:el.scrollLeft,width:el.clientWidth,height:el.clientHeight});};
 useLayoutEffect(()=>{const el=ref.current;if(!el)return;el.scrollTop=0;el.scrollLeft=0;update();const observer=new ResizeObserver(update);observer.observe(el);return()=>observer.disconnect();},[layout]);
 const {r0,r1,c0,c1}=layout.window(viewport.top,viewport.left,viewport.height,viewport.width),items=[],covered=new Set(),merges=[];
 for(const m of sheet.merges){if(m.top-1>r1||m.bottom-1<r0||m.left-1>c1||m.right-1<c0)continue;merges.push(m);for(let row=Math.max(r0+1,m.top);row<=Math.min(r1+1,m.bottom);row++)for(let col=Math.max(c0+1,m.left);col<=Math.min(c1+1,m.right);col++)covered.add(row+':'+col);}
 const drawCell=(row,col,merge)=>{const cell=layout.cells.get(row+':'+col),top=layout.rows[row-1],left=layout.columns[col-1],endRow=Math.min(merge?.bottom||row,layout.rows.length-1),endCol=Math.min(merge?.right||col,layout.columns.length-1),height=layout.rows[endRow]-top,width=layout.columns[endCol]-left;if(!height||!width)return;
  const link=safeSpreadsheetLink(cell?.link||'');items.push(<div role="cell" key={row+':'+col} aria-rowindex={row} aria-colindex={col} data-cell={columnName(col)+row} data-formula={cell?.formula||undefined} data-calculated={cell?.calculated?'true':undefined} className="spreadsheet-cell" style={{...cellStyle(cell),top:top+28,left:left+44,height,width}} title={cell?.formula?'='+cell.formula:cell?.text||''}>{link?<a href={link} onClick={event=>{event.preventDefault();if(event.isTrusted&&navigator.userActivation?.isActive)void window.muse.openSpreadsheetLink(link).catch(()=>{});}}>{cell?.text||link}</a>:cell?.text||''}</div>);};
 for(let row=r0+1;row<=r1+1;row++)for(let col=c0+1;col<=c1+1;col++)if(!covered.has(row+':'+col))drawCell(row,col);
 for(const m of merges)if(m.top<=1000)drawCell(m.top,m.left,m);
 const position=(starts,index,step)=>index<starts.length?starts[Math.max(0,index)]:starts.at(-1)+(index-starts.length+1)*step;
 const charts=sheet.charts.filter(c=>c.anchor.from.row<1000).map((chart,i)=>{const a=chart.anchor.from,b=chart.anchor.to,left=position(layout.columns,a.col,sheet.defaultColumnWidth||90)+44,top=position(layout.rows,a.row,sheet.defaultRowHeight||20)+28,width=Math.max(300,position(layout.columns,b.col,sheet.defaultColumnWidth||90)-left+44),height=Math.max(200,position(layout.rows,Math.min(1000,b.row),sheet.defaultRowHeight||20)-top+28);return{chart,i,left,top,width,height};});
 const physicalWidth=Math.max(layout.width+44,...charts.map(c=>c.left+c.width)),physicalHeight=Math.max(layout.height+28,...charts.map(c=>c.top+c.height));
 return <div className="spreadsheet-grid-scroll" ref={ref} onScroll={update} data-testid="spreadsheet-grid-scroll"><div role="table" aria-label={sheet.name} aria-rowcount={Math.min(sheet.rowCount,1000)} aria-colcount={sheet.columnCount} className="spreadsheet-grid" style={{width:physicalWidth,height:physicalHeight}} data-testid="spreadsheet-grid">
  {items}{charts.filter(c=>c.top+c.height>viewport.top-300&&c.top<viewport.top+viewport.height+300&&c.left+c.width>viewport.left-300&&c.left<viewport.left+viewport.width+300).map(({chart,i,left,top,width,height})=><div key={i} className="spreadsheet-chart-anchor" style={{left,top,width,height}}><Chart chart={chart}/></div>)}
  {Array.from({length:Math.max(0,r1-r0+1)},(_,i)=>{const row=r0+i;return <div key={'r'+row} className="spreadsheet-row-heading" style={{top:layout.rows[row]+28,height:layout.rows[row+1]-layout.rows[row],left:viewport.left}}>{row+1}</div>;})}
  {Array.from({length:Math.max(0,c1-c0+1)},(_,i)=>{const col=c0+i;return <div key={'c'+col} className="spreadsheet-column-heading" style={{left:layout.columns[col]+44,width:layout.columns[col+1]-layout.columns[col],top:viewport.top}}>{columnName(col+1)}</div>;})}
  <div className="spreadsheet-corner" style={{top:viewport.top,left:viewport.left}}/>
 </div></div>;
}
export default function SpreadsheetPreview({file}){
 const key=spreadsheetKey(file),[view,setView]=useState(null),[attempt,setAttempt]=useState(0),[selected,setSelected]=useState(0);
 useEffect(()=>{const resource=new SpreadsheetResource({readFile:window.muse.readSpreadsheetFile,onChange:value=>{setView(value);if(value.status==='ready')setSelected(Math.max(0,value.workbook.activeTab));}});void resource.load(file);return()=>resource.dispose();},[key,attempt]);
 const current=view?.key===key?view:{status:'loading'},workbook=current.workbook,sheet=workbook?.sheets[selected];
 return <div className="spreadsheet-preview" data-testid="spreadsheet-preview" data-state={current.status} data-file-id={file.id}>
  {current.status==='loading'?<div className="spreadsheet-status" role="status"><LoaderCircle size={20} className="spin"/>正在读取工作簿…</div>:current.status==='error'?<div className="spreadsheet-status" role="alert"><FileSpreadsheet size={26}/><p>{current.error}</p><button className="button secondary small" data-testid="spreadsheet-retry" onClick={()=>setAttempt(x=>x+1)}><RefreshCw size={13}/>重试</button></div>:!sheet?<div className="spreadsheet-status">这是一份空工作簿</div>:<>{sheet.rowCount===0&&!sheet.charts.length?<div className="spreadsheet-status" data-testid="spreadsheet-empty">这是一张空工作表</div>:<Grid key={key+':'+selected} sheet={sheet}/>}<div className="spreadsheet-tabs" role="tablist" aria-label="工作表">{workbook.sheets.map((s,i)=><button key={i} role="tab" aria-selected={selected===i} onClick={()=>setSelected(i)} data-testid="spreadsheet-tab">{s.name}{s.state!=='visible'?' · 隐藏':''}</button>)}</div><div className="spreadsheet-note">{sheet.rowCount} 行 · {sheet.columnCount} 列{sheet.rowCount>1000?' · 显示前 1000 行':''}{sheet.unrenderedCharts?' · 部分图表暂不支持':''}{sheet.ignoredMerges?' · 部分合并区域已修复':''}{sheet.cells.some(c=>c.calculationUnavailable)?' · 部分公式暂无计算结果':''} · 只读预览</div></>}
 </div>;
}
export {Chart,Grid};
