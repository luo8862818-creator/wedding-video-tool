const crypto=require("node:crypto");
const {pathToFileURL}=require("node:url");
const {chromium}=require("playwright");
const {startVideoEncoder}=require("./ffmpeg");

function jpegSize(buffer){
 let i=2;
 while(i<buffer.length){
  if(buffer[i++]!==0xff)continue;
  let marker=buffer[i++];
  while(marker===0xff)marker=buffer[i++];
  if(marker===0xd8||marker===0xd9||marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
  if(i+7>buffer.length)return null;
  const length=buffer.readUInt16BE(i);
  if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
   return {width:buffer.readUInt16BE(i+5),height:buffer.readUInt16BE(i+3)};
  }
  if(length<2)return null;
  i+=length;
 }
 return null;
}

async function settleFrame(page,timeMs){
 return page.evaluate(async ms=>{
  const p=window.weddingPlayer;
  const result=p.renderAt(ms);
  if(typeof p.renderCapture==="function")await p.renderCapture();
  // 等待 DOM、图片解码和浏览器合成器完成本帧更新，再进行截图。
  await new Promise(resolve=>requestAnimationFrame(resolve));
  return {
   state:result.state,
   y:result.y,
   scrollY:window.scrollY,
   time:result.time,
   introSrc:document.getElementById("intro")?.getAttribute("src"),
   outroSrc:document.getElementById("outro")?.getAttribute("src")
  };
 },timeMs);
}

