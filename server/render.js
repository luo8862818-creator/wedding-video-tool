const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const express=require("express");
const http=require("node:http");
const {chromium}=require("playwright");
const {transcodeRecordedVideo,transcodeFrameStream,encodeLiveFrames,ffmpegPath}=require("./ffmpeg");
const {CaptureQueue,selectEncoder}=require("./live-capture");

async function readPlaybackState(page){
 const frames=page.frames();
 const snapshots=await Promise.all(frames.map(async(frame,frameIndex)=>{
  try{
   const state=await frame.evaluate(()=>{
    const tracker=window.__weddingVideoTracker||(window.__weddingVideoTracker={ids:new WeakMap(),nextId:1});
    // Known players expose progress directly. Do not force layout on hundreds of
    // elements every 500 ms while Chromium is trying to paint the next frame.
    const knownKey=["templatePlayer","weddingPlayer","invitationPlayer"].find(key=>window[key]);
    const known=knownKey&&window[knownKey];
    if(known&&(Number.isFinite(known.totalMs)&&Number.isFinite(known.time)||["ended","finished","completed","isFinished"].some(key=>key in known))){
     const state=String(known.state||"").toUpperCase(),time=Number.isFinite(known.time)?known.time:null;
     const finished=Boolean(known.ended||known.finished||known.completed||known.isFinished||["FINISHED","ENDED","COMPLETE","COMPLETED"].includes(state));
     if(finished&&!tracker.finishedAt){tracker.finishedAt=performance.now();tracker.remainingHoldMs=Number.isFinite(known.totalMs)&&time!==null?Math.max(0,known.totalMs-time):0;}
     if(!finished){tracker.finishedAt=0;tracker.remainingHoldMs=0;}
     const ended=finished&&performance.now()-tracker.finishedAt>=(tracker.remainingHoldMs||0);
     const m=known.metrics||{},target=Number(known.target??m.endY)||0,y=Number(known.cameraY)||0;
     const diagnostics=window.__weddingCaptureDiagnostics||{},stats=diagnostics.animationFrameStats||{};
     const started=Boolean(known.started||known.playing||known.isPlaying||["INTRO_GIF","AUTO_SCROLL","OUTRO_GIF","FINISHED","USER_CONTROL"].includes(state));
     return {playerFound:true,playerKey:knownKey,playerState:state,playerTime:time,playerPaused:Boolean(known.paused),
      playerStarted:started,playerEnded:finished,playerTimelineTailHandled:Number.isFinite(known.totalMs)&&time!==null,
      playerErrors:Array.isArray(known.errors)?known.errors.slice(0,12).map(String):[],loadingText:(document.querySelector("#loading")?.textContent||"").trim(),
      started,ended,scrollables:[],rootBottom:false,transformBottom:false,hasTransformContent:true,
      progress:target>0?Math.max(0,Math.min(1,y/target)):0,maxScroll:target,rootMax:target,rootTop:0,
      motionSignature:knownKey+"|"+state+"|"+time+"|"+y,finiteRunningAnimations:0,runningAnimations:0,
      pageHeight:Number(m.pageHeight)||0,viewportWidth:innerWidth,viewportHeight:innerHeight,
      chapterCount:Number(m.chapters)||document.querySelectorAll(".chapter,.page,section").length,
      readyState:document.readyState,documentTitle:document.title,configFound:Boolean(window.weddingConfig),
      globals:[knownKey],scripts:[],resources:[],brokenImages:[],captureEvents:[],captureResourceErrors:diagnostics.resourceErrors||[],captureRejections:diagnostics.unhandledRejections||[],
      animationFrameStats:{frames:stats.frames||0,longFrames:stats.longFrames||0,veryLongFrames:stats.veryLongFrames||0,maxGapMs:stats.maxGapMs||0,averageGapMs:stats.frames?stats.totalGapMs/stats.frames:0},
      stateReadMode:"player-api"};
    }
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
      bottom:(Number(element.scrollTop)||0)>=max-4,isRoot:element===root,
      tag:element.tagName,idName:element.id||"",className:String(element.className||"").slice(0,100)
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
    let finiteRunningAnimations=0,runningAnimations=0;
    for(const animation of animations){
     if(animation.playState!=="running")continue;
     runningAnimations++;
     const timing=animation.effect?.getComputedTiming?.();
     if(timing&&timing.iterations!==Infinity)finiteRunningAnimations++;
    }

    const playerKey=["templatePlayer","weddingPlayer","invitationPlayer"].find(key=>{
     try{return Boolean(window[key]);}catch(_){return false;}
    })||null;
    let player=null;
    try{player=playerKey?window[playerKey]:null;}catch(_){}
    const playerState=String(player?.state||"").toUpperCase();
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
    const playerErrors=Array.isArray(player?.errors)?player.errors.slice(0,12).map(String):[];
    const loadingText=(document.querySelector("#loading")?.textContent||"").trim();
    const playerTime=typeof player?.time==="number"&&Number.isFinite(player.time)?player.time:null;
    const playerPaused=Boolean(player?.paused);
    const globalEnded=Boolean(window.weddingVideoFinished===true||window.invitationFinished===true||window.__weddingVideoFinished===true);
    const hintNodes=[...document.querySelectorAll("#hint,[data-playback-state],[data-playback-status],[aria-live='polite']")];
    const hintText=hintNodes.map(el=>(el.textContent||"").trim()).filter(Boolean).join(" ");
    const bodyState=String(document.body?.dataset?.playbackState||document.body?.dataset?.playbackStatus||"");
    const ended=playerEnded||globalEnded||/播放完成|播放结束|播放完毕|播放已结束|演示结束|已结束|playback complete|playback finished/i.test(hintText+" "+bodyState);
    const playingText=/正在自动播放|正在播放|播放中|playing/i.test(hintText+" "+bodyState);
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
    const diagnostics=window.__weddingCaptureDiagnostics||{};
    const rawFrameStats=diagnostics.animationFrameStats||{};
    const animationFrameStats={
     frames:Number(rawFrameStats.frames)||0,
     longFrames:Number(rawFrameStats.longFrames)||0,
     veryLongFrames:Number(rawFrameStats.veryLongFrames)||0,
     maxGapMs:Number(Number(rawFrameStats.maxGapMs||0).toFixed(1)),
     averageGapMs:rawFrameStats.frames?Number((rawFrameStats.totalGapMs/rawFrameStats.frames).toFixed(1)):0
    };
    const scripts=Array.from(document.scripts).map(script=>({
     src:script.src||"[inline]",
     type:script.type||"classic",
     async:Boolean(script.async),
     defer:Boolean(script.defer)
    })).slice(0,40);
    const resources=(performance.getEntriesByType("resource")||[])
     .filter(entry=>/\.(js|mjs|css|woff2?|ttf|otf|gif|webp|png|jpe?g|svg)(\?|$)/i.test(entry.name))
     .slice(-60).map(entry=>({
      url:entry.name,
      type:entry.initiatorType,
      duration:Number(entry.duration.toFixed(1)),
      transferSize:Number(entry.transferSize||0)
     }));
    const globals=Object.keys(window).filter(key=>/wedding|invitation|player/i.test(key)).slice(0,60);
    const images=Array.from(document.images);
    const brokenImages=images.filter(image=>image.complete&&!image.naturalWidth).map(image=>image.currentSrc||image.src).slice(0,20);
    const rootStyle=getComputedStyle(root);
    return {
     playerFound:Boolean(player),playerKey,playerState,
     playerTime,playerPaused,playerStarted,playerEnded,playerErrors,loadingText,
     started:playerStarted||playingText||rootTop>1||scrollables.some(item=>item.top>1)||(maxScroll<20&&runningAnimations>0),
     ended:playerEnded||globalEnded||/播放完成|播放结束|播放完毕|播放已结束|演示结束|已结束|playback complete|playback finished/i.test(hintText+" "+bodyState),
     scrollables,rootBottom,transformBottom,
     progress:Math.max(0,Math.min(1,Math.max(scrollProgress,transformProgress))),
     transformProgress,hasTransformContent:transformedRects.length>0,maxScroll,rootMax,
     hintText,bodyState,motionSignature:JSON.stringify(motion),
     finiteRunningAnimations,runningAnimations,animationFrameStats,
     pageHeight:root.scrollHeight,viewportWidth:innerWidth,viewportHeight:innerHeight,rootTop,
     chapterCount:document.querySelectorAll(".chapter,.page,section").length,
     documentTitle:document.title,documentUrl:location.href,readyState:document.readyState,
     bodyClass:String(document.body?.className||"").slice(0,200),
     rootOverflowY:rootStyle.overflowY,
     hasInvitationNode:Boolean(document.querySelector("#invitation")),
     hasMainNode:Boolean(document.querySelector("main")),
     iframeCount:document.querySelectorAll("iframe").length,
     configFound:Boolean(window.weddingConfig),
     globals,scripts,resources,
     imageCount:images.length,brokenImages,
     captureEvents:Array.isArray(diagnostics.events)?diagnostics.events.slice(-15):[],
     captureResourceErrors:Array.isArray(diagnostics.resourceErrors)?diagnostics.resourceErrors.slice(-20):[],
     captureRejections:Array.isArray(diagnostics.unhandledRejections)?diagnostics.unhandledRejections.slice(-10):[]
    };
   });
   return {
    ...state,frameIndex,frameUrl:frame.url(),frameName:frame.name(),
    isMainFrame:frame===page.mainFrame()
   };
  }catch(error){
   return {
    frameIndex,frameUrl:frame.url(),frameName:frame.name(),
    isMainFrame:frame===page.mainFrame(),evaluateError:error.message,
    playerFound:false,playerStarted:false,started:false,ended:false,
    scrollables:[],motionSignature:"",progress:0,maxScroll:0,
    pageHeight:0,viewportHeight:0
   };
  }
 }));

 const usable=snapshots.filter(item=>!item.evaluateError);
 const score=item=>
  (item.playerFound?100000:0)+(item.playerStarted?50000:0)+(item.started?20000:0)+
  ((item.scrollables||[]).length*100)+(item.hasTransformContent?50:0)+(item.isMainFrame?1:0);
 const selected=usable.slice().sort((a,b)=>score(b)-score(a))[0]||snapshots[0]||{};
 const frameIndex=Number(selected.frameIndex)||0;
 const scrollables=(selected.scrollables||[]).map(item=>({
  ...item,id:frameIndex*1000000+item.id,frameIndex,
  frameUrl:selected.frameUrl||""
 }));
 const frameSnapshots=snapshots.map(item=>({
  frameIndex:item.frameIndex,frameUrl:item.frameUrl,frameName:item.frameName,
  isMainFrame:item.isMainFrame,evaluateError:item.evaluateError||"",
  readyState:item.readyState||"",documentTitle:item.documentTitle||"",
  playerFound:Boolean(item.playerFound),playerKey:item.playerKey||"",
  playerState:item.playerState||"",playerTime:item.playerTime,
  playerPaused:Boolean(item.playerPaused),playerStarted:Boolean(item.playerStarted),
  playerErrors:item.playerErrors||[],loadingText:item.loadingText||"",
  configFound:Boolean(item.configFound),globals:item.globals||[],
  scripts:item.scripts||[],resources:item.resources||[],
  brokenImages:item.brokenImages||[],captureEvents:item.captureEvents||[],
  captureResourceErrors:item.captureResourceErrors||[],
  captureRejections:item.captureRejections||[],animationFrameStats:item.animationFrameStats||{},
  iframeCount:item.iframeCount||0,pageHeight:item.pageHeight||0,
  viewportHeight:item.viewportHeight||0,scrollables:item.scrollables||[]
 }));
 return {
  ...selected,scrollables,frameIndex,frameUrl:selected.frameUrl||"",
  rootId:frameIndex*1000000+(selected.rootId||0),
  frameCount:snapshots.length,frameSnapshots,
  motionSignature:String(frameIndex)+"|"+(selected.motionSignature||"")
 };
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
 const projectRoot=path.dirname(path.resolve(sourcePath));
 const queue=[{file:path.resolve(sourcePath),depth:0}];
 const visited=new Set(),scannedHtmlFiles=[];
 const markerPattern=/<meta\s+name=["']wedding-video-viewport["']\s+content=["'](\d{2,4})x(\d{2,4})["'][^>]*>/i;
 while(queue.length&&scannedHtmlFiles.length<30){
  const current=queue.shift(),file=path.resolve(current.file);
  if(visited.has(file))continue;
  visited.add(file);
  if(file!==projectRoot&&!file.startsWith(projectRoot+path.sep))continue;
  if(!fs.existsSync(file)||!fs.statSync(file).isFile()||path.extname(file).toLowerCase()!==".html")continue;
  let html="";
  try{html=fs.readFileSync(file,"utf8").slice(0,256*1024);}catch(_){continue;}
  const relative=path.relative(projectRoot,file)||path.basename(file);
  scannedHtmlFiles.push(relative);
  const marker=html.match(markerPattern);
  if(marker&&Number(marker[1])===outputWidth&&Number(marker[2])===outputHeight){
   return {
    width:outputWidth,height:outputHeight,deviceScaleFactor:1,nativeResolution:true,
    profileSource:"viewport-marker",markerFile:relative,
    markerWidth:Number(marker[1]),markerHeight:Number(marker[2]),scannedHtmlFiles
   };
  }
  if(current.depth>=4)continue;
  const iframeTags=html.match(/<iframe\b[^>]*>/gi)||[];
  for(const tag of iframeTags){
   const match=tag.match(/(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
   const src=(match?.[1]||match?.[2]||match?.[3]||"").trim();
   if(!src||/^(?:data:|blob:|javascript:|about:|https?:|\/\/)/i.test(src))continue;
   try{
    const currentUrlPath=path.relative(projectRoot,file).replace(/\\/g,"/");
    const parsed=new URL(src,"http://wedding.local/"+currentUrlPath);
    if(parsed.origin!=="http://wedding.local")continue;
    const relativePath=decodeURIComponent(parsed.pathname).replace(/^\/+/,"");
    const candidate=path.resolve(projectRoot,relativePath);
    if(candidate!==projectRoot&&!candidate.startsWith(projectRoot+path.sep))continue;
    if(path.extname(candidate).toLowerCase()!==".html")continue;
    queue.push({file:candidate,depth:current.depth+1});
   }catch(_){}
  }
 }
 return {
  width:outputWidth,height:outputHeight,deviceScaleFactor:1,nativeResolution:true,
  profileSource:"output-size-fallback",markerFile:null,
  markerWidth:null,markerHeight:null,scannedHtmlFiles
 };
}
function resolveLocalCaptureReference(rootDir,fromFile,rawReference){
 const raw=String(rawReference||"").trim();
 if(!raw||/^(?:data:|blob:|javascript:|https?:|\/\/|#)/i.test(raw))return null;
 try{
  const relativeBase=path.relative(rootDir,fromFile).replace(/\\/g,"/");
  const parsed=new URL(raw,"http://wedding-capture.local/"+relativeBase);
  if(parsed.origin!=="http://wedding-capture.local")return null;
  const relativePath=decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
  const candidate=path.resolve(rootDir,relativePath);
  if(candidate!==rootDir&&!candidate.startsWith(rootDir+path.sep))return null;
  return candidate;
 }catch(_){return null;}
}

function findDeterministicCaptureScript(sourcePath){
 const rootDir=path.dirname(path.resolve(sourcePath));
 const queue=[path.resolve(sourcePath)],visited=new Set();
 while(queue.length&&visited.size<300){
  const file=path.resolve(queue.shift());
  if(visited.has(file))continue;
  visited.add(file);
  if(file!==rootDir&&!file.startsWith(rootDir+path.sep))continue;
  if(!fs.existsSync(file))continue;
  let stat;
  try{stat=fs.statSync(file);}catch(_){continue;}
  if(!stat.isFile()||stat.size>2*1024*1024)continue;
  const extension=path.extname(file).toLowerCase();
  if(extension!==".html"&&extension!==".htm"&&extension!==".js"&&extension!==".mjs"&&extension!==".cjs")continue;
  let content="";
  try{content=fs.readFileSync(file,"utf8");}catch(_){continue;}
  if(/__OFFLINE_CAPTURE/.test(content)&&/weddingPlayer/.test(content)&&/renderAt\s*=/.test(content)&&/renderCapture\s*=/.test(content)){
   return file;
  }
  if(extension===".html"||extension===".htm"){
   const tags=content.match(/<(?:script|iframe)\b[^>]*>/gi)||[];
   for(const tag of tags){
    const match=tag.match(/(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const reference=(match?.[1]||match?.[2]||match?.[3]||"").trim();
    const candidate=resolveLocalCaptureReference(rootDir,file,reference);
    if(candidate&&/\.(?:html?|mjs|cjs|js)$/i.test(candidate))queue.push(candidate);
   }
  }
 }
 return null;
}

async function findDeterministicPlayerFrame(page,timeoutMs=20000){
 const startedAt=Date.now();
 while(Date.now()-startedAt<timeoutMs){
  for(const frame of page.frames()){
   try{
    const supported=await frame.evaluate(()=>Boolean(
     window.weddingPlayer&&
     typeof window.weddingPlayer.renderAt==="function"&&
     typeof window.weddingPlayer.renderCapture==="function"&&
     window.weddingPlayer.ready
    ));
    if(supported)return frame;
   }catch(_){}
  }
  await page.waitForTimeout(100);
 }
 return null;
}

async function* createDeterministicFrameStream({page,frame,fps,frameCount,onProgress}){
 const progressInterval=Math.max(1,Math.round(fps));
 const session=await page.context().newCDPSession(page);
 try{
 for(let index=0;index<frameCount;index++){
  const timeMs=index*1000/fps;
  await frame.evaluate(async(ms)=>{
   const player=window.weddingPlayer;
   if(!player||typeof player.renderAt!=="function"||typeof player.renderCapture!=="function"){
    throw new Error("邀请函逐帧渲染接口在导出过程中丢失。");
   }
   player.renderAt(ms);
   await player.renderCapture();
   for(const animation of document.getAnimations()){
    try{animation.pause();animation.currentTime=ms;}catch(_){}
   }
  },timeMs);
  // Capture forces compositing after renderCapture; skip PNG compression work.
  const shot=await session.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false,optimizeForSpeed:true});
  const image=Buffer.from(shot.data,"base64");
  if(index%progressInterval===0||index===frameCount-1){
   const progress=6+((index+1)/frameCount)*72;
   onProgress(progress,"逐帧渲染邀请函",
    "已渲染 "+(index+1)+"/"+frameCount+" 帧 · "+(timeMs/1000).toFixed(1)+" 秒",
    {renderedFrames:index+1,expectedFrames:frameCount,frameTimeMs:Number(timeMs.toFixed(2))});
  }
  yield image;
 }
 }finally{await session.detach().catch(()=>{});}
}

async function renderVideo(options){
 const {sourcePath,musicPath,outputPath,fps,width,height,onProgress=()=>{}}=options;
 const logger=options.logger||{info:()=>{},warn:()=>{},error:()=>{},write:()=>{}};
 const captureProfile=resolveCaptureProfile(sourcePath,width,height);
 const logicalWidth=captureProfile.width;
 const logicalHeight=captureProfile.height;
 const requestedMode=options.captureMode||process.env.WEDDING_CAPTURE_MODE||"auto";
 const deterministicCaptureScript=requestedMode!=="live"?findDeterministicCaptureScript(sourcePath):null;
 const deterministicCapture=requestedMode==="deterministic"||(requestedMode==="auto"&&Boolean(deterministicCaptureScript));
 if(deterministicCapture&&!deterministicCaptureScript)throw new Error("该项目没有逐帧接口；请使用默认的连续录制模式。");
 const recordDir=fs.mkdtempSync(path.join(os.tmpdir(),"wedding-video-record-"));
 let browser=null,context=null,sourceServer=null,liveQueue=null,liveEncoding=null,liveError=null,livePage=null,liveProfile=null;
 const taskStartedAt=Date.now();
 try{
  logger.info("导出参数",{
   sourcePath,outputPath,musicPath:Boolean(musicPath),fps,width,height,
   captureProfile,playwrightVersion:require("playwright/package.json").version,
   captureMode:deterministicCapture?"deterministic-frame-rendering":"playwright-real-recording",
   deterministicCaptureScript:deterministicCaptureScript?path.relative(path.dirname(path.resolve(sourcePath)),deterministicCaptureScript):null
  });
  onProgress(1,"启动浏览器","创建原生分辨率网页录制环境");
  browser=await chromium.launch({headless:true,...(process.env.WEDDING_BROWSER_CHANNEL?{channel:process.env.WEDDING_BROWSER_CHANNEL}:{}),args:[
   "--autoplay-policy=no-user-gesture-required",
   "--disable-background-timer-throttling",
   "--disable-renderer-backgrounding",
   "--disable-backgrounding-occluded-windows",
   "--disable-features=CalculateNativeWinOcclusion"
  ]});
  // 浏览器视口、录制画布和最终视频统一使用目标尺寸，禁止低分辨率采集后放大。
  context=await browser.newContext({
   viewport:{width:logicalWidth,height:logicalHeight},
   screen:{width:logicalWidth,height:logicalHeight},
   deviceScaleFactor:captureProfile.deviceScaleFactor,
   colorScheme:"light",
   reducedMotion:"no-preference",
   // Continuous JPEG delivery is encoded once to H.264 below; no VP9 intermediate.
  });
  logger.info("浏览器录制配置",{
   browserVersion:browser.version(),
   viewport:{width:logicalWidth,height:logicalHeight},
   videoSize:{width:logicalWidth,height:logicalHeight},
   deviceScaleFactor:captureProfile.deviceScaleFactor,captureFps:fps
  });
  const page=await context.newPage();
  livePage=page;
  const livePath=path.join(recordDir,"live-h264.mkv");
  if(!deterministicCapture){
   if(!page.screencast?.start)throw new Error("需要 Playwright >=1.59 的连续 screencast 接口，请执行 npm ci。");
   liveProfile=await selectEncoder(ffmpegPath,{width,height,fps,directory:recordDir});
   liveQueue=new CaptureQueue(fps,{onOverflow:"error"});
   liveEncoding=encodeLiveFrames({frames:liveQueue,outputPath:livePath,fps,profile:liveProfile,logger});
   liveEncoding.catch(error=>{liveError=error;liveQueue.stop();});
   logger.info("连续录制编码器",liveProfile);
   await page.screencast.start({size:{width:logicalWidth,height:logicalHeight},fps,quality:92,onFrame:frame=>{try{liveQueue.push(frame);}catch(error){liveError=error;liveQueue.stop();}}});
  }
  const pageErrors=[],networkIssues=[],consoleIssues=[],frameEvents=[];
  const keepLast=(list,item,max=80)=>{list.push(item);if(list.length>max)list.shift();};
  if(deterministicCapture)await page.addInitScript(()=>{window.__OFFLINE_CAPTURE=true;});
  await page.addInitScript(()=>{
   const store=window.__weddingCaptureDiagnostics={
    events:[],resourceErrors:[],unhandledRejections:[],
    animationFrameStats:{frames:0,longFrames:0,veryLongFrames:0,totalGapMs:0,maxGapMs:0,lastTimestamp:0}
   };
   const keep=(list,item,max)=>{
    list.push(item);if(list.length>max)list.shift();
   };
   window.addEventListener("error",event=>{
    const target=event.target;
    const item={
     message:event.message||"资源加载失败",
     filename:event.filename||"",
     line:event.lineno||0,column:event.colno||0,
     resource:target&&(target.src||target.href)||"",
     tag:target&&target.tagName||""
    };
    keep(store.events,item,60);
    if(item.resource)keep(store.resourceErrors,item,60);
   },true);
   window.addEventListener("unhandledrejection",event=>{
    const reason=event.reason;
    keep(store.unhandledRejections,{
     reason:String(reason?.stack||reason?.message||reason||"未知 Promise 异常")
    },30);
   });
   document.addEventListener("DOMContentLoaded",()=>{
    keep(store.events,{event:"DOMContentLoaded",time:Math.round(performance.now())},60);
   });
   window.addEventListener("load",()=>{
    keep(store.events,{event:"load",time:Math.round(performance.now())},60);
   });
   const measureFrame=timestamp=>{
    const stats=store.animationFrameStats;
    if(stats.lastTimestamp){
     const gap=timestamp-stats.lastTimestamp;
     stats.frames++;stats.totalGapMs+=gap;
     if(gap>50)stats.longFrames++;
     if(gap>100)stats.veryLongFrames++;
     if(gap>stats.maxGapMs)stats.maxGapMs=gap;
    }
    stats.lastTimestamp=timestamp;
    requestAnimationFrame(measureFrame);
   };
   if(!window.__OFFLINE_CAPTURE)requestAnimationFrame(measureFrame);
  });
  page.on("pageerror",error=>{
   keepLast(pageErrors,{message:error.message,stack:error.stack||""});
   logger.error("邀请函页面脚本异常",{message:error.message,stack:error.stack||""});
  });
  page.on("console",message=>{
   if(message.type()==="error"||message.type()==="warning"){
    const detail={type:message.type(),text:message.text(),location:message.location()};
    keepLast(consoleIssues,detail);
    logger.write(message.type()==="error"?"ERROR":"WARN","邀请函控制台消息",detail);
   }
  });
  page.on("requestfailed",request=>{
   const item={
    type:"requestfailed",url:request.url(),resourceType:request.resourceType(),
    error:request.failure()?.errorText||"unknown"
   };
   keepLast(networkIssues,item);
   logger.error("邀请函资源请求失败",item);
  });
  page.on("response",response=>{
   if(response.status()>=400){
    const item={
     type:"http-error",status:response.status(),url:response.url(),
     resourceType:response.request().resourceType()
    };
    keepLast(networkIssues,item);
    logger.error("邀请函资源 HTTP 错误",item);
   }
  });
  page.on("frameattached",frame=>{
   const item={event:"attached",url:frame.url(),name:frame.name()};
   keepLast(frameEvents,item);
   logger.info("网页子框架附加",item);
  });
  page.on("framenavigated",frame=>{
   const item={event:"navigated",url:frame.url(),name:frame.name(),main:frame===page.mainFrame()};
   keepLast(frameEvents,item);
   logger.info("网页框架导航",item);
  });
  page.on("framedetached",frame=>{
   const item={event:"detached",url:frame.url(),name:frame.name()};
   keepLast(frameEvents,item);
   logger.info("网页子框架卸载",item);
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
  if(liveQueue)liveQueue.start(recordingStartedAt);
  await page.goto(sourceUrl,{waitUntil:"load",timeout:60000});
  const readyAt=Date.now();
  let initial=await readPlaybackState(page);
  logger.info("页面初始诊断",{
   sourcePath,sourceUrl,pageUrl:page.url(),title:await page.title(),
   frameCount:initial.frameCount,selectedFrameIndex:initial.frameIndex,
   selectedFrameUrl:initial.frameUrl,frames:initial.frameSnapshots,
   pageErrors,consoleIssues,networkIssues,frameEvents
  });
  onProgress(5,"等待网页自动播放","网页已加载，正在检查主页面和 iframe 的播放器状态");

  if(deterministicCapture){
   const playerFrame=await findDeterministicPlayerFrame(page);
   if(!playerFrame)throw new Error("项目包含离线逐帧渲染接口，但 20 秒内没有找到 weddingPlayer.renderAt/renderCapture。请检查邀请函 iframe 和播放器脚本是否加载成功。");
   onProgress(6,"准备逐帧渲染","正在等待邀请函素材、字体和动画资源准备完成");
   const playerInfo=await playerFrame.evaluate(async()=>{
    const player=window.weddingPlayer;
    await player.ready;
    return {
     totalMs:Number(player.totalMs)||0,
     state:player.state||"",
     metrics:player.metrics||null,
     errors:Array.isArray(player.errors)?player.errors.slice():[]
    };
   });
   if(!Number.isFinite(playerInfo.totalMs)||playerInfo.totalMs<=0){
    throw new Error("邀请函播放器没有提供有效的 totalMs 动画总时长。");
   }
   if(playerInfo.errors.length){
    throw new Error("邀请函素材准备失败："+playerInfo.errors.join("；"));
   }
   const totalMs=playerInfo.totalMs;
   const expectedFrames=Math.max(1,Math.ceil(totalMs*fps/1000));
   const durationHint=expectedFrames/fps;
   const offlineCaptureStartedAt=Date.now();
   logger.info("离线逐帧渲染开始",{
    playerFrameUrl:playerFrame.url(),playerState:playerInfo.state,
    totalMs,durationSeconds:Number((totalMs/1000).toFixed(3)),
    fps,expectedFrames,frameIntervalMs:Number((1000/fps).toFixed(3)),
    captureSize:{width:logicalWidth,height:logicalHeight},
    playerMetrics:playerInfo.metrics
   });
   let renderedFrames=0;
   const frameStream=createDeterministicFrameStream({
    page,frame:playerFrame,fps,frameCount:expectedFrames,
    onProgress:(progress,label,message,extra)=>{renderedFrames=extra.renderedFrames;onProgress(progress,label,message,extra);}
   });
   const encoded=await transcodeFrameStream({
    frames:frameStream,outputPath,musicPath,fps,width,height,
    expectedFrames,durationHint,logger,
    onProgress:(ratio,message)=>{if(renderedFrames<expectedFrames)return;onProgress(82+ratio*16,"转换 MP4",message,{
     renderedFrames:expectedFrames,encodedDurationSeconds:Number((ratio*durationHint).toFixed(2))
    });}
   });
   const captureSeconds=(Date.now()-offlineCaptureStartedAt)/1000;
   const taskSeconds=(Date.now()-taskStartedAt)/1000;
   const finalState=await readPlaybackState(page);
   const metrics={
    mode:"deterministic-player-frame-rendering",
    endReason:"player.totalMs 时间轴完成",
    durationSeconds:encoded.durationSeconds,
    captureSeconds:Number(captureSeconds.toFixed(2)),
    renderThroughputFps:Number((expectedFrames/(captureSeconds||1)).toFixed(2)),
    detectedDelaySeconds:0,
    frames:encoded.frames,
    expectedFrames,
    encodedFrames:encoded.encodedFrames,
    fps,
    avgFps:Number((encoded.frames/(encoded.durationSeconds||1)).toFixed(2)),
    totalSeconds:Number(taskSeconds.toFixed(2)),
    outputSizeBytes:encoded.size,
    captureWidth:logicalWidth,
    captureHeight:logicalHeight,
    nativeResolution:captureProfile.nativeResolution,
    pageHeight:playerInfo.metrics?.pageHeight||finalState.pageHeight,
    viewportHeight:playerInfo.metrics?.viewportHeight||finalState.viewportHeight,
    maxScroll:playerInfo.metrics?.endY||finalState.maxScroll,
    chapterCount:playerInfo.metrics?.chapters||finalState.chapterCount,
    frameCount:finalState.frameCount,
    selectedFrameUrl:playerFrame.url(),
    playerKey:"weddingPlayer",
    playerState:finalState.playerState,
    renderTimelineMs:totalMs,
    renderMethod:"player.renderAt + player.renderCapture",
    pageErrors:pageErrors.map(item=>item.message)
   };
   logger.info("导出指标",metrics);
   onProgress(100,"完成","逐帧 MP4 已生成，实际时长 "+encoded.durationSeconds.toFixed(2)+" 秒",metrics);
   return;
  }

  const maxRecordingMs=300000;
  const startupTimeoutMs=30000;
  const markerTailMs=1200;
  const bottomTailMs=4500;
  const idleEndMs=20000;
  let started=Boolean(initial.started),playbackDetectedAt=started?readyAt:0;
  let lastState=initial,lastActivityAt=readyAt,bottomSince=0,endedSince=0;
  let endReason="",lastProgressAt=0,latestState=initial,lastTraceAt=Date.now();
  const activeScrollIds=new Set(initial.scrollables.filter(item=>item.top>1).map(item=>item.id));

  while(Date.now()-readyAt<maxRecordingMs){
   await page.waitForTimeout(500);
   if(liveError)throw liveError;
   const state=await readPlaybackState(page);
   latestState=state;
   if(state.playerErrors?.length)throw new Error("网页播放器错误："+state.playerErrors.join("；"));
   if(Date.now()-lastTraceAt>=5000){
    lastTraceAt=Date.now();
    logger.info("播放状态追踪",{
     elapsedSeconds:Number(((Date.now()-recordingStartedAt)/1000).toFixed(1)),
     frameCount:state.frameCount,selectedFrameIndex:state.frameIndex,
     frameUrl:state.frameUrl,playerFound:state.playerFound,
     playerKey:state.playerKey,playerState:state.playerState,
     playerTime:state.playerTime,playerPaused:state.playerPaused,
     started:state.started,ended:state.ended,
     loadingText:state.loadingText,playerErrors:state.playerErrors,
     animationFrameStats:state.animationFrameStats||{},scrollables:state.scrollables,progress:state.progress,
     pageHeight:state.pageHeight,viewportHeight:state.viewportHeight,
     frames:state.frameSnapshots.map(frame=>({
      frameIndex:frame.frameIndex,url:frame.frameUrl,readyState:frame.readyState,
      playerFound:frame.playerFound,playerKey:frame.playerKey,
      playerState:frame.playerState,playerTime:frame.playerTime,
      loadingText:frame.loadingText,animationFrameStats:frame.animationFrameStats||{},scriptSources:(frame.scripts||[]).map(script=>script.src),
      evaluateError:frame.evaluateError
     }))
    });
   }
   let moved=false;
   const playerAdvanced=state.playerTime!==null&&lastState.playerTime!==null&&state.playerTime>lastState.playerTime+1;
   if(playerAdvanced)moved=true;
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
    const report={
     sourcePath,sourceUrl,pageUrl:page.url(),title:await page.title(),
     elapsedSeconds:Number(((Date.now()-readyAt)/1000).toFixed(1)),
     selectedFrameIndex:state.frameIndex,selectedFrameUrl:state.frameUrl,
     frameCount:state.frameCount,frames:state.frameSnapshots,
     pageErrors:pageErrors.slice(-30),consoleIssues:consoleIssues.slice(-30),
     networkIssues:networkIssues.slice(-40),frameEvents:frameEvents.slice(-30)
    };
    logger.error("启动失败完整诊断",report);
    const frameSummary=state.frameSnapshots.map(frame=>{
     const scripts=(frame.scripts||[]).map(script=>script.src.split("/").slice(-2).join("/")).join(",");
     return "frame#"+frame.frameIndex+" "+(frame.isMainFrame?"主页面":"子页面")+
      " url="+frame.frameUrl+" player="+(frame.playerKey||"无")+
      " state="+(frame.playerState||"无")+" scripts=["+scripts+"]"+
      (frame.evaluateError?" evaluateError="+frame.evaluateError:"");
    }).join(" || ");
    const issueSummary=networkIssues.slice(-8).map(item=>
     item.type+":"+(item.status||item.error||"") +" "+item.url
    ).join("；");
    throw new Error(
     "网页已加载，但 30 秒内没有进入自动播放状态。"+
     "检测到 "+state.frameCount+" 个页面框架。"+frameSummary+
     (pageErrors.length?"；JS异常："+pageErrors.slice(-5).map(item=>item.message).join("；"):"")+
     (issueSummary?"；资源请求异常："+issueSummary:"")+
     "。完整诊断已保存到本次任务日志文件，可直接在页面下载。"
    );
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
     if(Date.now()-endedSince>=(state.playerTimelineTailHandled?0:markerTailMs)){
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
  await page.screencast.stop();
  liveQueue.stop(recordingEndedAt);
  const liveEncoded=await liveEncoding;
  const captureStats=liveQueue.snapshot();
  logger.info("连续录屏实际帧统计",captureStats);
  if(captureStats.droppedSourceFrames)logger.warn("编码队列发生丢帧，请使用 30 FPS、硬件编码并关闭其他高负载程序。",captureStats);
  await context.close();
  context=null;
  const recordedPath=livePath;
  await closeHttpServer(sourceServer);
  sourceServer=null;
  await browser.close();
  browser=null;

  onProgress(82,"封装 MP4","H.264 已实时编码完成，正在封装并完整校验，不重复视频编码",{recordingSeconds:Number(captureSeconds.toFixed(2)),scrollProgress:1});
  const encoded=await transcodeRecordedVideo({
   inputPath:recordedPath,outputPath,musicPath,fps,width,height,
   durationHint:captureSeconds,logger,copyVideo:true,
   onProgress:state=>{
    const ratio=captureSeconds>0?Math.min(1,state.outTimeSeconds/captureSeconds):0;
    onProgress(82+ratio*16,"封装 MP4","已封装 "+state.outTimeSeconds.toFixed(1)+" 秒",{recordingSeconds:Number(captureSeconds.toFixed(2)),encodedFrames:state.frame});
   }
  });
  const taskSeconds=(Date.now()-taskStartedAt)/1000;
  const metrics={
   mode:"native-screencast-h264",
   encoder:liveProfile.name,
   captureStats,
   endReason,
   durationSeconds:encoded.durationSeconds,
   captureSeconds:Number(captureSeconds.toFixed(2)),
   detectedDelaySeconds:Number(detectedDelaySeconds.toFixed(3)),
   frames:encoded.frames,
   encodedFrames:liveEncoded.frame||captureStats.outputFrames,
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
   frameCount:latestState.frameCount,
   selectedFrameUrl:latestState.frameUrl,
   playerKey:latestState.playerKey,
   playerState:latestState.playerState,
   animationFrameStats:latestState.animationFrameStats||{},
   pageErrors:pageErrors.map(item=>item.message)
  };
  logger.info("导出指标",metrics);
  onProgress(100,"完成","MP4 已生成，实际时长 "+encoded.durationSeconds.toFixed(2)+" 秒",metrics);
 }catch(error){
  throw error;
 }finally{
  if(liveQueue){await livePage?.screencast.stop().catch(()=>{});liveQueue.stop();if(liveEncoding)await liveEncoding.catch(()=>{});}
  if(context)await context.close().catch(()=>{});
  if(browser)await browser.close().catch(()=>{});
  await closeHttpServer(sourceServer).catch(()=>{});
  fs.rmSync(recordDir,{recursive:true,force:true});
 }
}

module.exports={renderVideo,readPlaybackState,resolveCaptureProfile,findDeterministicCaptureScript};

