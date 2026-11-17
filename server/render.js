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

async function renderTimelineFrame(page,timeMs){
 return page.evaluate(async ms=>{
  const p=window.weddingPlayer;
  const result=p.renderAt(ms);
  if(typeof p.renderCapture==="function")await p.renderCapture();
  await new Promise(resolve=>requestAnimationFrame(resolve));
  return {mode:"timeline",state:result?.state||"",y:result?.y??window.scrollY,scrollY:window.scrollY};
 },timeMs);
}

async function renderGenericFrame(page,ratio){
 return page.evaluate(async progress=>{
  const root=document.scrollingElement||document.documentElement;
  const candidates=[...document.querySelectorAll("body,body *")].filter(el=>{
   const style=getComputedStyle(el);
   return /(auto|scroll)/.test(style.overflowY)&&el.scrollHeight>el.clientHeight+20&&el.clientHeight>80;
  });
  candidates.sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight));
  const target=candidates[0]||root;
  const max=Math.max(0,target.scrollHeight-target.clientHeight);
  const y=max*progress;
  target.scrollTop=y;
  if(target===root||target===document.body)window.scrollTo(0,y);
  await new Promise(resolve=>requestAnimationFrame(resolve));
  return {mode:"generic-scroll",state:"SCROLL",y:target.scrollTop,scrollY:window.scrollY,target:target.id||target.tagName,maxScroll:max,targetTag:target.tagName};
 },ratio);
}

