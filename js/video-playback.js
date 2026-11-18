// Shared by the studio and the independent player; no rendering/export work.
window.createVideoPlayback = function(video, output, {onPlay=()=>{},onOtherPlayback=()=>{}}={}) {
 const id=crypto.randomUUID();
 const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('wedding-video-playback'):null;
 let timer=null,base=null,waits=0,stalls=0,hasPlayed=false,lastError='';
 function quality(){try{return video.getVideoPlaybackQuality?.()||null;}catch(_){return null;}}
 function render(){
  const q=quality();
  const total=q?Math.max(0,q.totalVideoFrames-(base?.totalVideoFrames||0)):null;
  const dropped=q?Math.max(0,q.droppedVideoFrames-(base?.droppedVideoFrames||0)):null;
  const state=lastError||(!video.currentSrc?'未载入':video.ended?'播放结束':video.seeking?'正在跳转':video.paused?'已暂停':video.readyState<3?'缓冲中':'播放中');
  output.textContent=state+' · 浏览器丢帧 '+(dropped===null?'不支持统计':dropped+' / '+total)+' · 缓冲等待 '+waits+' 次 · 网络停滞 '+stalls+' 次';
 }
 function stopTimer(){if(timer!==null){clearInterval(timer);timer=null;}}
 function pause(){video.pause();stopTimer();render();}
 function claim(){channel?.postMessage({id});}
 function release(){
  pause();video.removeAttribute('src');video.load();
  base=null;waits=0;stalls=0;hasPlayed=false;lastError='';render();
 }
 function load(url){release();video.preload='auto';video.src=url;video.load();render();}
 video.addEventListener('play',()=>{onPlay();claim();stopTimer();timer=setInterval(render,500);render();});
 video.addEventListener('playing',()=>{hasPlayed=true;render();});
 video.addEventListener('loadedmetadata',()=>{base=quality();render();});
 video.addEventListener('waiting',()=>{if(hasPlayed&&!video.paused&&!video.seeking&&!video.ended)waits++;render();});
 video.addEventListener('stalled',()=>{if(hasPlayed&&!video.paused&&!video.seeking&&!video.ended)stalls++;render();});
 for(const event of ['pause','ended'])video.addEventListener(event,()=>{stopTimer();render();});
 for(const event of ['seeking','seeked','canplay','emptied'])video.addEventListener(event,render);
 video.addEventListener('error',()=>{lastError='视频加载或解码失败（'+(video.error?.code||'未知')+'）';stopTimer();render();});
 if(channel)channel.onmessage=event=>{if(event.data?.id&&event.data.id!==id){pause();onOtherPlayback();}};
 window.addEventListener('pagehide',event=>{pause();if(!event.persisted){release();channel?.close();}});
 render();
 return {load,pause,release,claim};
};
