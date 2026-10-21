import React, { useLayoutEffect, useRef, useState } from 'react';
import { LoaderCircle, Pause, Play, RefreshCw, Video, Volume2, VolumeX } from 'lucide-react';
import { VideoResource, videoKey } from './video-resource.cjs';
import './video-preview.css';

const timeText = value => {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
};

export default function VideoPreview({ file, variant = 'inline' }) {
  const element = useRef(null), resource = useRef(null), seeking = useRef(null);
  const [view, setView] = useState(null), [attempt, setAttempt] = useState(0);
  const key = videoKey(file);
  const clearSeek = () => {
    const gesture = seeking.current;
    seeking.current = null;
    gesture?.cleanup();
  };
  useLayoutEffect(() => {
    const current = new VideoResource({ element: element.current, readFile: input => window.muse.readVideoFile(input), onChange: setView, variant });
    resource.current = current;
    return () => { current.dispose(); if (resource.current === current) resource.current = null; };
  }, [variant]);
  useLayoutEffect(() => { clearSeek(); void resource.current?.load(file); return clearSeek; }, [key, variant, attempt]);
  const current = view?.key === key ? view : { status: 'loading', url: null, decoded: false, paused: true, duration: 0, currentTime: 0 };
  const loading = current.status === 'loading' || current.status === 'prepared';
  const endSeek = event => {
    const gesture = seeking.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    clearSeek();
    // Up, cancellation and lost capture finish the same gesture exactly once.
    // Only its original source may resume; a replacement must remain untouched.
    if (gesture.resume && resource.current === gesture.controller && gesture.controller.epoch === gesture.epoch && gesture.controller.key === gesture.key) void gesture.controller.play();
  };
  return <div className={'managed-video-preview ' + variant} data-testid="video-preview" data-state={current.status} data-file-id={file.id} onClick={event => event.stopPropagation()}>
    <video ref={element} title={file.name} aria-label={file.name} controls={variant === 'inline'} playsInline data-testid="managed-video" onClick={() => { if (variant === 'lightbox') resource.current?.togglePlay(); }} />
    {loading && <div className="video-status" role="status"><LoaderCircle size={22} className="spin" /><span>正在读取视频…</span></div>}
    {current.status === 'error' && <div className="empty-preview video-failure" role="alert" data-testid="video-error"><Video size={28} /><h4>无法播放视频</h4><p>{current.error}</p><button type="button" className="button secondary small" data-testid="video-retry" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={13} />重试</button></div>}
    {current.notice && <p className="video-notice" role="status">{current.notice}</p>}
    {variant === 'lightbox' && current.status !== 'error' && <div className="video-controls" onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}>
      <button type="button" className="icon-button" aria-label={current.paused ? '播放视频' : '暂停视频'} title={current.paused ? '播放视频' : '暂停视频'} data-testid="video-play-toggle" disabled={!current.decoded} onClick={() => resource.current?.togglePlay()}>{current.status === 'buffering' ? <LoaderCircle size={18} className="spin" /> : current.paused ? <Play size={18} /> : <Pause size={18} />}</button>
      <span className="video-time" data-testid="video-current-time">{timeText(current.currentTime)}</span>
      <input type="range" min="0" max={current.duration || 0} step="0.1" value={Math.min(current.currentTime || 0, current.duration || 0)} aria-label="视频播放进度" data-testid="video-seek" disabled={!current.decoded || !current.duration} onChange={event => resource.current?.seek(Number(event.target.value))} onPointerDown={event => {
        if (event.isPrimary === false || event.button !== 0 || !current.decoded || !resource.current) return;
        clearSeek();
        const controller = resource.current, owner = event.currentTarget.ownerDocument.defaultView;
        // Listen only while dragging. Native range controls can fail to retain
        // capture; an outside release must still finish the original gesture.
        seeking.current = { controller, epoch: controller.epoch, key, pointerId: event.pointerId, resume: !current.paused, cleanup: () => {
          owner.removeEventListener('pointerup', endSeek, true);
          owner.removeEventListener('pointercancel', endSeek, true);
        } };
        owner.addEventListener('pointerup', endSeek, true);
        owner.addEventListener('pointercancel', endSeek, true);
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
        if (!current.paused) controller.pause();
      }} onPointerUp={endSeek} onPointerCancel={endSeek} onLostPointerCapture={endSeek} />
      <span className="video-time" data-testid="video-duration">{timeText(current.duration)}</span>
      <button type="button" className="icon-button" aria-label={current.muted ? '取消静音' : '静音'} title={current.muted ? '取消静音' : '静音'} data-testid="video-mute-toggle" disabled={!current.decoded} onClick={() => resource.current?.toggleMute()}>{current.muted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
    </div>}
  </div>;
}
