const fs=require("node:fs");
const path=require("node:path");
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
  const length=buffer.readUInt16BE(i);
  if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
   return {width:buffer.readUInt16BE(i+5),height:buffer.readUInt16BE(i+3)};
  }
  i+=length;
 }
 return null;
}

async function createRenderPage(context,sourceUrl,index){
 const page=await context.newPage();
 page.on("pageerror",error=>console.warn("[页面脚本错误]",error.message));
 page.on("console",message=>{if(message.type()==="error")console.warn("[页面控制台]",message.text());});
 await page.addInitScript(()=>{window.__OFFLINE_CAPTURE=true;});
 await page.goto(sourceUrl,{waitUntil:"load",timeout:60000});
 const ready=await page.evaluate(async()=>{
  if(document.fonts?.ready)await document.fonts.ready;
  await Promise.all([...document.images].map(image=>image.decode().catch(()=>{})));
  if(window.weddingPlayer?.ready)await window.weddingPlayer.ready;
  const p=window.weddingPlayer;
  return {
   supported:Boolean(p&&typeof p.renderAt==="function"),
   totalMs:p?.totalMs||0,
   errors:p?.errors||[],
   metrics:p?.metrics||null,
   chapterCount:document.querySelectorAll("main>.chapter").length,
   pageHeight:Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0),
   viewportHeight:innerHeight,
   viewportWidth:innerWidth,
   scrollTarget:Math.max(0,document.documentElement.scrollHeight-innerHeight)
  };
 });
 if(!ready.supported)throw new Error("所选 HTML 没有提供 weddingPlayer.renderAt() 时间轴接口，无法保证完整录制分镜动画。");
 if(ready.errors.length)throw new Error("邀请函素材加载异常："+ready.errors.join("；"));
 if(!ready.totalMs||ready.totalMs<=0)throw new Error("邀请函时间轴总时长无效。");
 if(ready.chapterCount<2||ready.scrollTarget<10)throw new Error("邀请函页面没有可滚动内容：检测到 "+ready.chapterCount+" 个章节，滚动距离 "+ready.scrollTarget+"px。为避免导出静态单画面，任务已停止。");
 return {page,ready,index};
}

