const safeError=()=>new Error('音频未能播放，请检查语音服务或文件格式。');
export class AudioPlayer {
  #api;#channel;#Audio;#createURL;#revokeURL;#onChange;#onError;#job=null;#disposed=false;#unsubscribe;
  constructor({api,channel,Audio=globalThis.Audio,createURL=blob=>URL.createObjectURL(blob),revokeURL=url=>URL.revokeObjectURL(url),onChange,onError}){
    this.#api=api;this.#channel=channel;this.#Audio=Audio;this.#createURL=createURL;this.#revokeURL=revokeURL;this.#onChange=onChange;this.#onError=onError;
    this.#unsubscribe=api.subscribe(event=>{const job=this.#job;if(event.type!=='audio-state'||event.channel!==channel||!job||event.session.owner.requestId!==job.requestId)return;job.id=event.session.id;if(['stopped','ended','error'].includes(event.session.state)){this.#job=null;this.#release(job);this.#publish(null);if(event.session.state==='error')this.#onError?.(safeError());}});
  }
  #publish(job){this.#onChange?.(job?{state:job.state,label:job.label,owner:job.owner||null,currentTime:Number.isFinite(job.audio?.currentTime)?job.audio.currentTime:0,duration:Number.isFinite(job.audio?.duration)?job.audio.duration:0}:null);}
  #release(job){if(!job)return;for(const [name,handler]of job.listeners||[])job.audio?.removeEventListener(name,handler);try{job.audio?.pause();job.audio?.removeAttribute('src');job.audio?.load();}catch{}if(job.url)this.#revokeURL(job.url);job.url=null;}
  #ack(job,state){return this.#api.updateAudioState({channel:this.#channel,id:job.id,state}).then(result=>{if(this.#job===job&&['stopped','ended','error'].includes(result.state)){this.#job=null;this.#release(job);this.#publish(null);}}).catch(()=>{if(this.#job===job)this.stop();});}
  async play(input,{label='音频'}={}){
    if(this.#disposed)return;
    this.stop();const job={requestId:`audio_req_${crypto.randomUUID()}`,id:null,state:'loading',label,audio:null,url:null,listeners:[]};this.#job=job;this.#publish(job);
    let result;
    try{
      result=await this.#api.prepareAudio({...input,channel:this.#channel,requestId:job.requestId});job.id=result.id;
      if(this.#job!==job||this.#disposed){await this.#api.stopAudio({channel:this.#channel,id:job.id,requestId:job.requestId}).catch(()=>{});return;}
      if(!(result.audio instanceof ArrayBuffer)||result.state!=='ready')throw safeError();
      job.owner=result.owner;job.audio=new this.#Audio();job.url=this.#createURL(new Blob([result.audio],{type:result.mimeType}));
      const listen=(name,handler)=>{job.audio.addEventListener(name,handler);job.listeners.push([name,handler]);};
      listen('loadedmetadata',()=>{
        if(this.#job!==job)return;
        const limit=this.#channel==='preview'?120:7200;
        if(!Number.isFinite(job.audio.duration)||job.audio.duration<=0||job.audio.duration>limit){this.stop();this.#onError?.(safeError());return;}
        job.state='ready';this.#publish(job);
        Promise.resolve(job.audio.play()).catch(()=>{if(this.#job===job){this.#ack(job,'error');this.stop();this.#onError?.(safeError());}});
      });
      listen('playing',()=>{if(this.#job===job){job.state='playing';this.#publish(job);this.#ack(job,'playing');}});
      listen('pause',()=>{if(this.#job===job&&job.state==='playing'){job.state='paused';this.#publish(job);this.#ack(job,'paused');}});
      listen('timeupdate',()=>{if(this.#job===job)this.#publish(job);});
      listen('ended',()=>{if(this.#job===job){this.#ack(job,'ended');this.#job=null;this.#release(job);this.#publish(null);}});
      listen('error',()=>{if(this.#job===job){this.#ack(job,'error');this.#job=null;this.#release(job);this.#publish(null);this.#onError?.(safeError());}});
      job.audio.preload='auto';job.audio.src=job.url;job.audio.load();
    }catch{if(this.#job===job){this.stop();this.#onError?.(safeError());}}
    finally{if(result?.audio instanceof ArrayBuffer)new Uint8Array(result.audio).fill(0);}
  }
  pause(){const job=this.#job;if(job?.state==='playing')job.audio.pause();}
  resume(){const job=this.#job;if(job?.state==='paused')Promise.resolve(job.audio.play()).catch(()=>{if(this.#job===job){this.stop();this.#onError?.(safeError());}});}
  seek(value){const job=this.#job;if(job?.audio&&Number.isFinite(value)&&Number.isFinite(job.audio.duration)){job.audio.currentTime=Math.max(0,Math.min(job.audio.duration,value));this.#publish(job);}}
  stop(){const job=this.#job;if(!job)return;this.#job=null;this.#release(job);this.#publish(null);this.#api.stopAudio({channel:this.#channel,...(job.id?{id:job.id}:{}),requestId:job.requestId}).catch(()=>{});}
  dispose(){this.stop();this.#disposed=true;this.#unsubscribe?.();}
}
