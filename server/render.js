const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const express=require("express");
const http=require("node:http");
const {chromium}=require("playwright");
const {transcodeRecordedVideo}=require("./ffmpeg");

async function readPlaybackState(page){
 return page.evaluate(()=>{
  const root=document.scrollingElement||document.documentElement;
  const candidates=[root,...document.querySelectorAll("*")].filter((el,index)=>{
   if(!el||!el.scrollHeight||el.scrollHeight-el.clientHeight<20)return false;
   if(index===0)return true;
   const style=getComputedStyle(el);
   return /(auto|scroll)/.test(style.overflowY);
  }).slice(0,120);
  const scrollables=candidates.map((el,index)=>({
   id:index,
   top:Math.max(0,Number(el.scrollTop)||0),
   max:Math.max(0,el.scrollHeight-el.clientHeight)
  }));
  const progress=scrollables.reduce((max,item)=>Math.max(max,item.max?item.top/item.max:0),0);
  const player=window.templatePlayer||window.weddingPlayer||window.invitationPlayer||null;
  const playerStarted=Boolean(player&&(player.started===true||player.playing===true||player.isPlaying===true));
  const hintNodes=[...document.querySelectorAll("#hint,[data-playback-state],[data-playback-status],[aria-live='polite']")];
  const hintText=hintNodes.map(el=>(el.textContent||"").trim()).filter(Boolean).join(" ");
  const bodyState=String(document.body?.dataset?.playbackState||document.body?.dataset?.playbackStatus||"");
  const ended=/播放完成|播放结束|播放完毕|播放已结束|演示结束|已结束|playback complete|playback finished/i.test(hintText+" "+bodyState);
  const playingText=/正在自动播放|正在播放|播放中|playing/i.test(hintText+" "+bodyState);
  const maxScroll=scrollables.reduce((max,item)=>Math.max(max,item.max),0);
  const bottom=scrollables.some(item=>item.max>0&&item.top>=item.max-3);
  return {
   scrollables,progress:Math.max(0,Math.min(1,progress)),maxScroll,bottom,
   playerStarted,playerDuration:Number(player?.duration)||0,
   started:playerStarted||playingText||scrollables.some(item=>item.top>1),
   ended,hintText,bodyState,
   pageHeight:root.scrollHeight,viewportHeight:innerHeight,
   chapterCount:document.querySelectorAll(".chapter,.page,section").length
  };
 });
}

