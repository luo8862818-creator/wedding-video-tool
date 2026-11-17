const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const express=require("express");
const http=require("node:http");
const {chromium}=require("playwright");
const {transcodeRecordedVideo}=require("./ffmpeg");

async function readPlaybackState(page){
 return page.evaluate(()=>{
  const tracker=window.__weddingVideoTracker||(window.__weddingVideoTracker={ids:new WeakMap(),nextId:1});
  const getId=element=>{
   if(!tracker.ids.has(element))tracker.ids.set(element,tracker.nextId++);
   return tracker.ids.get(element);
  };
  const root=document.scrollingElement||document.documentElement;
  const all=[root,...Array.from(document.querySelectorAll("*")).slice(0,450)];
  const unique=Array.from(new Set(all));
  const scrollables=[];
  for(const element of unique){
   const max=Math.max(0,element.scrollHeight-element.clientHeight);
   if(max<20)continue;
   if(element!==root&&!/(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY))continue;
   scrollables.push({
    id:getId(element),top:Math.max(0,Number(element.scrollTop)||0),max,
    bottom:(Number(element.scrollTop)||0)>=max-4,isRoot:element===root
   });
   if(scrollables.length>=80)break;
  }

  const semantic=[document.body,document.querySelector("main"),document.querySelector("#app"),
   ...Array.from(document.querySelectorAll("[data-scroll-content],.pages,.slides,.content,.container,.invitation,[class*='scroll'],[id*='scroll'],[class*='page'],[id*='page'],[class*='slide'],[id*='slide']")).slice(0,100)].filter(Boolean);
  const semanticSet=new Set(semantic);
  const motionSet=new Set(semantic),motion=[],contentRects=[];
  for(const element of unique){
   if(motionSet.size>=180)break;
   const style=getComputedStyle(element);
   if(style.transform!=="none"||style.translate!=="none"||(style.animationName&&style.animationName!=="none"))motionSet.add(element);
  }
  for(const element of motionSet){
   const rect=element.getBoundingClientRect();
   if(!rect.width&&!rect.height)continue;
   const style=getComputedStyle(element);
   const transform=style.transform||"none",translate=style.translate||"none";
   const round=value=>Math.round(value*2)/2;
   const transformed=transform!=="none"||translate!=="none";
   const meaningfulArea=rect.width*rect.height>=innerWidth*innerHeight*.08;
   if(semanticSet.has(element)||meaningfulArea){
    motion.push([getId(element),transform,translate,style.top,style.left,
     round(rect.x),round(rect.y),round(rect.width),round(rect.height)]);
   }
   if(rect.height>innerHeight*1.15&&rect.width>innerWidth*.45){
    contentRects.push({top:rect.top,bottom:rect.bottom,height:rect.height,transformed});
   }
  }

  const animations=document.getAnimations?document.getAnimations():[];
  let finiteRunningAnimations=0;
  for(const animation of animations){
   if(animation.playState!=="running")continue;
   const timing=animation.effect?.getComputedTiming?.();
   if(timing&&timing.iterations!==Infinity)finiteRunningAnimations++;
  }

  const rootMax=Math.max(0,root.scrollHeight-root.clientHeight);
  const rootTop=Math.max(0,Number(root.scrollTop)||0);
  const rootBottom=rootMax>20&&rootTop>=rootMax-4;
  const transformBottom=contentRects.some(rect=>rect.transformed&&rect.top<0&&rect.bottom<=innerHeight+5);
  const transformedRects=contentRects.filter(rect=>rect.transformed);
  const transformProgress=transformedRects.reduce((best,rect)=>{
   const distance=Math.max(1,rect.height-innerHeight);
   const progress=Math.max(0,Math.min(1,-rect.top/distance));
   return Math.max(best,progress);
  },0);
  const scrollProgress=scrollables.reduce((best,item)=>Math.max(best,item.max?item.top/item.max:0),0);
  const maxScroll=scrollables.reduce((max,item)=>Math.max(max,item.max),0);
  const player=window.templatePlayer||window.weddingPlayer||window.invitationPlayer||null;
  const playerState=String(player?.state||"").toUpperCase();
  // wedding-invitation 使用 INTRO_GIF -> AUTO_SCROLL -> OUTRO_GIF -> FINISHED 状态机；
  // test 模板则使用 started/ended 布尔值，两种接口都必须识别。
  const activePlayerStates=["INTRO_GIF","AUTO_SCROLL","OUTRO_GIF","FINISHED","USER_CONTROL"];
  const finishedPlayerStates=["FINISHED","ENDED","COMPLETE","COMPLETED"];
  const playerStarted=Boolean(player&&(
   player.started===true||player.playing===true||player.isPlaying===true||
   activePlayerStates.includes(playerState)
  ));
  const playerEnded=Boolean(player&&(
   player.ended===true||player.finished===true||player.completed===true||
   player.isFinished===true||finishedPlayerStates.includes(playerState)
  ));
  const playerErrors=Array.isArray(player?.errors)?player.errors.slice(0,8).map(String):[];
  const loadingText=(document.querySelector("#loading")?.textContent||"").trim();
  const playerTime=Number.isFinite(Number(player?.time))?Number(player.time):null;
  const playerPaused=Boolean(player?.paused);
  const globalEnded=Boolean(window.weddingVideoFinished===true||window.invitationFinished===true||window.__weddingVideoFinished===true);
  const hintNodes=[...document.querySelectorAll("#hint,[data-playback-state],[data-playback-status],[aria-live='polite']")];
  const hintText=hintNodes.map(el=>(el.textContent||"").trim()).filter(Boolean).join(" ");
  const bodyState=String(document.body?.dataset?.playbackState||document.body?.dataset?.playbackStatus||"");
  const ended=playerEnded||globalEnded||/播放完成|播放结束|播放完毕|播放已结束|演示结束|已结束|playback complete|playback finished/i.test(hintText+" "+bodyState);
  const playingText=/正在自动播放|正在播放|播放中|playing/i.test(hintText+" "+bodyState);
  const motionSignature=JSON.stringify(motion);
  return {
   scrollables,rootId:getId(root),rootBottom,transformBottom,
   progress:Math.max(0,Math.min(1,Math.max(scrollProgress,transformProgress))),
   transformProgress,hasTransformContent:transformedRects.length>0,maxScroll,rootMax,
   playerStarted,playerState,playerTime,playerPaused,playerErrors,loadingText,
   started:playerStarted||playingText||rootTop>1||scrollables.some(item=>item.top>1)||(maxScroll<20&&animations.some(a=>a.playState==="running")),
   ended,hintText,bodyState,motionSignature,finiteRunningAnimations,
   pageHeight:root.scrollHeight,viewportHeight:innerHeight,
   chapterCount:document.querySelectorAll(".chapter,.page,section").length
  };
 });
}