async function renderVideo(options){
 const {sourcePath,musicPath,outputPath,duration,fps,width,height,onProgress}=options;
 const frameCount=Math.ceil(duration*fps);
 const logicalWidth=450,logicalHeight=logicalWidth*height/width,deviceScaleFactor=width/logicalWidth;
 let browser=null,context=null,encoder=null,sourceServer=null;
 const startedAt=Date.now(),samples={};
 let timelineMsTotal=0,screenshotMs=0,encoderWaitMs=0;
 try{
  onProgress(1,"启动浏览器","创建浏览器渲染页面");
  browser=await chromium.launch({headless:true,args:["--disable-background-timer-throttling","--disable-renderer-backgrounding","--disable-backgrounding-occluded-windows","--disable-features=CalculateNativeWinOcclusion"]});
  context=await browser.newContext({viewport:{width:logicalWidth,height:logicalHeight},deviceScaleFactor,colorScheme:"light",reducedMotion:"no-preference"});
  const page=await context.newPage();
  page.on("pageerror",error=>console.error("[邀请函脚本错误]",error.message));
  page.on("console",message=>{if(message.type()==="error")console.error("[邀请函控制台]",message.text());});
  await page.addInitScript(()=>{window.__OFFLINE_CAPTURE=true;});
  const sourceApp=express();
  sourceApp.use(express.static(path.dirname(sourcePath),{dotfiles:"allow",fallthrough:false}));
  sourceServer=http.createServer(sourceApp);
  await new Promise((resolve,reject)=>{sourceServer.once("error",reject);sourceServer.listen(0,"127.0.0.1",resolve);});
  const addr=sourceServer.address();
  const sourceUrl="http://127.0.0.1:"+addr.port+"/"+encodeURIComponent(path.basename(sourcePath));
  onProgress(3,"加载邀请函","通过本地 HTTP 加载 HTML、CSS、JS、字体和图片资源");
  await page.goto(sourceUrl,{waitUntil:"load",timeout:60000});
  const ready=await page.evaluate(async()=>{
   if(document.fonts?.ready)await document.fonts.ready;
   await Promise.all([...document.images].map(img=>img.decode().catch(()=>{})));
   const p=window.weddingPlayer;
   const root=document.scrollingElement||document.documentElement;
   const scrollables=[...document.querySelectorAll("body,body *")].filter(el=>{
    const s=getComputedStyle(el);return /(auto|scroll)/.test(s.overflowY)&&el.scrollHeight>el.clientHeight+20&&el.clientHeight>80;
   }).sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight));
   const target=scrollables[0]||root;
   return {
    hasTimeline:Boolean(p&&typeof p.renderAt==="function"),
    totalMs:Number(p?.totalMs)||0,
    errors:p?.errors||[],
    scripts:[...document.scripts].map(s=>s.src),
    pageHeight:root.scrollHeight,
    viewportHeight:innerHeight,
    scrollHeight:target.scrollHeight,
    scrollClientHeight:target.clientHeight,
    scrollTarget:Math.max(0,target.scrollHeight-target.clientHeight),
    scrollTargetTag:target.id||target.tagName,
    chapterCount:document.querySelectorAll("main>.chapter,section").length
   };
  });
  if(ready.errors.length)throw new Error("邀请函页面报告资源错误："+ready.errors.join("；"));
  const mode=ready.hasTimeline&&ready.totalMs>0?"timeline":"generic-scroll";
  if(mode==="generic-scroll"&&ready.scrollTarget<10){
   throw new Error("该网页没有时间轴接口，也没有可识别的纵向滚动容器。脚本："+JSON.stringify(ready.scripts)+"；页面高度："+ready.pageHeight+"；滚动容器："+ready.scrollTargetTag+"；可滚动距离："+ready.scrollTarget+"。");
  }
  if(mode==="timeline"){
   await page.evaluate(()=>{const p=window.weddingPlayer;p.chapters?.forEach(s=>{s.seen=false;if(s.header){s.header.style.opacity="";s.header.style.transform="";}});});
  }
  onProgress(5,"准备逐帧渲染",mode==="timeline"?"检测到网页时间轴接口，使用时间轴逐帧控制":"未检测到专用时间轴，已启用通用网页滚动捕获（不修改原网页）");
  encoder=startVideoEncoder({outputPath,fps,duration,musicPath,expectedFrames:frameCount});
  for(let frame=0;frame<frameCount;frame++){
   const ratio=frameCount<=1?0:frame/(frameCount-1);
   const controlStart=Date.now();
   const state=mode==="timeline"
    ?await renderTimelineFrame(page,ratio*ready.totalMs)
    :await renderGenericFrame(page,ratio);
   timelineMsTotal+=Date.now()-controlStart;
   const shotStart=Date.now();
   const image=await page.screenshot({type:"jpeg",quality:92,animations:"allow",caret:"hide",scale:"device"});
   screenshotMs+=Date.now()-shotStart;
   if(frame===0||frame===Math.floor(frameCount*.25)||frame===Math.floor(frameCount*.5)||frame===Math.floor(frameCount*.75)||frame===frameCount-1){
    samples[frame]={hash:crypto.createHash("sha256").update(image).digest("hex"),state:state.state,y:state.y,scrollY:state.scrollY,mode:state.mode||mode};
   }
   if(frame===0){
    const actual=jpegSize(image);
    if(!actual||actual.width!==width||actual.height!==height)throw new Error("截图尺寸错误：实际 "+JSON.stringify(actual)+"，预期 "+width+"×"+height+"。");
   }
   const waitStart=Date.now();await encoder.writeFrame(image);encoderWaitMs+=Date.now()-waitStart;
   if(frame%Math.max(1,Math.floor(fps/2))===0||frame===frameCount-1){
    const written=frame+1,elapsed=(Date.now()-startedAt)/1000;
    onProgress(5+written/frameCount*90,"逐帧渲染与编码","第 "+written+" / "+frameCount+" 帧 · "+(written/Math.max(elapsed,.001)).toFixed(1)+" 帧/秒");
   }
  }
  const sampleValues=Object.values(samples);
  const distinctHashes=new Set(sampleValues.map(s=>s.hash));
  const distinctPositions=new Set(sampleValues.map(s=>Math.round(s.y)));
  if(distinctHashes.size<3||distinctPositions.size<3){
   throw new Error("动态画面校验失败：关键帧变化不足。截图差异数 "+distinctHashes.size+"，滚动位置数 "+distinctPositions.size+"。检测结果："+JSON.stringify(samples));
  }
  onProgress(96,"封装视频","正在等待 FFmpeg 完成 MP4 编码");
  const encoded=await encoder.finish();encoder=null;
  if(encoded.frames!==frameCount)throw new Error("MP4 帧数不一致：渲染 "+frameCount+" 帧，编码 "+encoded.frames+" 帧。");
  const elapsedMs=Date.now()-startedAt;
  const metrics={mode,frames:frameCount,workerCount:1,outputWidth:width,outputHeight:height,cssViewportWidth:logicalWidth,cssViewportHeight:logicalHeight,deviceScaleFactor,timelineMs:ready.totalMs||null,timelineMsTotal,screenshotMs,encoderWaitMs,totalSeconds:Number((elapsedMs/1000).toFixed(2)),avgFps:Number((frameCount/(elapsedMs/1000||1)).toFixed(2)),pageHeight:ready.pageHeight,scrollTarget:ready.scrollTarget,scrollTargetTag:ready.scrollTargetTag,chapterCount:ready.chapterCount,sampleFrames:samples,distinctSampleFrames:distinctHashes.size};
  console.log("[render metrics]",JSON.stringify(metrics,null,2));
  onProgress(100,"完成","MP4 已生成；渲染模式："+mode+"；耗时 "+metrics.totalSeconds+" 秒",metrics);
 }catch(error){
  if(encoder){try{await encoder.abort(error);}catch(_){}encoder=null;}
  throw error;
 }finally{
  if(context)await context.close().catch(()=>{});
  if(browser)await browser.close().catch(()=>{});
  if(sourceServer)await new Promise(resolve=>sourceServer.close(()=>resolve())).catch(()=>{});
 }
}
module.exports={renderVideo};
