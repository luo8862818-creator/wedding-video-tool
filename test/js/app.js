(() => {
  'use strict';
  const offline=window.__OFFLINE_CAPTURE===true;
  const pages=[...document.querySelectorAll('.page')];
  const counter=document.getElementById('counter');
  const progress=document.getElementById('progress');
  const hint=document.getElementById('hint');
  const introMs=2000,scrollMs=36000,holdMs=2000;
  let raf=0,epoch=null,animations=[];
  if('scrollRestoration' in history)history.scrollRestoration='manual';
  const player=window.templatePlayer=window.weddingPlayer={
    time:0,totalMs:introMs+scrollMs+holdMs,duration:scrollMs,
    totalPages:pages.length,started:false,ended:false,paused:false,
    state:'PRELOAD',cameraY:0,target:0,metrics:null,errors:[],
    captureVersion:1,preferredFps:60
  };
  function measure(){
    player.target=Math.max(0,document.documentElement.scrollHeight-innerHeight);
    player.metrics={pageHeight:document.documentElement.scrollHeight,viewportHeight:innerHeight,
      endY:player.target,chapters:pages.length,introMs,scrollMs,holdMs,totalMs:player.totalMs};
  }
  player.renderAt=function(ms){
    if(!Number.isFinite(ms))throw Error('时间轴时间无效');
    player.time=Math.max(0,Math.min(ms,player.totalMs));
    const ratio=Math.max(0,Math.min(1,(player.time-introMs)/scrollMs));
    player.cameraY=player.target*ratio;
    window.scrollTo(0,player.cameraY);
    const index=Math.min(pages.length,Math.floor(ratio*pages.length)+1);
    counter.textContent=String(index).padStart(2,'0')+' / '+pages.length;
    progress.style.width=(ratio*100)+'%';
    player.started=player.time>=introMs;
    // Ended includes the final hold; the exporter must not append another tail.
    player.ended=player.time>=player.totalMs;
    player.state=player.ended?'FINISHED':player.time<introMs?'INTRO':ratio<1?'AUTO_SCROLL':'HOLD';
    hint.textContent=player.time<introMs?'页面将在 2 秒后自动向下播放':ratio<1?'正在自动播放 · 12 屏':'播放完成';
    for(const animation of animations)animation.currentTime=player.time;
    return {time:player.time,y:player.cameraY,state:player.state};
  };
  player.renderCapture=async function(){
    await player.ready;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    document.documentElement.getBoundingClientRect();
    if(Math.abs(scrollY-player.cameraY)>1)throw Error('画面滚动位置未同步，已停止导出');
  };
  function tick(now){
    if(player.paused||offline)return;
    if(epoch===null)epoch=now-player.time;
    player.renderAt(now-epoch);
    if(!player.ended)raf=requestAnimationFrame(tick);
  }
  player.restart=function(){
    cancelAnimationFrame(raf);epoch=null;player.paused=false;measure();player.renderAt(0);
    if(!offline)raf=requestAnimationFrame(tick);
  };
  player.ready=(async()=>{
    if(document.readyState!=='complete')await new Promise(resolve=>window.addEventListener('load',resolve,{once:true}));
    await document.fonts.ready;
    await Promise.all([...document.images].map(img=>{img.loading='eager';return img.decode();}));
    animations=document.getAnimations();
    for(const animation of animations){animation.pause();animation.currentTime=0;}
    player.restart();
  })().catch(error=>{player.errors.push(error.message);hint.textContent='页面准备失败：'+error.message;throw error;});
  window.addEventListener('resize',()=>{measure();player.renderAt(player.time);});
  document.addEventListener('visibilitychange',()=>{
    if(offline)return;
    cancelAnimationFrame(raf);
    if(!document.hidden&&!player.ended){epoch=null;raf=requestAnimationFrame(tick);}
  });
})();
