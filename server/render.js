const crypto=require("node:crypto");
const path=require("node:path");
const express=require("express");
const http=require("node:http");
const {chromium}=require("playwright");
const {startVideoEncoder}=require("./ffmpeg");

function jpegSize(buffer){
 let i=2;
 while(i<buffer.length){
  if(buffer[i++]!==0xff)continue;
  let marker=buffer[i++];while(marker===0xff)marker=buffer[i++];
  if(marker===0xd8||marker===0xd9||marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
  if(i+7>buffer.length)return null;
  const length=buffer.readUInt16BE(i);
  if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))return {width:buffer.readUInt16BE(i+5),height:buffer.readUInt16BE(i+3)};
  if(length<2)return null;i+=length;
 }
 return null;
}
async function renderTimelineFrame(page,timeMs){
 return page.evaluate(async ms=>{
  const p=window.weddingPlayer,result=p.renderAt(ms);
  if(typeof p.renderCapture==="function")await p.renderCapture();
  await new Promise(resolve=>requestAnimationFrame(resolve));
  return {mode:"timeline",state:result?.state||"",y:result?.y??window.scrollY,scrollY:window.scrollY};
 },timeMs);
}
async function renderVideo(options){
 const {sourcePath,musicPath,outputPath,duration,playbackRate=1,fps,width,height,onProgress}=options;
 const frameCount=Math.ceil(duration*fps),logicalWidth=450,logicalHeight=logicalWidth*height/width,deviceScaleFactor=width/logicalWidth;
 let browser=null,context=null,encoder=null,sourceServer=null;
 const startedAt=Date.now(),samples={};let timelineMsTotal=0,screenshotMs=0,encoderWaitMs=0;
 try{
  onProgress(1,"启动浏览器","创建真实网页播放环境");
  browser=await chromium.launch({headless:true,args:["--disable-background-timer-throttling","--disable-renderer-backgrounding","--disable-backgrounding-occluded-windows","--disable-features=CalculateNativeWinOcclusion"]});
  context=await browser.newContext({viewport:{width:logicalWidth,height:logicalHeight},deviceScaleFactor,colorScheme:"light",reducedMotion:"no-preference"});
  const page=await context.newPage();
  // 虚拟时钟必须在导航前安装，才能接管页面脚本中的 Date、定时器、requestAnimationFrame 与 performance。
  await page.clock.install({time:new Date("2025-01-01T00:00:00.000Z")});
  page.on("pageerror",e=>console.error("[邀请函脚本错误]",e.message));
  page.on("console",m=>{if(m.type()==="error")console.error("[邀请函控制台]",m.text());});
  const sourceApp=express();sourceApp.use(express.static(path.dirname(sourcePath),{dotfiles:"allow",fallthrough:false}));
  sourceServer=http.createServer(sourceApp);
  await new Promise((resolve,reject)=>{sourceServer.once("error",reject);sourceServer.listen(0,"127.0.0.1",resolve);});
  const addr=sourceServer.address(),sourceUrl="http://127.0.0.1:"+addr.port+"/"+encodeURIComponent(path.basename(sourcePath));
  onProgress(3,"加载邀请函","通过本地 HTTP 加载完整网页资源");
  await page.goto(sourceUrl,{waitUntil:"load",timeout:60000});
  const ready=await page.evaluate(async()=>{
   if(document.fonts?.ready)await document.fonts.ready;
   await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));
   const p=window.weddingPlayer,root=document.scrollingElement||document.documentElement;
   return {hasTimeline:Boolean(p&&typeof p.renderAt==="function"),totalMs:Number(p?.totalMs)||0,errors:p?.errors||[],scripts:[...document.scripts].map(s=>s.src),pageHeight:root.scrollHeight,viewportHeight:innerHeight,chapterCount:document.querySelectorAll(".chapter").length};
  });
  if(ready.errors.length)throw new Error("邀请函资源加载失败："+ready.errors.join("；"));
  const mode=ready.hasTimeline&&ready.totalMs>0?"timeline":"live";
  if(mode==="timeline"){
   await page.evaluate(()=>{const p=window.weddingPlayer;p.paused=true;if(p.raf)cancelAnimationFrame(p.raf);p.raf=null;p.last=null;p.chapters?.forEach(s=>{s.seen=false;if(s.header){s.header.style.opacity="";s.header.style.transform="";}});});
   await renderTimelineFrame(page,0);
  }else{
   // 页面启动延时也走虚拟时间：例如模板的 setTimeout(start, 2000)。
   // 不使用真实等待，避免截图慢时网页动画先于视频帧播放完毕。
   await page.clock.runFor(2000*playbackRate);
  }
  onProgress(5,"开始逐帧渲染",mode==="timeline"?"使用时间轴接口并推进虚拟时钟":"使用虚拟时钟逐帧驱动网页自己的滚动、CSS 动画和 requestAnimationFrame");
  encoder=startVideoEncoder({outputPath,fps,duration,musicPath,expectedFrames:frameCount});
  const frameInterval=1000/fps;
  for(let frame=0;frame<frameCount;frame++){
   const controlStart=Date.now();
   let state;
   if(mode==="timeline")state=await renderTimelineFrame(page,Math.min(ready.totalMs-1,frame/fps/duration*ready.totalMs));
   else state=await page.evaluate(()=>({
    mode:"live",state:document.body.dataset.playbackState||"LIVE",
    y:window.scrollY,scrollY:window.scrollY,
    pageHeight:(document.scrollingElement||document.documentElement).scrollHeight,
    mainTransform:getComputedStyle(document.querySelector("main")||document.body).transform
   }));
   timelineMsTotal+=Date.now()-controlStart;
   const shotStart=Date.now();
   const image=await page.screenshot({type:"jpeg",quality:92,animations:"allow",caret:"hide",scale:"device"});
   screenshotMs+=Date.now()-shotStart;
   if([0,Math.floor(frameCount*.25),Math.floor(frameCount*.5),Math.floor(frameCount*.75),frameCount-1].includes(frame)){
    samples[frame]={hash:crypto.createHash("sha256").update(image).digest("hex"),state:state.state,y:state.y,scrollY:state.scrollY,mode};
   }
   if(frame===0){const actual=jpegSize(image);if(!actual||actual.width!==width||actual.height!==height)throw new Error("截图尺寸错误："+JSON.stringify(actual)+"，预期 "+width+"×"+height);}
   const waitStart=Date.now();await encoder.writeFrame(image);encoderWaitMs+=Date.now()-waitStart;
   // 每输出一帧只推进 1/FPS 的页面时间。截图/编码耗时不会推进网页动画时间，
   // 因此即使机器实际只能处理 14 FPS，输出视频仍保持正确的 30 FPS 时间轴。
   if(frame<frameCount-1)await page.clock.runFor(frameInterval*playbackRate);
   if(frame%Math.max(1,Math.floor(fps/2))===0||frame===frameCount-1){
    const written=frame+1,elapsed=(Date.now()-startedAt)/1000;
    onProgress(5+written/frameCount*90,"实时录制与编码","第 "+written+" / "+frameCount+" 帧 · "+(written/Math.max(elapsed,.001)).toFixed(1)+" 帧/秒");
   }
  }
  const values=Object.values(samples),distinctHashes=new Set(values.map(s=>s.hash));
  if(distinctHashes.size<3)throw new Error("动态画面校验失败：录制期间关键帧几乎没有变化。请检查网页自身是否自动播放，以及页面是否需要点击后才能开始。关键帧："+JSON.stringify(samples));
  onProgress(96,"封装视频","正在完成 MP4 编码");
  const encoded=await encoder.finish();encoder=null;
  if(encoded.frames!==frameCount)throw new Error("MP4 帧数不一致：渲染 "+frameCount+" 帧，编码 "+encoded.frames+" 帧。");
  const elapsedMs=Date.now()-startedAt,metrics={mode,playbackRate,clockMode:"playwright-virtual-time",virtualDurationSeconds:Number((frameCount/fps).toFixed(3)),frames:frameCount,workerCount:1,outputWidth:width,outputHeight:height,cssViewportWidth:logicalWidth,cssViewportHeight:logicalHeight,deviceScaleFactor,timelineMs:ready.totalMs||null,timelineMsTotal,screenshotMs,encoderWaitMs,totalSeconds:Number((elapsedMs/1000).toFixed(2)),avgFps:Number((frameCount/(elapsedMs/1000||1)).toFixed(2)),pageHeight:ready.pageHeight,chapterCount:ready.chapterCount,sampleFrames:samples,distinctSampleFrames:distinctHashes.size};
  console.log("[render metrics]",JSON.stringify(metrics,null,2));
  onProgress(100,"完成","MP4 已生成；录制模式："+mode+"；耗时 "+metrics.totalSeconds+" 秒",metrics);
 }catch(error){if(encoder){try{await encoder.abort(error);}catch(_){}encoder=null;}throw error;}
 finally{if(context)await context.close().catch(()=>{});if(browser)await browser.close().catch(()=>{});if(sourceServer)await new Promise(resolve=>sourceServer.close(()=>resolve())).catch(()=>{});}
}
module.exports={renderVideo};
