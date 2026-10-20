import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, FileText, LoaderCircle, Trash2, X } from 'lucide-react';
import { isImageFile } from '../backend/image-format.cjs';
import ImagePreview from './ImagePreview.jsx';
import './image-preview.css';

const focusable = 'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]';
const ignoresNavigation = (target, panel) => target instanceof HTMLElement && (
  target !== document.body && !panel?.contains(target) ||
  target.isContentEditable || target.closest('input,textarea,select,video,audio,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]')
);
const fileError = error => (typeof error?.message === 'string' ? error.message : '')
  .replace(/^Error invoking remote method 'muse:invoke': (?:Error: )?/, '').trim() || '无法下载图片，请重试。';

export default function ImageLightbox({ selection, files, onClose, onOpenFile, onRemove, notify }) {
  const ids = [], seen = new Set(), byId = new Map(files.map(file => [file.id, file]));
  for (const id of selection.ids) {
    const file = byId.get(id);
    if (!seen.has(id) && file && isImageFile(file.name)) { seen.add(id); ids.push(id); }
  }
  const signature = JSON.stringify([selection.ids, selection.initialId, selection.wrap === true]);
  const initialIndex = Math.max(0, ids.indexOf(selection.initialId));
  const [position, setPosition] = useState(() => ({ signature, id: ids[initialIndex], index: initialIndex }));
  const activePosition = position.signature === signature ? position : { signature, id: ids[initialIndex], index: initialIndex };
  const existingIndex = ids.indexOf(activePosition.id);
  const index = existingIndex < 0 ? Math.min(activePosition.index, Math.max(0, ids.length - 1)) : existingIndex;
  const current = byId.get(ids[index]);
  const panel = useRef(null), closeButton = useRef(null), latest = useRef(null), alive = useRef(true);
  const downloadInFlight = useRef(false), gesture = useRef(null), suppressClick = useRef(false), closedEmpty = useRef(null);
  const [downloading, setDownloading] = useState(false);
  latest.current = { ids, index, current, signature, wrap: selection.wrap === true, onClose, onOpenFile, onRemove, notify };

  // Metadata refreshes keep the current stable ID; removing it selects the same
  // former position, clamped to the remaining gallery rather than restarting.
  useLayoutEffect(() => {
    if (position.signature !== signature || position.id !== ids[index] || position.index !== index) {
      setPosition({ signature, id: ids[index], index });
    }
  }, [signature, ids.join('\u0000'), index, position.signature, position.id, position.index]);
  useEffect(() => {
    if (ids.length) { closedEmpty.current = null; return; }
    if (closedEmpty.current !== signature) { closedEmpty.current = signature; latest.current.onClose(); }
  }, [signature, ids.length]);

  const navigate = direction => {
    const view = latest.current;
    if (view.ids.length < 2) return;
    let next = view.index + direction;
    if (view.wrap) next = (next + view.ids.length) % view.ids.length;
    else next = Math.max(0, Math.min(view.ids.length - 1, next));
    if (next !== view.index) setPosition({ signature: view.signature, id: view.ids[next], index: next });
  };
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement;
    let lastInside = closeButton.current;
    const modalOpen = () => document.querySelector('.modal-backdrop') !== null;
    const frame = requestAnimationFrame(() => { if (!modalOpen()) closeButton.current?.focus(); });
    const key = event => {
      // Capture before the hidden workbench's window shortcut can save a file.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault(); event.stopPropagation(); return;
      }
      if (modalOpen()) return;
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault(); event.stopPropagation(); latest.current.onClose(); return;
      }
      if (event.key === 'Tab') {
        const elements = [...(panel.current?.querySelectorAll(focusable) || [])].filter(element => element.getClientRects().length);
        const first = elements[0], last = elements.at(-1), active = document.activeElement;
        if (!first) { event.preventDefault(); panel.current?.focus(); }
        else if (!panel.current?.contains(active)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
        else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || ignoresNavigation(event.target, panel.current)) return;
      const view = latest.current;
      if (view.ids.length < 2) return;
      if (event.key === 'ArrowLeft' && (view.wrap || view.index > 0)) { event.preventDefault(); navigate(-1); }
      else if (event.key === 'ArrowRight' && (view.wrap || view.index < view.ids.length - 1)) { event.preventDefault(); navigate(1); }
    };
    const focus = event => {
      if (panel.current?.contains(event.target)) { lastInside = event.target; return; }
      if (!modalOpen()) (lastInside?.isConnected && !lastInside.disabled ? lastInside : closeButton.current)?.focus();
    };
    document.addEventListener('keydown', key, true);
    document.addEventListener('focusin', focus);
    return () => {
      alive.current = false; gesture.current = null;
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('focusin', focus);
      if (previous?.isConnected) previous.focus?.();
    };
  }, []);

  const download = async () => {
    const captured = latest.current.current;
    if (!captured || downloadInFlight.current) return;
    downloadInFlight.current = true; setDownloading(true);
    try {
      const result = await window.muse.exportFile({ id: captured.id });
      if (!result.cancelled) latest.current.notify?.('图片原始副本已下载');
    } catch (error) { latest.current.notify?.(fileError(error), 'error'); }
    finally { downloadInFlight.current = false; if (alive.current) setDownloading(false); }
  };
  const clickBackground = event => {
    if (suppressClick.current) { suppressClick.current = false; event.stopPropagation(); return; }
    if (event.target instanceof Element && event.target.closest('img,button,a,input,textarea,select,video,audio')) return;
    latest.current.onClose();
  };
  const pointerDown = event => {
    suppressClick.current = false;
    gesture.current = null;
    if (event.isPrimary === false || event.button !== 0 || event.target instanceof Element && event.target.closest('button,a,input,textarea,select,video,audio')) return;
    const view = latest.current;
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, signature: view.signature, id: view.current?.id };
  };
  const pointerUp = event => {
    const start = gesture.current; gesture.current = null;
    const view = latest.current;
    if (!start || start.pointerId !== event.pointerId || start.signature !== view.signature || start.id !== view.current?.id) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) && view.ids.length > 1) {
      suppressClick.current = true; navigate(dx > 0 ? -1 : 1);
    }
  };
  if (!current) return null;
  const previousEnabled = ids.length > 1 && (selection.wrap || index > 0);
  const nextEnabled = ids.length > 1 && (selection.wrap || index < ids.length - 1);
  return <section ref={panel} className="image-lightbox" role="dialog" aria-modal="true" aria-label={'图片预览 ' + current.name} tabIndex={-1} data-testid="image-lightbox" data-file-id={current.id} onClick={event => { if (event.target === event.currentTarget) clickBackground(event); }}>
    <header className="image-lightbox-header" onClick={event => event.stopPropagation()}>
      <button ref={closeButton} type="button" className="icon-button" aria-label="关闭图片预览" title="关闭图片预览" data-testid="image-lightbox-close" onClick={() => onClose()}><X size={20} /></button>
      <span className="image-lightbox-title" title={current.name} data-testid="image-lightbox-title">{current.name}</span>
      <span className="image-lightbox-counter" aria-live="polite" data-testid="image-lightbox-counter">{index + 1} / {ids.length}</span>
    </header>
    <div className="image-lightbox-stage" onClick={clickBackground} onPointerDown={pointerDown} onPointerUp={pointerUp} onPointerCancel={() => { gesture.current = null; }}>
      <ImagePreview key={current.id} file={current} />
      {ids.length > 1 && <>
        <button type="button" className="image-lightbox-nav previous" aria-label="上一张图片" title="上一张图片" data-testid="image-lightbox-previous" disabled={!previousEnabled} onClick={event => { event.stopPropagation(); navigate(-1); }}><ChevronLeft size={24} /></button>
        <button type="button" className="image-lightbox-nav next" aria-label="下一张图片" title="下一张图片" data-testid="image-lightbox-next" disabled={!nextEnabled} onClick={event => { event.stopPropagation(); navigate(1); }}><ChevronRight size={24} /></button>
      </>}
    </div>
    <footer className="image-lightbox-footer" onClick={event => event.stopPropagation()}>
      <button type="button" className="button secondary small" data-testid="image-lightbox-download" disabled={downloading} onClick={download}>{downloading ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}{downloading ? '正在下载…' : '下载原始副本'}</button>
      {onOpenFile && <button type="button" className="button secondary small" data-testid="image-lightbox-open-file" onClick={() => { const id = latest.current.current?.id; if (id) { onOpenFile(id); onClose(); } }}><FileText size={14} />文件工作台</button>}
      {onRemove && <button type="button" className="button ghost small" data-testid="image-lightbox-remove" onClick={() => { const captured = latest.current.current; if (captured) onRemove(captured); }}><Trash2 size={14} />移除</button>}
    </footer>
  </section>;
}
