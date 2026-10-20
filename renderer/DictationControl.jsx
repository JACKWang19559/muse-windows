import React, { useEffect, useRef, useState } from 'react';
import { Mic, Square, X, ArrowUp } from 'lucide-react';
import { createDictationCapture } from './dictation-capture.mjs';

const api = window.muse;
const ACTIVE = new Set(['preparing','recording','finishing']);
const ERRORS = { microphone_denied:'麦克风权限未获允许，请检查 Windows 的麦克风设置。', microphone_missing:'未找到可用麦克风。', capture_failed:'录音未能完成，请重试。', audio_too_short:'录音太短，请再说一遍。' };

export function useDictation({owner,contextKey,value,onChange,onSend,settings,onConfigure,notify}) {
  const [view,setView] = useState({state:'idle',durationMs:0,rms:0});
  const current=useRef(null),mounted=useRef(true),latest=useRef(null);
  latest.current={owner,contextKey,value,onChange,onSend,settings,onConfigure,notify};
  const cancel=async(reason='cancelled')=>{
    const job=current.current;if(!job)return;
    current.current=null;
    await job.capture?.cancel().catch(()=>{});
    if(job.id)await api.cancelDictation({id:job.id,reason}).catch(()=>{});
    if(mounted.current&&!current.current)setView({state:'idle',durationMs:0,rms:0});
  };
  const finish=async(intent='review')=>{
    const job=current.current;if(!job||job.finishing||!job.id||view.state==='preparing')return;
    job.finishing=true;
    const atStop=latest.current;
    const shouldSend=intent==='send'||atStop.settings.dictationAutoSend===true;
    const prefix=atStop.value;
    let audio;
    setView(previous=>({...previous,state:'finishing'}));
    try{
      audio=await job.capture.stop();
      if(current.current!==job)return;
      const result=await api.finishDictation({id:job.id,audio});
      if(current.current!==job||!mounted.current||job.contextKey!==latest.current.contextKey)return;
      current.current=null;setView({state:'idle',durationMs:0,rms:0});
      if(typeof result.text!=='string'||!result.text.trim()){
        latest.current.notify(result.state==='cancelled'?'听写已取消。':result.state==='complete'?'没有识别到文字。':'听写未完成，请重试。','info');return;
      }
      const sendAllowed=shouldSend&&latest.current.value===prefix;
      const draft=latest.current.value;
      const combined=draft?`${draft}${/\s$/.test(draft)?'':'\n'}${result.text}`:result.text;
      latest.current.onChange(combined);
      if(sendAllowed)await latest.current.onSend(combined);
      else {if(shouldSend)latest.current.notify('草稿在识别期间有变化，听写文字已放回草稿，请审阅后发送。','info');window.dispatchEvent(new Event('muse-focus-composer'));}
    }catch(error){
      if(current.current===job){await cancel('error');latest.current.notify(ERRORS[error?.code]||'听写未能完成，请检查语音服务设置后重试。','error');}
    }finally{if(audio)new Uint8Array(audio).fill(0);}
  };
  const actions=useRef({});actions.current={cancel,finish};
  const start=async()=>{
    if(current.current)return;
    const props=latest.current;
    if(!props.settings.speechBaseUrl||!props.settings.transcriptionModel){props.onConfigure();props.notify('请在“语音输入”中配置识别服务和模型。','info');return;}
    const job={contextKey:props.contextKey,id:null,capture:null,finishing:false};
    current.current=job;setView({state:'preparing',durationMs:0,rms:0});
    try{
      const session=await api.startDictation(props.owner);
      job.id=session.id;
      if(current.current!==job||job.contextKey!==latest.current.contextKey){await api.cancelDictation({id:session.id,reason:'scope_changed'});return;}
      job.capture=createDictationCapture({
        getUserMedia:constraints=>navigator.mediaDevices.getUserMedia(constraints),AudioContext:window.AudioContext,
        onLevel:level=>{if(current.current===job&&!job.finishing)setView(previous=>({...previous,...level}));},
        onLimit:()=>{if(current.current===job)actions.current.finish('review');},
        onError:error=>{if(current.current===job){actions.current.cancel('capture_error');latest.current.notify(ERRORS[error?.code]||'麦克风已断开，听写已取消。','error');}}
      });
      await job.capture.start();
      if(current.current!==job){await job.capture.cancel();return;}
      const ready=await api.dictationCaptureReady({id:job.id});
      if(current.current!==job)return;
      if(ready.state!=='recording')throw new Error('cancelled');
      setView(previous=>({...previous,state:'recording'}));
    }catch(error){
      if(current.current===job){await cancel('capture_error');latest.current.notify(ERRORS[error?.code]||'无法开始听写，请检查麦克风和语音设置。','error');}
    }
  };
  useEffect(()=>{
    mounted.current=true;
    const unsubscribe=api.subscribe(event=>{
      const job=current.current;
      if(event.type!=='dictation-state'||!job?.id||event.session.id!==job.id)return;
      if(['cancelled','error'].includes(event.session.state)){
        actions.current.cancel('host_cancelled');
        latest.current.notify(event.session.state==='error'?'语音识别失败，请检查服务配置后重试。':'听写已取消。','info');
      }
    });
    const hidden=()=>{if(document.hidden)actions.current.cancel('window_hidden');};
    document.addEventListener('visibilitychange',hidden);
    return()=>{mounted.current=false;unsubscribe();document.removeEventListener('visibilitychange',hidden);actions.current.cancel('unmounted');};
  },[]);
  useEffect(()=>{if(current.current&&current.current.contextKey!==contextKey)actions.current.cancel('scope_changed');},[contextKey]);
  const active=ACTIVE.has(view.state), finishing=view.state==='finishing';
  const toolbar=<button type="button" className={`dictation-start ${active?'active':''}`} data-testid="dictation-start" aria-label="开始语音输入" title="开始语音输入" onClick={start} disabled={active}><Mic size={17}/></button>;
  const banner=active&&<div className="dictation-bar" role="status" data-testid="dictation-status" data-state={view.state}>
    <Mic size={16}/><span>{view.state==='preparing'?'正在打开麦克风…':finishing?'正在识别，麦克风已关闭…':`正在聆听 · ${Math.floor(view.durationMs/1000)} 秒`}</span>
    {view.state==='recording'&&<><meter aria-label="录音音量" min="0" max="1" value={Math.min(1,view.rms*5)}/><button type="button" data-testid="dictation-review" onClick={()=>finish('review')}><Square size={12}/>{settings.dictationAutoSend?'停止并发送':'停止并审阅'}</button><button type="button" data-testid="dictation-send" onClick={()=>finish('send')}><ArrowUp size={13}/>识别后发送</button></>}
    <button type="button" data-testid="dictation-cancel" onClick={()=>cancel()}><X size={14}/>丢弃</button>
  </div>;
  return {active,finishing,toolbar,banner,send:()=>active?finish('send'):onSend()};
}
