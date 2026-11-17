const fs=require("node:fs"),path=require("node:path");
const {pathToFileURL}=require("node:url");
const {chromium}=require("playwright");
const {startVideoEncoder}=require("./ffmpeg");

async function renderVideo(options){
 const {sourcePath,musicPath,outputPath,duration,fps,width,height,onProgress}=options;
 const frameCount=Math.max(1,Math.ceil(duration*fps));
 let browser=null,encoder=null;
 const startedAt=Date.now();
 let screenshotMs=0,timelineMsTotal=0;
 try{
  onProgress(1,"启动浏览器","正在启动 Chromium");
  browser=await chromium.launch({headless:true,args:["--disable-background-timer-throttling","--disable-renderer-backgrounding"]});
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
  page.on("pageerror",error=>console.warn("[页面脚本错误]",error.message));
  page.on("console",message=>{if(message.type()==="error")console.warn("[页面控制台]",message.text());});
  await page.addInitScript(()=>{window.__OFFLINE_CAPTURE=true;});
  onProgress(3,"加载邀请函","正在打开本地 HTML 文件");
  await page.goto(pathToFileURL(sourcePath).href,{waitUntil:"load",timeout:60000});
  await page.evaluate(async()=>{
   if(document.fonts?.ready)await document.fonts.ready;
   await Promise.all([...document.images].map(image=>image.decode().catch(()=>{})));
   if(window.weddingPlayer?.ready)await window.weddingPlayer.ready;
  });
  const timeline=await page.evaluate(()=>({
   supported:Boolean(window.weddingPlayer&&typeof window.weddingPlayer.renderAt==="function"),
   totalMs:window.weddingPlayer?.totalMs||0,
   pageHeight:Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0)
  }));
  if(timeline.supported&&(!timeline.totalMs||timeline.totalMs<=0))throw new Error("请柬时间轴没有提供有效总时长。");
  const maxScroll=Math.max(0,timeline.pageHeight-height);
  encoder=startVideoEncoder({outputPath,fps,duration,musicPath});
  onProgress(5,"实时渲染与编码","共需处理 "+frameCount+" 帧；使用 JPEG 管道，不再落盘保存 PNG");
  for(let frame=0;frame<frameCount;frame++){
   const ratio=frameCount<=1?0:frame/(frameCount-1);
   const controlStarted=Date.now();
   if(timeline.supported){
    const time=ratio*timeline.totalMs;
    await page.evaluate(async ms=>{
     window.weddingPlayer.renderAt(ms);
     if(window.weddingPlayer.renderCapture)await window.weddingPlayer.renderCapture();
    },time);
   }else{
    const eased=ratio*ratio*(3-2*ratio);
    await page.evaluate(y=>window.scrollTo(0,y),Math.round(maxScroll*eased));
   }
   timelineMsTotal+=Date.now()-controlStarted;
   const shotStarted=Date.now();
   const image=await page.screenshot({type:"jpeg",quality:90,animations:"allow",caret:"hide"});
   screenshotMs+=Date.now()-shotStarted;
   await encoder.writeFrame(image);
   if(frame%Math.max(1,Math.floor(fps/2))===0||frame===frameCount-1){
    const percent=5+(frame+1)/frameCount*90;
    const elapsed=(Date.now()-startedAt)/1000;
    const rate=(frame+1)/Math.max(elapsed,0.001);
    onProgress(percent,"实时渲染与编码","第 "+(frame+1)+" / "+frameCount+" 帧 · "+rate.toFixed(1)+" 帧/秒");
   }
  }
  onProgress(96,"完成视频编码","正在写入 MP4 尾部信息");
  await encoder.finish();encoder=null;
  onProgress(100,"完成","MP4 已生成；总耗时 "+Math.round((Date.now()-startedAt)/1000)+" 秒");
  console.log("[render metrics]",{
   frames:frameCount,
   totalSeconds:((Date.now()-startedAt)/1000).toFixed(1),
   avgFps:(frameCount/((Date.now()-startedAt)/1000)).toFixed(2),
   timelineControlMs:timelineMsTotal,
   screenshotMs,
   outputPath
  });
 }catch(error){
  if(encoder){try{await encoder.abort(error);}catch(_){}encoder=null;}
  throw error;
 }finally{
  if(browser)await browser.close().catch(()=>{});
 }
}
module.exports={renderVideo};
