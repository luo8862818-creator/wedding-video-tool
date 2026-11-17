const path=require("node:path");
const express=require("express");
const http=require("node:http");
const {chromium}=require("playwright");

async function analyzePage({sourcePath,onProgress=()=>{},maxSeconds=300,tailSeconds=2.5}){
 let browser=null,context=null,server=null;
 const started=Date.now();
 try{
  onProgress(2,"启动分析浏览器","准备模拟网页播放");
  browser=await chromium.launch({headless:true,args:["--disable-background-timer-throttling","--disable-renderer-backgrounding","--disable-backgrounding-occluded-windows"]});
  context=await browser.newContext({viewport:{width:450,height:800},deviceScaleFactor:1,colorScheme:"light",reducedMotion:"no-preference"});
  const page=await context.newPage();
  await page.clock.install({time:new Date("2025-01-01T00:00:00.000Z")});
  const app=express();app.use(express.static(path.dirname(sourcePath),{dotfiles:"allow",fallthrough:false}));
  server=http.createServer(app);
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const address=server.address();
  const url="http://127.0.0.1:"+address.port+"/"+encodeURIComponent(path.basename(sourcePath));
  onProgress(5,"加载网页","等待 HTML、字体和图片加载");
  await page.goto(url,{waitUntil:"load",timeout:60000});
  const info=await page.evaluate(async()=>{
   if(document.fonts?.ready)await document.fonts.ready;
   await Promise.all([...document.images].map(image=>image.decode().catch(()=>{})));
   const p=window.weddingPlayer,root=document.scrollingElement||document.documentElement;
   return {timeline:Boolean(p&&typeof p.renderAt==="function"&&Number(p.totalMs)>0),totalMs:Number(p?.totalMs)||0,scrollHeight:root.scrollHeight,viewportHeight:innerHeight,maxScroll:Math.max(0,root.scrollHeight-innerHeight),scriptErrors:p?.errors||[]};
  });
  if(info.scriptErrors.length)throw new Error("网页脚本报告错误："+info.scriptErrors.join("；"));
  if(info.timeline){
   const seconds=info.totalMs/1000;
   return {mode:"timeline",playbackSeconds:Number(seconds.toFixed(2)),tailSeconds:0,videoSeconds:Number(seconds.toFixed(2)),details:"读取 weddingPlayer.totalMs 时间轴时长",analysisMs:Date.now()-started};
  }
  // 统一计入网页启动延迟；所有网页定时器、CSS 动画和 rAF 均由虚拟时钟驱动。
  await page.clock.runFor(100);
  let elapsedMs=100,lastY=null,startedMoving=false,bottomStableMs=0,maxSeenY=0,lastMovementAt=0;
  const tickMs=100,tailMs=Math.round(tailSeconds*1000);
  while(elapsedMs<maxSeconds*1000){
   await page.clock.runFor(tickMs);elapsedMs+=tickMs;
   const state=await page.evaluate(()=>{
    const root=document.scrollingElement||document.documentElement;
    return {y:window.scrollY,maxScroll:Math.max(0,root.scrollHeight-innerHeight),height:root.scrollHeight,ready:document.readyState};
   });
   if(lastY===null)lastY=state.y;
   const delta=Math.abs(state.y-lastY);
   if(delta>=1){startedMoving=true;lastMovementAt=elapsedMs;bottomStableMs=0;}
   else if(startedMoving&&state.y>=state.maxScroll-2)bottomStableMs+=tickMs;
   if(state.y>maxSeenY)maxSeenY=state.y;
   lastY=state.y;
   if(startedMoving&&state.maxScroll>0&&state.y>=state.maxScroll-2&&bottomStableMs>=tailMs){
    const playbackSeconds=elapsedMs/1000;
    return {mode:"auto-scroll",playbackSeconds:Number(playbackSeconds.toFixed(2)),tailSeconds:Number((bottomStableMs/1000).toFixed(2)),videoSeconds:Number(playbackSeconds.toFixed(2)),details:"检测到页面自动滚动到底部，并保持稳定 "+(bottomStableMs/1000).toFixed(1)+" 秒",maxScroll:state.maxScroll,analysisMs:Date.now()-started};
   }
   if(elapsedMs%1000===0)onProgress(Math.min(90,5+elapsedMs/(maxSeconds*1000)*85),"模拟网页播放","已分析 "+(elapsedMs/1000).toFixed(1)+" 秒；滚动位置 "+Math.round(state.y)+"/"+Math.round(state.maxScroll));
  }
  const finalState=await page.evaluate(()=>{const root=document.scrollingElement||document.documentElement;return {y:window.scrollY,maxScroll:Math.max(0,root.scrollHeight-innerHeight),height:root.scrollHeight};});
  if(!startedMoving)throw new Error("没有检测到自动滚动或可读取的时间轴。该网页可能需要点击开始，或使用 CSS transform/自定义动画。请切换手动时长，或为网页提供明确的播放结束标志。");
  throw new Error("已检测到网页滚动，但在 "+maxSeconds+" 秒内没有到达底部。当前位置 "+Math.round(finalState.y)+"/"+Math.round(finalState.maxScroll)+"。请检查网页是否循环播放，或改用手动时长。");
 }finally{
  if(context)await context.close().catch(()=>{});
  if(browser)await browser.close().catch(()=>{});
  if(server)await new Promise(resolve=>server.close(()=>resolve())).catch(()=>{});
 }
}
module.exports={analyzePage};
