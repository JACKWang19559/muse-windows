import React, { useLayoutEffect, useRef, useState } from 'react';
import { FileText, LoaderCircle, RefreshCw } from 'lucide-react';
import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import { PdfSession } from './pdf-session.cjs';
import { PdfLayout, pdfKey } from './pdf-layout.cjs';
import './pdf-preview.css';

function PdfPage({ number, controller, layout, refresh }) {
  const canvas = useRef(null), [view, setView] = useState({ status: 'queued' });
  useLayoutEffect(() => {
    const listener = (index, value) => {
      if (index !== number) return;
      setView(value);
      if (value.cssWidth && value.cssHeight) { layout.measure(number, value.cssWidth, value.cssHeight); refresh(); }
    };
    controller.listeners.add(listener);
    const release = controller.session.attachPage(number, canvas.current);
    return () => { controller.listeners.delete(listener); release(); };
  }, [number, controller, layout]);
  const dimensions = layout.dimensions(number);
  return <section className="pdf-page" data-testid="pdf-page" data-page-number={number} data-pdf-state={view.status} style={{ height: layout.rowHeight(number) - 20 }} aria-label={'PDF 第 ' + number + ' 页'}>
    <canvas ref={canvas} data-testid="pdf-canvas" data-page-number={number} style={{ width: dimensions.width, height: dimensions.height, visibility: view.status === 'ready' ? 'visible' : 'hidden' }} />
    {['queued', 'rendering'].includes(view.status) && <div className="pdf-page-status" role="status"><LoaderCircle size={17} className="spin" /><span>正在绘制第 {number} 页…</span></div>}
    {view.status === 'error' && <div className="pdf-page-status pdf-page-error" role="alert"><p>{view.error}</p><button type="button" className="button secondary small" onClick={() => controller.session.retryPage(number)}><RefreshCw size={13} />重试此页</button></div>}
    {view.reduced && <span className="pdf-scale-notice">为控制内存，此页已缩小绘制</span>}
  </section>;
}

export default function PdfPreview({ file }) {
  const scroll = useRef(null), controller = useRef(null), layout = useRef(null), frame = useRef(null);
  const [view, setView] = useState(null), [attempt, setAttempt] = useState(0), [, redraw] = useState(0);
  const key = pdfKey(file);
  const refresh = () => { if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; redraw(x => x + 1); }); };
  useLayoutEffect(() => {
    const listeners = new Set(), current = { listeners, session: null };
    const session = new PdfSession({ pdfjs, readFile: input => window.muse.readPdfFile(input), readAsset: input => window.muse.readPdfAsset(input),
      workerSrc: new URL('pdf.worker.mjs', window.location.href).href, dpr: window.devicePixelRatio || 1,
      onChange: value => {
        if (value.status === 'ready') layout.current = new PdfLayout(value.numPages, value.firstSize);
        setView(value);
      }, onPage: (number, value) => { for (const listener of listeners) listener(number, value); } });
    current.session = session; controller.current = current;
    return () => { listeners.clear(); void session.dispose(); if (controller.current === current) controller.current = null; if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; };
  }, []);
  useLayoutEffect(() => {
    layout.current = null;
    if (scroll.current) scroll.current.scrollTop = 0;
    void controller.current?.session.load(file);
  }, [key, attempt]);
  useLayoutEffect(() => {
    const element = scroll.current; if (!element) return;
    const observer = new ResizeObserver(refresh); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const current = view?.key === key ? view : { status: 'loading', numPages: 0 };
  let range = null, pages = [];
  if (current.status === 'ready' && layout.current && scroll.current) {
    layout.current.resize(scroll.current.clientWidth, scroll.current.clientHeight);
    range = layout.current.window(scroll.current.scrollTop);
    for (let number = range.start; number <= range.end; number++) pages.push(number);
  }
  return <div ref={scroll} className="managed-pdf-preview" data-testid="pdf-preview" data-file-id={file.id} data-pdf-state={current.status} data-pdf-pages={current.numPages} data-pdf-worker={current.actualWorker ? 'real' : 'pending'} onScroll={refresh}>
    {current.status === 'loading' && <div className="pdf-document-status" role="status"><LoaderCircle size={22} className="spin" /><span>正在读取 PDF…</span></div>}
    {current.status === 'error' && <div className="empty-preview pdf-failure" role="alert" data-testid="pdf-error"><FileText size={28} /><h4>无法预览 PDF</h4><p>{current.error}</p><button type="button" className="button secondary small" data-testid="pdf-retry" onClick={() => setAttempt(x => x + 1)}><RefreshCw size={13} />重试</button></div>}
    {range && <div className="pdf-page-list"><div style={{ height: range.top }} aria-hidden="true" />{pages.map(number => <PdfPage key={key + ':' + attempt + ':' + number} number={number} controller={controller.current} layout={layout.current} refresh={refresh} />)}<div style={{ height: range.bottom }} aria-hidden="true" /></div>}
  </div>;
}
