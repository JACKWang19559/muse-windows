import React,{useEffect,useRef,useState}from'react';
import{Play,Pause,Square,Volume2}from'lucide-react';
import{AudioPlayer}from'./audio-player.mjs';
export const isAudioFile=file=>/\.(wav|mp3|ogg|m4a|mp4|flac|webm|aac)$/i.test(file?.name||'');
export function useAudioPlayback(channel,notify){
  const [view,setView]=useState(null),player=useRef(null),notifier=useRef(notify);notifier.current=notify;
  useEffect(()=>{if(!window.muse)return;const instance=new AudioPlayer({api:window.muse,channel,onChange:setView,onError:error=>notifier.current(error.message,'error')});player.current=instance;return()=>{instance.dispose();if(player.current===instance)player.current=null;};},[channel]);
  return{view,play:(...args)=>player.current?.play(...args),pause:()=>player.current?.pause(),resume:()=>player.current?.resume(),stop:()=>player.current?.stop(),seek:time=>player.current?.seek(time)};
}
const time=value=>`${Math.floor((value||0)/60)}:${String(Math.floor((value||0)%60)).padStart(2,'0')}`;
export function AudioControls({player,compact=false}){
  const view=player.view;if(!view)return null;
  return <div className={`audio-controls ${compact?'compact':''}`} data-testid={compact?'voice-preview-player':'chat-audio-player'} data-state={view.state}>
    <Volume2 size={16}/><span className="audio-label">{view.label}</span>
    {['playing','paused'].includes(view.state)?<><button type="button" data-testid={compact?'preview-toggle':'audio-toggle'} onClick={view.state==='playing'?player.pause:player.resume}>{view.state==='playing'?<Pause size={14}/>:<Play size={14}/>}<span>{view.state==='playing'?'暂停':'继续'}</span></button><span className="audio-time">{time(view.currentTime)} / {time(view.duration)}</span><input type="range" aria-label={compact?'试听进度':'音频进度'} data-testid={compact?'preview-seek':'audio-seek'} min="0" max={view.duration||1} step="0.1" value={Math.min(view.currentTime,view.duration||1)} onChange={event=>player.seek(Number(event.target.value))}/></>:<span>正在准备音频…</span>}
    <button type="button" data-testid={compact?'preview-stop':'audio-stop'} onClick={player.stop}><Square size={12}/>停止</button>
  </div>;
}