async function renderVideo(options){
 const {sourcePath,musicPath,outputPath,duration,fps,width,height,onProgress}=options;
 const frameCount=Math.ceil(duration*fps);
 const logicalWidth=450;
 const logicalHeight=logicalWidth*height/width;
 const deviceScaleFactor=width/logicalWidth;
 let browser=null,context=null,encoder=null;
 const startedAt=Date.now();
 let timelineMsTotal=0,screenshotMs=0,encoderWaitMs=0;
 const samples={};
 try{
  onProgress(1,"启动浏览器","创建单一确定性渲染页面");
  browser=await chromium.launch({headless:true,args:[
   "--disable-background-timer-throttling",
   "--disable-renderer-backgrounding",
   "--disable-backgrounding-occluded-windows",
   "--disable-features=CalculateNativeWinOcclusion"
  ]});
  context=await browser.newContext({
   viewport:{width:logicalWidth,height:logicalHeight},
   deviceScaleFactor,
   colorScheme:"light",
   reducedMotion:"no-preference"
  });
  const page=await context.newPage();
  page.on("pageerror",error=>console.error("[邀请函脚本错误]",error.message));
  page.on("console",message=>{if(message.type()==="error")console.error("[邀请函控制台]",message.text());});
  await page.addInitScript(()=>{window.__OFFLINE_CAPTURE=true;});
  onProgress(3,"加载邀请函","CSS 视口 "+logicalWidth+"×"+logicalHeight+"，输出 "+width+"×"+height);
  await page.goto(pathToFileURL(sourcePath).href,{waitUntil:"load",timeout:60000});
  const ready=await page.evaluate(async()=>{
   await window.weddingPlayer?.ready;
   if(document.fonts?.ready)await document.fonts.ready;
   await Promise.all([...document.images].map(img=>img.decode().catch(()=>{})));
   const p=window.weddingPlayer;
   return {
    supported:Boolean(p&&typeof p.renderAt==="function"&&typeof p.renderCapture==="function"),
    totalMs:p?.totalMs||0,
    errors:p?.errors||[],
    pageHeight:document.documentElement.scrollHeight,
    viewportHeight:innerHeight,
    viewportWidth:innerWidth,
    scrollTarget:Math.max(0,document.documentElement.scrollHeight-innerHeight),
    chapterCount:document.querySelectorAll("main>.chapter").length,
    metrics:p?.metrics||null
   };
  });
  if(!ready.supported)throw new Error("邀请函没有提供完整的 weddingPlayer.renderAt()/renderCapture() 时间轴接口。");
  if(ready.errors.length)throw new Error("邀请函素材加载失败："+ready.errors.join("；"));
  if(!ready.totalMs||ready.totalMs<=0)throw new Error("邀请函时间轴总时长无效。");
  if(ready.chapterCount<2||ready.scrollTarget<10)throw new Error("页面没有检测到有效的多章节滚动内容。章节数："+ready.chapterCount+"，滚动距离："+ready.scrollTarget+"px。");
  const timelineMs=ready.totalMs;
  // 导出时长可以改变播放速度，但必须完整覆盖整个网页时间轴。
  const startProbe=await settleFrame(page,0);
  const middleProbe=await settleFrame(page,timelineMs*0.5);
  const endProbe=await settleFrame(page,timelineMs-1);
  if(startProbe.state!=="INTRO_GIF"||middleProbe.state!=="AUTO_SCROLL"||endProbe.state!=="FINISHED"){
   throw new Error("时间轴预检失败："+JSON.stringify({startProbe,middleProbe,endProbe}));
  }
  if(middleProbe.y<=startProbe.y+10||endProbe.y<=middleProbe.y){
   throw new Error("滚动预检失败：中段与结尾画面没有向下移动。"+JSON.stringify({startProbe,middleProbe,endProbe}));
  }
  // 重置章节装饰的首次进入状态，避免预检过程污染正式录制。
  await page.evaluate(()=>{
   const p=window.weddingPlayer;
   p.chapters?.forEach(section=>{
    section.seen=false;
    if(section.header){section.header.style.opacity="";section.header.style.transform="";}
   });
  });
  await settleFrame(page,0);
  encoder=startVideoEncoder({outputPath,fps,duration,musicPath,expectedFrames:frameCount});
  onProgress(5,"逐帧渲染与编码","共 "+frameCount+" 帧；按同一时间轴顺序采集，不并行跳帧");
  for(let frame=0;frame<frameCount;frame++){
   // 以输出视频的时间映射到完整网页时间轴，保证首尾覆盖。
   const videoTime=frame/fps;
   const timelineTime=Math.min(timelineMs-1,videoTime/duration*timelineMs);
   const controlStart=Date.now();
   const state=await settleFrame(page,timelineTime);
   timelineMsTotal+=Date.now()-controlStart;
   const shotStart=Date.now();
   const image=await page.screenshot({
    type:"jpeg",quality:92,animations:"allow",caret:"hide",scale:"device"
   });
   screenshotMs+=Date.now()-shotStart;
   if(frame===0||frame===Math.floor(frameCount*.25)||frame===Math.floor(frameCount*.5)||frame===Math.floor(frameCount*.75)||frame===frameCount-1){
    samples[frame]={
     hash:crypto.createHash("sha256").update(image).digest("hex"),
     state:state.state,y:state.y,scrollY:state.scrollY,time:state.time,
     introSrc:state.introSrc,outroSrc:state.outroSrc
    };
   }
   if(frame===0){
    const actual=jpegSize(image);
    if(!actual||actual.width!==width||actual.height!==height){
     throw new Error("截图尺寸错误：实际 "+JSON.stringify(actual)+"，预期 "+width+"×"+height+"。");
    }
   }
   const waitStart=Date.now();
   await encoder.writeFrame(image);
   encoderWaitMs+=Date.now()-waitStart;
   if(frame%Math.max(1,Math.floor(fps/2))===0||frame===frameCount-1){
    const written=frame+1;
    const elapsed=(Date.now()-startedAt)/1000;
    onProgress(5+written/frameCount*90,"逐帧渲染与编码",
     "第 "+written+" / "+frameCount+" 帧 · "+(written/Math.max(elapsed,.001)).toFixed(1)+" 帧/秒");
   }
  }
  const distinctHashes=new Set(Object.values(samples).map(s=>s.hash));
  const distinctPositions=new Set(Object.values(samples).map(s=>Math.round(s.y)));
  if(distinctHashes.size<3||distinctPositions.size<3){
   throw new Error("画面动态校验失败：采集到的关键帧变化不足。截图差异数 "+distinctHashes.size+"，滚动位置数 "+distinctPositions.size+"。关键帧："+JSON.stringify(samples));
  }
  const sampledStates=Object.values(samples).map(s=>s.state);
  if(!sampledStates.includes("INTRO_GIF")||!sampledStates.includes("AUTO_SCROLL")||!sampledStates.includes("FINISHED")){
   throw new Error("视频关键帧未覆盖开场、滚动和结尾阶段："+JSON.stringify(samples));
  }
  onProgress(96,"封装视频","正在等待 FFmpeg 完成 MP4 编码");
  const encoded=await encoder.finish();
  encoder=null;
  if(encoded.frames!==frameCount){
   throw new Error("MP4 帧数不一致：渲染 "+frameCount+" 帧，编码 "+encoded.frames+" 帧。");
  }
  const elapsedMs=Date.now()-startedAt;
  const metrics={
   frames:frameCount,workerCount:1,
   outputWidth:width,outputHeight:height,
   cssViewportWidth:logicalWidth,cssViewportHeight:logicalHeight,deviceScaleFactor,
   timelineMs:ready.totalMs,timelineMsTotal,screenshotMs,encoderWaitMs,
   totalSeconds:Number((elapsedMs/1000).toFixed(2)),
   avgFps:Number((frameCount/(elapsedMs/1000||1)).toFixed(2)),
   pageHeight:ready.pageHeight,scrollTarget:ready.scrollTarget,
   chapterCount:ready.chapterCount,
   sampleFrames:samples,distinctSampleFrames:distinctHashes.size
  };
  console.log("[render metrics]",JSON.stringify(metrics,null,2));
  onProgress(100,"完成","MP4 已生成；共 "+frameCount+" 帧；耗时 "+metrics.totalSeconds+" 秒",metrics);
 }catch(error){
  if(encoder){try{await encoder.abort(error);}catch(_){}encoder=null;}
  throw error;
 }finally{
  if(context)await context.close().catch(()=>{});
  if(browser)await browser.close().catch(()=>{});
 }
}
module.exports={renderVideo};