async function renderVideo(options){
 const {sourcePath,musicPath,outputPath,duration,fps,width,height,onProgress}=options;
 const frameCount=Math.max(1,Math.ceil(duration*fps));
 const logicalWidth=450;
 const logicalHeight=logicalWidth*height/width;
 const deviceScaleFactor=width/logicalWidth;
 const workerCount=Math.max(1,Math.min(4,Number(process.env.WEDDING_RENDER_WORKERS)||2));
 let browser=null,context=null,encoder=null;
 const startedAt=Date.now();
 let timelineMsTotal=0,screenshotMs=0,encoderWaitMs=0;
 const samples={};
 try{
  onProgress(1,"启动浏览器","准备 "+workerCount+" 个独立渲染页面");
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
  const sourceUrl=pathToFileURL(sourcePath).href;
  onProgress(3,"加载邀请函","使用 "+logicalWidth+"×"+logicalHeight+" CSS 视口，输出 "+width+"×"+height);
  const workers=await Promise.all(Array.from({length:workerCount},(_,i)=>createRenderPage(context,sourceUrl,i)));
  const primary=workers[0].ready;
  for(const w of workers){
   if(w.ready.totalMs!==primary.totalMs)throw new Error("并行渲染页面的时间轴长度不一致，已停止导出。");
   if(w.ready.scrollTarget<=0)throw new Error("渲染页面没有检测到有效滚动距离。");
  }
  const motionAudit=[];
  for(const w of workers){
   const probe=await w.page.evaluate(()=>{
    const p=window.weddingPlayer;
    const start=p.renderAt(0);
    const middle=p.renderAt(p.totalMs*0.5);
    const end=p.renderAt(p.totalMs-1);
    return {
     start:{state:start.state,y:start.y,scrollY},
     middle:{state:middle.state,y:middle.y,scrollY},
     end:{state:end.state,y:end.y,scrollY},
     target:p.target,
     chapterCount:p.chapters?.length||0
    };
   });
   if(probe.target<=0||probe.middle.y<=probe.start.y+10||probe.end.y<=probe.middle.y){
    throw new Error("动态画面预检失败：邀请函滚动位置没有发生有效变化。检测结果："+JSON.stringify(probe));
   }
   motionAudit.push(probe);
   await w.page.evaluate(async()=>{
    const p=window.weddingPlayer;
    p.chapters?.forEach(section=>{section.seen=false;if(section.header){section.header.style.opacity="";section.header.style.transform="";}});
    p.renderAt(0);await p.renderCapture();
   });
  }
  const timelineMs=primary.totalMs;
  encoder=startVideoEncoder({outputPath,fps,duration,musicPath});
  onProgress(5,"并行渲染与编码","共 "+frameCount+" 帧；"+workerCount+" 个独立页面并行采集，按时间顺序编码");
  let written=0;
  const batchSize=workerCount;
  for(let base=0;base<frameCount;base+=batchSize){
   const indices=Array.from({length:Math.min(batchSize,frameCount-base)},(_,i)=>base+i);
   const batch=await Promise.all(indices.map(async(frame,slot)=>{
    const w=workers[slot];
    const time=(frame/fps)*(timelineMs/duration);
    const controlStart=Date.now();
    const state=await w.page.evaluate(async ms=>{
     const result=window.weddingPlayer.renderAt(ms);
     if(window.weddingPlayer.renderCapture)await window.weddingPlayer.renderCapture();
     return {state:result.state,y:result.y,scrollY};
    },time);
    timelineMsTotal+=Date.now()-controlStart;
    const shotStart=Date.now();
    const image=await w.page.screenshot({
     type:"jpeg",quality:90,animations:"allow",caret:"hide",scale:"device"
    });
    screenshotMs+=Date.now()-shotStart;
    if(frame===0||frame===Math.floor(frameCount/2)||frame===frameCount-1){
     samples[frame]={hash:crypto.createHash("sha256").update(image).digest("hex"),state:state.state,y:state.y,scrollY:state.scrollY};
    }
    if(frame===0){
     const dimensions=jpegSize(image);
     if(!dimensions||dimensions.width!==width||dimensions.height!==height){
      throw new Error("截图尺寸不正确，实际 "+JSON.stringify(dimensions)+"，期望 "+width+"×"+height+"。");
     }
    }
    return image;
   }));
   for(const image of batch){
    const waitStart=Date.now();
    await encoder.writeFrame(image);
    encoderWaitMs+=Date.now()-waitStart;
    written++;
   }
   if(written%Math.max(batchSize,Math.floor(fps/2))<batchSize||written===frameCount){
    const percent=5+written/frameCount*90;
    const elapsed=(Date.now()-startedAt)/1000;
    const rate=written/Math.max(elapsed,0.001);
    onProgress(percent,"并行渲染与编码","第 "+written+" / "+frameCount+" 帧 · "+rate.toFixed(1)+" 帧/秒");
   }
  }
  const hashes=Object.values(samples).map(x=>x.hash);
  if(hashes.length>=2&&hashes.every(x=>x===hashes[0]))throw new Error("画面检测失败：视频起始、中段和结尾截图完全相同，拒绝生成静态假视频。");
  if(samples[0]?.scrollY===samples[frameCount-1]?.scrollY&&frameCount>2)throw new Error("画面检测失败：起始帧和结束帧的滚动位置没有变化。");
  onProgress(96,"完成视频编码","正在封装 MP4");
  await encoder.finish();encoder=null;
  const elapsedMs=Date.now()-startedAt;
  const metrics={
   frames:frameCount,workerCount,
   outputWidth:width,outputHeight:height,
   cssViewportWidth:logicalWidth,cssViewportHeight:logicalHeight,deviceScaleFactor,
   timelineMsTotal,screenshotMs,encoderWaitMs,
   totalSeconds:Number((elapsedMs/1000).toFixed(2)),
   avgFps:Number((frameCount/(elapsedMs/1000||1)).toFixed(2)),
   pageHeight:primary.pageHeight,scrollTarget:primary.scrollTarget,
   chapterCount:primary.chapterCount,
   motionAudit,sampleFrames:samples
  };
  console.log("[render metrics]",metrics);
  onProgress(100,"完成","MP4 已生成；耗时 "+metrics.totalSeconds+" 秒；平均 "+metrics.avgFps+" 帧/秒",metrics);
 }catch(error){
  if(encoder){try{await encoder.abort(error);}catch(_){}encoder=null;}
  throw error;
 }finally{
  if(context)await context.close().catch(()=>{});
  if(browser)await browser.close().catch(()=>{});
 }
}
module.exports={renderVideo};
