const fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const {pathToFileURL}=require("node:url");
const {chromium}=require("playwright");
const {createVideo}=require("./ffmpeg");
async function renderVideo(options){
 const {sourcePath,musicPath,outputPath,duration,fps,width,height,onProgress}=options;
 const frameCount=Math.ceil(duration*fps),workDir=path.join(os.tmpdir(),"wedding-video-"+Date.now()+"-"+process.pid);fs.mkdirSync(workDir,{recursive:true});let browser;
 try{
  onProgress(1,"启动浏览器","正在启动 Chromium");browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
  page.on("pageerror",error=>console.warn("[页面脚本错误]",error.message));
  page.on("console",message=>{if(message.type()==="error")console.warn("[页面控制台]",message.text());});
  onProgress(3,"加载邀请函","正在打开本地 HTML 文件");
  await page.goto(pathToFileURL(sourcePath).href,{waitUntil:"load",timeout:60000});
  await page.evaluate(async()=>{if(document.fonts?.ready)await document.fonts.ready;await Promise.all([...document.images].map(image=>image.decode().catch(()=>{})));});
  await page.waitForTimeout(400);
  const pageHeight=await page.evaluate(()=>Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0));
  const maxScroll=Math.max(0,pageHeight-height);
  onProgress(5,"渲染画面","共需生成 "+frameCount+" 帧，预计视频 "+duration.toFixed(1)+" 秒");
  for(let frame=0;frame<frameCount;frame++){
   const ratio=frameCount<=1?0:frame/(frameCount-1);
   // smoothstep 缓动：起步和结束更平滑，中段保持稳定移动。
   const eased=ratio*ratio*(3-2*ratio),scrollY=Math.round(maxScroll*eased);
   await page.evaluate(y=>window.scrollTo(0,y),scrollY);
   await page.screenshot({path:path.join(workDir,"frame-"+String(frame).padStart(6,"0")+".png"),type:"png",animations:"allow",caret:"hide"});
   if(frame%Math.max(1,Math.floor(fps/2))===0||frame===frameCount-1)onProgress(5+(frame+1)/frameCount*80,"渲染画面","正在生成第 "+(frame+1)+" / "+frameCount+" 帧");
  }
  await browser.close();browser=null;onProgress(88,"合成 MP4","正在使用 FFmpeg 编码视频和音频");
  await createVideo({framesDir:workDir,outputPath,fps,duration,musicPath,onProgress:percent=>onProgress(88+percent*.11,"合成 MP4","视频编码进度 "+Math.round(percent)+"%")});
  onProgress(100,"完成","MP4 文件已保存");
 }finally{if(browser)await browser.close().catch(()=>{});fs.rmSync(workDir,{recursive:true,force:true});}
}
module.exports={renderVideo};