async function closeHttpServer(server){
 if(!server)return;
 await new Promise(resolve=>{
  try{
   server.close(()=>resolve());
   server.closeIdleConnections?.();
  }catch(_){resolve();}
 });
}

function resolveCaptureProfile(sourcePath,outputWidth,outputHeight){
 const html=fs.readFileSync(sourcePath,"utf8").slice(0,65536);
 const marker=html.match(/<meta\s+name=["']wedding-video-viewport["']\s+content=["'](\d{2,4})x(\d{2,4})["'][^>]*>/i);
 if(marker){
  const width=Number(marker[1]),height=Number(marker[2]);
  if(width===outputWidth&&height===outputHeight){
   return {width,height,deviceScaleFactor:1,nativeResolution:true};
  }
 }
 const scale=2.4;
 return {
  width:Math.max(1,Math.round(outputWidth/scale)),
  height:Math.max(1,Math.round(outputHeight/scale)),
  deviceScaleFactor:scale,
  nativeResolution:false
 };
}

async function renderVideo(options){
 const {sourcePath,musicPath,outputPath,fps,width,height,onProgress=()=>{}}=options;
 const captureProfile=resolveCaptureProfile(sourcePath,width,height);
 const logicalWidth=captureProfile.width;
 const logicalHeight=captureProfile.height;
 const recordDir=fs.mkdtempSync(path.join(os.tmpdir(),"wedding-video-record-"));
 let browser=null,context=null,sourceServer=null,recording=null;
 const taskStartedAt=Date.now();
 try{
  onProgress(1,"启动浏览器","创建真实网页录制环境");
  browser=await chromium.launch({headless:true,args:[
   "--autoplay-policy=no-user-gesture-required",
   "--disable-background-timer-throttling",
   "--disable-renderer-backgrounding",
   "--disable-backgrounding-occluded-windows",
   "--disable-features=CalculateNativeWinOcclusion"
  ]});
  // 默认沿用移动端 CSS 视口；带有 wedding-video-viewport 标记且与输出尺寸一致的测试页，直接以目标像素尺寸录制。
  context=await browser.newContext({
   viewport:{width:logicalWidth,height:logicalHeight},
   deviceScaleFactor:captureProfile.deviceScaleFactor,
   colorScheme:"light",
   reducedMotion:"no-preference",
   recordVideo:{dir:recordDir,size:{width:logicalWidth,height:logicalHeight}}
  });
  const page=await context.newPage();
  recording=page.video();
  const pageErrors=[];
  page.on("pageerror",error=>{
   pageErrors.push(error.message);
   console.error("[邀请函脚本错误]",error.message);
  });
  page.on("console",message=>{
   if(message.type()==="error"){
    const detail=message.text();
    pageErrors.push("console: "+detail);
    console.error("[邀请函控制台]",detail);
   }
  });

  const sourceApp=express();
  sourceApp.use(express.static(path.dirname(sourcePath),{dotfiles:"allow",fallthrough:false}));
  sourceServer=http.createServer(sourceApp);
  await new Promise((resolve,reject)=>{
   sourceServer.once("error",reject);
   sourceServer.listen(0,"127.0.0.1",resolve);
  });
  const address=sourceServer.address();
  const sourceUrl="http://127.0.0.1:"+address.port+"/"+encodeURIComponent(path.basename(sourcePath));
  onProgress(3,"加载邀请函","通过本地 HTTP 加载网页；从页面打开开始记录真实播放");
  // 录制起点放在导航之前：网页自己的启动延迟、分段停顿和变速滚动都会完整保留。
  const recordingStartedAt=Date.now();
  await page.goto(sourceUrl,{waitUntil:"load",timeout:60000});
  const readyAt=Date.now();
  let initial=await readPlaybackState(page);
  onProgress(5,"等待网页自动播放","网页已加载，正在识别自动滚动或 CSS 动画");

  const maxRecordingMs=300000;
  const startupTimeoutMs=30000;
  const markerTailMs=1200;
  const bottomTailMs=4500;
  const idleEndMs=20000;
  let started=Boolean(initial.started),playbackDetectedAt=started?readyAt:0;
  let lastState=initial,lastActivityAt=readyAt,bottomSince=0,endedSince=0;
  let endReason="",lastProgressAt=0,latestState=initial;
  const activeScrollIds=new Set(initial.scrollables.filter(item=>item.top>1).map(item=>item.id));

  while(Date.now()-readyAt<maxRecordingMs){
   await page.waitForTimeout(200);
   const state=await readPlaybackState(page);
   latestState=state;
   let moved=false;
   const previousPositions=new Map(lastState.scrollables.map(item=>[item.id,item.top]));
   for(const item of state.scrollables){
    const previous=previousPositions.get(item.id);
    if(previous!==undefined&&Math.abs(item.top-previous)>.5){
     moved=true;
     activeScrollIds.add(item.id);
    }
   }
   const motionChanged=state.motionSignature!==lastState.motionSignature;
   if(moved||motionChanged)lastActivityAt=Date.now();

   if(!started&&(state.started||moved||motionChanged)){
    started=true;
    playbackDetectedAt=Date.now();
    onProgress(7,"真实网页播放录制","检测到网页开始运动，正在保留原始滚动速度和停顿");
   }
   if(!started&&Date.now()-readyAt>startupTimeoutMs){
    const diagnostics=[
     "播放器状态："+(state.playerState||"未暴露"),
     "播放器时间："+(state.playerTime===null?"未知":state.playerTime+" ms"),
     "预加载提示："+(state.loadingText||"无"),
     state.playerErrors.length?"播放器资源错误："+state.playerErrors.join("；"):"",
     pageErrors.length?"页面/控制台错误："+pageErrors.slice(-5).join("；"):""
    ].filter(Boolean).join(" | ");
    throw new Error("网页已加载，但 30 秒内没有进入自动播放状态。"+diagnostics+"。请检查邀请函资源是否加载完成。");
   }

   if(started){
    const recordingSeconds=(Date.now()-recordingStartedAt)/1000;
    const activeItems=state.scrollables.filter(item=>activeScrollIds.has(item.id));
    const activeAllAtBottom=activeItems.length>0&&activeItems.every(item=>item.bottom);
    const rootIsActive=activeItems.some(item=>item.isRoot);
    const rootAndActiveAtBottom=rootIsActive&&state.rootBottom&&activeItems.every(item=>item.bottom);
    const nestedAllAtBottom=!rootIsActive&&activeAllAtBottom;
    const transformAtEnd=state.transformBottom&&(activeItems.length===0||activeAllAtBottom);
    const atEnd=transformAtEnd||rootAndActiveAtBottom||nestedAllAtBottom;

    if(Date.now()-lastProgressAt>=700){
     lastProgressAt=Date.now();
     const progress=state.maxScroll>0?Math.min(78,7+state.progress*70):Math.min(72,12+recordingSeconds/idleEndMs*8);
     onProgress(progress,"真实网页播放录制",
      "已录制 "+recordingSeconds.toFixed(1)+" 秒 · 页面进度 "+Math.round(state.progress*100)+"%",
      {recordingSeconds:Number(recordingSeconds.toFixed(2)),scrollProgress:Number(state.progress.toFixed(4))});
    }

    if(state.ended){
     if(!endedSince)endedSince=Date.now();
     if(Date.now()-endedSince>=markerTailMs){
      endReason="网页播放完成标志";
      break;
     }
    }else{
     endedSince=0;
     if(atEnd&&state.finiteRunningAnimations===0){
      if(!bottomSince)bottomSince=Date.now();
      if(Date.now()-bottomSince>=bottomTailMs){
       endReason=state.transformBottom?"页面内容变换滚动到末尾并稳定":"网页滚动到末尾并稳定";
       break;
      }
     }else bottomSince=0;

     // 无滚动条的纯 CSS/JS 分屏动画：在画面长时间完全静止后自动结束。
     // 有真实滚动容器但尚未到底时不使用此兜底，避免中途停顿被误判为结束。
     if(activeScrollIds.size===0&&!state.hasTransformContent&&Date.now()-lastActivityAt>=idleEndMs&&state.finiteRunningAnimations===0){
      endReason="页面动画停止变化";
      break;
     }
    }
   }
   lastState=state;
  }

  if(!started)throw new Error("没有检测到网页自动播放，无法判断视频应从哪里开始。");
  if(!endReason)throw new Error("网页播放超过 300 秒仍未检测到结束。请检查网页是否循环播放，或是否存在无法自动识别的结束动画。");

  const recordingEndedAt=Date.now();
  const captureSeconds=Math.max(0,(recordingEndedAt-recordingStartedAt)/1000);
  const detectedDelaySeconds=playbackDetectedAt?Math.max(0,(playbackDetectedAt-recordingStartedAt)/1000):0;
  onProgress(80,"网页播放完成","真实播放结束，正在整理录制文件",{recordingSeconds:Number(captureSeconds.toFixed(2)),scrollProgress:1});
  await context.close();
  context=null;
  const recordedPath=await recording.path();
  await closeHttpServer(sourceServer);
  sourceServer=null;
  await browser.close();
  browser=null;

  onProgress(82,"转换 MP4","正在转换为目标分辨率和帧率，不改变网页播放时间轴",{recordingSeconds:Number(captureSeconds.toFixed(2)),scrollProgress:1});
  const encoded=await transcodeRecordedVideo({
   inputPath:recordedPath,outputPath,musicPath,fps,width,height,
   durationHint:captureSeconds,
   onProgress:state=>{
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
   detectedDelaySeconds:Number(detectedDelaySeconds.toFixed(3)),
   frames:encoded.frames,
   encodedFrames:encoded.encodedFrames,
   fps,
   avgFps:Number((encoded.frames/(encoded.durationSeconds||1)).toFixed(2)),
   totalSeconds:Number(taskSeconds.toFixed(2)),
   outputSizeBytes:encoded.size,
   captureWidth:logicalWidth,
   captureHeight:logicalHeight,
   nativeResolution:captureProfile.nativeResolution,
   pageHeight:latestState.pageHeight,
   viewportHeight:latestState.viewportHeight,
   maxScroll:latestState.maxScroll,
   chapterCount:latestState.chapterCount,
   pageErrors
  };
  console.log("[render metrics]",JSON.stringify(metrics,null,2));
  onProgress(100,"完成","MP4 已生成，实际时长 "+encoded.durationSeconds.toFixed(2)+" 秒",metrics);
 }catch(error){
  throw error;
 }finally{
  if(context)await context.close().catch(()=>{});
  if(browser)await browser.close().catch(()=>{});
  await closeHttpServer(sourceServer).catch(()=>{});
  fs.rmSync(recordDir,{recursive:true,force:true});
 }
}

module.exports={renderVideo};