async function renderVideo(options){
 const {sourcePath,musicPath,outputPath,fps,width,height,onProgress=()=>{}}=options;
 const logicalWidth=450;
 const logicalHeight=Math.max(1,Math.round(logicalWidth*height/width));
 const recordDir=fs.mkdtempSync(path.join(os.tmpdir(),"wedding-video-record-"));
 let browser=null,context=null,sourceServer=null,recording=null;
 const taskStartedAt=Date.now();
 try{
  onProgress(1,"启动浏览器","创建真实网页录制环境");
  browser=await chromium.launch({headless:true,args:[
   "--disable-background-timer-throttling",
   "--disable-renderer-backgrounding",
   "--disable-backgrounding-occluded-windows",
   "--disable-features=CalculateNativeWinOcclusion"
  ]});
  context=await browser.newContext({
   viewport:{width:logicalWidth,height:logicalHeight},
   deviceScaleFactor:1,
   colorScheme:"light",
   reducedMotion:"no-preference",
   recordVideo:{dir:recordDir,size:{width,height}}
  });
  const page=await context.newPage();
  recording=page.video();
  const pageErrors=[];
  page.on("pageerror",error=>{pageErrors.push(error.message);console.error("[邀请函脚本错误]",error.message);});
  page.on("console",message=>{if(message.type()==="error")console.error("[邀请函控制台]",message.text());});

  const sourceApp=express();
  sourceApp.use(express.static(path.dirname(sourcePath),{dotfiles:"allow",fallthrough:false}));
  sourceServer=http.createServer(sourceApp);
  await new Promise((resolve,reject)=>{
   sourceServer.once("error",reject);
   sourceServer.listen(0,"127.0.0.1",resolve);
  });
  const address=sourceServer.address();
  const sourceUrl="http://127.0.0.1:"+address.port+"/"+encodeURIComponent(path.basename(sourcePath));
  onProgress(3,"加载邀请函","通过本地 HTTP 加载 HTML 和相关资源");
  const recordingStartedAt=Date.now();
  await page.goto(sourceUrl,{waitUntil:"load",timeout:60000});
  await page.evaluate(async()=>{
   if(document.fonts?.ready)await document.fonts.ready;
   await Promise.all([...document.images].map(image=>image.decode().catch(()=>{})));
  });
  const readyAt=Date.now();
  const startupTrimSeconds=Math.max(0,(readyAt-recordingStartedAt)/1000);
  const initial=await readPlaybackState(page);
  onProgress(5,"等待网页自动播放","网页已加载，正在等待其自身的播放逻辑启动",{recordingSeconds:0,scrollProgress:0});

  const maxRecordingMs=300000;
  const startupTimeoutMs=30000;
  const markerTailMs=1200;
  const bottomTailMs=3500;
  let started=false,playbackStartedAt=0,lastState=null,lastMoveAt=readyAt;
  let bottomSince=0,endedSince=0,endReason="",lastProgressAt=0,latestState=initial;
  while(Date.now()-readyAt<maxRecordingMs){
   await page.waitForTimeout(200);
   const state=await readPlaybackState(page);
   latestState=state;
   let moved=false;
   if(lastState){
    const previous=new Map(lastState.scrollables.map(item=>[item.id,item.top]));
    moved=state.scrollables.some(item=>Math.abs(item.top-(previous.get(item.id)||0))>0.5);
   }
   if(moved)lastMoveAt=Date.now();
   if(!started&&(state.started||moved)){
    started=true;
    playbackStartedAt=Date.now();
    onProgress(7,"真实网页播放录制","检测到网页开始播放，正在按原始速度录制",{recordingSeconds:0,scrollProgress:state.progress});
   }
   if(!started&&Date.now()-readyAt>startupTimeoutMs){
    throw new Error("网页已加载，但 30 秒内没有检测到自动播放或滚动。请确认网页打开后会自行播放；本工具不会替网页添加滚动动画。");
   }
   if(started){
    const recordingSeconds=(Date.now()-readyAt)/1000;
    const progress=state.maxScroll>0?Math.min(78,7+state.progress*70):12;
    if(Date.now()-lastProgressAt>=700){
     lastProgressAt=Date.now();
     onProgress(progress,"真实网页播放录制","已录制 "+recordingSeconds.toFixed(1)+" 秒 · 页面进度 "+Math.round(state.progress*100)+"%",{recordingSeconds:Number(recordingSeconds.toFixed(2)),scrollProgress:Number(state.progress.toFixed(4))});
    }
    if(state.ended){
     if(!endedSince)endedSince=Date.now();
     if(Date.now()-endedSince>=markerTailMs){endReason="网页播放完成标志";break;}
    }else{
     endedSince=0;
     if(state.bottom){
      if(!bottomSince)bottomSince=Date.now();
      if(Date.now()-bottomSince>=bottomTailMs){endReason="滚动到底部并稳定停留";break;}
     }else bottomSince=0;
     if(state.playerDuration>0&&playbackStartedAt&&Date.now()-playbackStartedAt>=state.playerDuration+markerTailMs){
      endReason="网页公开的播放时长已结束";break;
     }
    }
   }
   lastState=state;
  }
  if(!started)throw new Error("没有检测到网页自动播放，无法判断视频应从哪里开始。");
  if(!endReason)throw new Error("网页播放超过 300 秒仍未结束。请检查网页是否循环滚动，或是否提供播放完成标志。");

  const recordingEndedAt=Date.now();
  const captureSeconds=Math.max(0,(recordingEndedAt-readyAt)/1000);
  onProgress(80,"网页播放完成","已按网页实际播放节奏完成录制，正在整理视频",{recordingSeconds:Number(captureSeconds.toFixed(2)),scrollProgress:1});
  await context.close();
  context=null;
  const recordedPath=await recording.path();
  if(sourceServer){
   await new Promise(resolve=>sourceServer.close(()=>resolve()));
   sourceServer=null;
  }
  await browser.close();
  browser=null;

  onProgress(82,"转换 MP4","正在统一分辨率和帧率，不改变网页播放速度",{recordingSeconds:Number(captureSeconds.toFixed(2)),scrollProgress:1});
  const encoded=await transcodeRecordedVideo({
   inputPath:recordedPath,outputPath,musicPath,fps,width,height,
   trimStartSeconds:startupTrimSeconds,durationHint:captureSeconds,
   onProgress:(state)=>{
    const ratio=captureSeconds>0?Math.min(1,state.outTimeSeconds/captureSeconds):0;
    onProgress(82+ratio*16,"转换 MP4","已处理 "+state.frame+" 帧",{recordingSeconds:Number(captureSeconds.toFixed(2)),encodedFrames:state.frame});
   }
  });
  const taskSeconds=(Date.now()-taskStartedAt)/1000;
  const metrics={
   mode:"playwright-real-recording",
   endReason,
   durationSeconds:encoded.durationSeconds,
   captureSeconds:Number(captureSeconds.toFixed(2)),
   startupTrimSeconds:Number(startupTrimSeconds.toFixed(3)),
   frames:encoded.frames,
   encodedFrames:encoded.encodedFrames,
   fps,
   avgFps:Number((encoded.frames/(encoded.durationSeconds||1)).toFixed(2)),
   totalSeconds:Number(taskSeconds.toFixed(2)),
   outputSizeBytes:encoded.size,
   pageHeight:latestState.pageHeight,
   viewportHeight:latestState.viewportHeight,
   maxScroll:latestState.maxScroll,
   chapterCount:latestState.chapterCount,
   pageErrors
  };
  console.log("[render metrics]",JSON.stringify(metrics,null,2));
  onProgress(100,"完成","MP4 已生成，视频时长 "+encoded.durationSeconds.toFixed(2)+" 秒",metrics);
 }catch(error){
  throw error;
 }finally{
  if(context)await context.close().catch(()=>{});
  if(browser)await browser.close().catch(()=>{});
  if(sourceServer)await new Promise(resolve=>sourceServer.close(()=>resolve())).catch(()=>{});
  fs.rmSync(recordDir,{recursive:true,force:true});
 }
}

module.exports={renderVideo};
