const fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const {pathToFileURL}=require("node:url");
const {chromium}=require("playwright");
const {createVideo}=require("./ffmpeg");
async function renderVideo(options){
 const {sourcePath,musicPath,outputPath,duration,fps,width,height,onProgress}=options;
 const frameCount=Math.max(1,Math.ceil(duration*fps)),workDir=path.join(os.tmpdir(),"wedding-video-"+Date.now()+"-"+process.pid);fs.mkdirSync(workDir,{recursive:true});let browser;
 try{
  onProgress(1,"启动浏览器","正在启动 Chromium");browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
  page.on("pageerror",error=>console.warn("[页面脚本错误]",error.message));
  page.on("console",message=>{if(message.type()==="error")console.warn("[页面控制台]",message.text());});
  // 请柬项目支持确定性时间轴时，关闭页面自己的实时 RAF，由导出器逐帧驱动。
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
   pageHeight:Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0),
   viewportHeight:innerHeight
  }));
  if(timeline.supported&&(!timeline.totalMs||timeline.totalMs<=0))throw new Error("请柬时间轴没有提供有效总时长。");
  const maxScroll=Math.max(0,timeline.pageHeight-height);
  onProgress(5,"渲染画面","共需生成 "+frameCount+" 帧，预计视频 "+duration.toFixed(1)+" 秒"+(timeline.supported?"，已接入请柬原生分镜时间轴":""));
  for(let frame=0;frame<frameCount;frame++){
   const ratio=frameCount<=1?0:frame/(frameCount-1);
   if(timeline.supported){
    const timelineMs=ratio*timeline.totalMs;
    await page.evaluate(async ms=>{window.weddingPlayer.renderAt(ms);if(window.weddingPlayer.renderCapture)await window.weddingPlayer.renderCapture();},timelineMs);
   }else{
    const eased=ratio*ratio*(3-2*ratio),scrollY=Math.round(maxScroll*eased);
    await page.evaluate(y=>window.scrollTo(0,y),scrollY);
   }
   await page.screenshot({path:path.join(workDir,"frame-"+String(frame).padStart(6,"0")+".png"),type:"png",animations:"allow",caret:"hide"});
   if(frame%Math.max(1,Math.floor(fps/2))===0||frame===frameCount-1)onProgress(5+(frame+1)/frameCount*80,"渲染画面","正在生成第 "+(frame+1)+" / "+frameCount+" 帧");
  }
  await browser.close();browser=null;onProgress(88,"合成 MP4","正在使用 FFmpeg 编码视频和音频");
  await createVideo({framesDir:workDir,outputPath,fps,duration,musicPath,onProgress:percent=>onProgress(88+percent*.11,"合成 MP4","视频编码进度 "+Math.round(percent)+"%")});
  onProgress(100,"完成","MP4 文件已保存");
 }finally{if(browser)await browser.close().catch(()=>{});fs.rmSync(workDir,{recursive:true,force:true});}
}
module.exports={renderVideo};
