import React, { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, LoaderCircle, RefreshCw } from 'lucide-react';
import { ImageResource, imageKey } from './image-resource.cjs';
import './image-preview.css';

export default function ImagePreview({ file }) {
  const [view, setView] = useState(null), [attempt, setAttempt] = useState(0);
  const resource = useRef(null), key = imageKey(file);
  useEffect(() => {
    const current = new ImageResource({ readFile: window.muse.readImageFile, onChange: setView });
    resource.current = current; current.load(file);
    return () => { current.dispose(); if (resource.current === current) resource.current = null; };
  }, [key, attempt]);
  const current = view?.key === key ? view : { status: 'loading', url: null };
  return <div className="managed-image-preview" data-testid="image-preview" data-state={current.status}>
    {current.url && <img key={current.url} src={current.url} alt={file.name} draggable={false} data-testid="managed-image" onLoad={() => resource.current?.decoded(current.url)} onError={() => resource.current?.failed(current.url)} />}
    {['loading', 'prepared'].includes(current.status) && <div className="image-status" role="status"><LoaderCircle size={20} className="spin" /><span>正在读取图片…</span></div>}
    {current.status === 'error' && <div className="empty-preview image-failure" role="alert" data-testid="image-error"><ImageIcon size={28} /><h4>无法显示图片</h4><p>{current.error}</p><button className="button secondary small" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={13} />重试</button></div>}
  </div>;
}
