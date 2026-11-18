const path=require('node:path');
const http=require('node:http');
const {performance}=require('node:perf_hooks');
const {createHash}=require('node:crypto');
const express=require('express');
const {chromium}=require('playwright');
const {transcodeFrameStream}=require('./ffmpeg');
const {installOfflinePage}=require('./offline-page');
const {FrameQueue}=require('./frame-queue');
const {ExportPerformance,diagnoseBottleneck}=require('./export-performance');
const {frameConfig,selectOfflineEncoder}=require('./encoder-profile');
const {ffmpegPath}=require('./ffmpeg');
const {validateFrameFormat}=require('./frame-format');

function abort(signal){if(signal?.aborted){const e=Error('导出任务已停止');e.name='AbortError';throw e;}}
const timeout=(promise,ms,label)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]).finally(()=>clearTimeout(timer));};

async function prepareDriver(page,{playerHint,durationMs,signal,logger}){
 const frames=page.frames();
 let playerFrame=null,playerKey=null,info=null;
 for(const frame of frames){
  const found=await frame.evaluate(()=>{
   const keys=['weddingPlayer','templatePlayer','invitationPlayer'];
   const key=keys.find(k=>window[k]&&typeof window[k].renderAt==='function'&&typeof window[k].renderCapture==='function')||keys.find(k=>window[k]);
   const p=key&&window[key];
   return {key,full:!!(p&&typeof p.renderAt==='function'&&typeof p.renderCapture==='function'&&p.ready),
    totalMs:Number(p?.totalMs)||Number(document.querySelector('meta[name="wedding-video-duration-ms"]')?.content)||0,
    url:location.origin+location.pathname};
  });
  if(found.full){playerFrame=frame;playerKey=found.key;info=found;break;}
  if(!info||found.totalMs)info=found;
 }
 if(playerHint&&!playerFrame)throw Error('页面声明确定性接口但未加载 renderAt/renderCapture/ready：'+JSON.stringify(info));
 if(playerFrame&&!playerHint)throw Error('运行时发现播放器接口，但页面未声明离线契约。请添加 meta wedding-video-capture=deterministic，避免播放器与虚拟时钟冲突。');
 if(playerFrame){
  await timeout(playerFrame.evaluate(async key=>{await window[key].ready;},playerKey),30000,'播放器 ready 超时，请检查素材或离线模式中的定时器依赖');
  info=await playerFrame.evaluate(key=>{const p=window[key];return {totalMs:p.totalMs,metrics:p.metrics||{},errors:p.errors||[]};},playerKey);
  if(info.errors.length)throw Error('播放器资源错误：'+info.errors.join('；'));
 }
 const totalMs=Number(durationMs??info?.totalMs);
 if(!Number.isFinite(totalMs)||totalMs<=0)throw Error('无法确定视频结束时间：页面需提供 player.totalMs、meta wedding-video-duration-ms，或明确的 durationMs。不会回退实时录屏。诊断：'+JSON.stringify(info));
 const media=[];
 const preparedFrames=page.frames(),frameUrls=new Map(preparedFrames.map(frame=>[frame,frame.url()]));
 for(const frame of preparedFrames){
  media.push({url:frame.url(),...await timeout(frame.evaluate(opts=>window.__offlinePage.prepare(opts),{clock:!playerFrame,playerOwned:frame===playerFrame}),30000,'字体、图片或动画准备超时：'+frame.url())});
 }
 logger.info('离线动画兼容性',{driver:playerFrame?'player-api':'playwright-clock',frames:media.map((m,index)=>({index,images:m.images,videos:m.videos,animatedImages:m.animatedImages.map(a=>({frames:a.frames,durationMs:a.durationMs}))})),totalMs});
 let lastTime=0,lastSignature=null;
 return {
  totalMs,info,playerKey,playerFrame,media,mode:playerFrame?'player-api':'playwright-clock',
  async render(time){
   abort(signal);let result;const timings={renderAtMs:null,renderCaptureMs:null,clockAdvanceMs:null,mediaSyncMs:null};
   if(playerFrame){
    const stageStarted=performance.now();
    result=await timeout(playerFrame.evaluate(async({key,time})=>{
     const p=window[key],now=window.__offlinePage.now;
     const renderStarted=now();const result=await p.renderAt(time);const renderAtMs=now()-renderStarted;
     const captureStarted=now();await p.renderCapture();const renderCaptureMs=now()-captureStarted;
     if(p.errors?.length)throw Error(p.errors.join('；'));
     return {state:result?.state??p.state??'',y:result?.y??p.cameraY??null,motionExpected:result?.motionExpected??null,hold:result?.hold??null,renderAtMs,renderCaptureMs};
    },{key:playerKey,time}),30000,'renderAt/renderCapture 超时：'+time+'ms');
    timings.playerRoundTripMs=performance.now()-stageStarted;
    timings.renderAtMs=result.renderAtMs;timings.renderCaptureMs=result.renderCaptureMs;
   }else{
    const target=Math.round(time);if(target<lastTime)throw Error('Clock 模式不支持倒退；重新加载页面后从 0 开始');
    const stageStarted=performance.now();await page.clock.runFor(target-lastTime);lastTime=target;timings.clockAdvanceMs=performance.now()-stageStarted;
   }
   const currentFrames=page.frames();
   if(currentFrames.length!==preparedFrames.length||currentFrames.some(frame=>!frameUrls.has(frame)||frameUrls.get(frame)!==frame.url()))throw Error('导出中发生 iframe 创建/导航；请在 ready 前完成框架加载，或提供稳定的逐帧页面');
   const states=[];
   const mediaStarted=performance.now();
   for(const frame of currentFrames)states.push(await timeout(frame.evaluate(time=>{
    if(!window.__offlinePage)throw Error('出现未初始化的新 iframe，请在导出前固定页面结构');
    return window.__offlinePage.render(time);
   },time),30000,'媒体目标帧解码超时：'+frame.url()));
   timings.mediaSyncMs=performance.now()-mediaStarted;
   const signature=JSON.stringify([result?.y,states]);
   const hold=result?.hold??['HOLD','FINISHED','ENDED'].includes(String(result?.state).toUpperCase());
   const motionExpected=result?.motionExpected??(!hold&&lastSignature!==null&&signature!==lastSignature);
   lastSignature=signature;
   return {motionExpected,hold,cameraY:result?.y??states[0]?.scrollY??null,playerState:result?.state||'',timings};
  },
  async dispose(){for(const frame of page.frames())await frame.evaluate(()=>window.__offlinePage?.dispose()).catch(()=>{});}
 };
}

async function* createOfflineFrames({page,driver,fps,totalFrames,stats,signal,onProgress,checkPage=()=>{},capture,perf}){
 const {createDeterministicFrameStream}=require('./render');
 let previousHash=null;
 try{yield* createDeterministicFrameStream({page,fps,frameCount:totalFrames,signal,capture,packets:true,renderFrame:async time=>{const state=await driver.render(time);checkPage();return state;},
  onProgress:(n,label,message,extra)=>onProgress(n,label,message,{...extra,totalFrames,captureMode:stats.captureMode}),
  onFrame:({buffer:data,state,elapsedMs:elapsed,diagnostic})=>{
   checkPage();
   const hash=createHash('sha256').update(data).digest('hex');
   Object.assign(diagnostic,perf.motion(state),{duplicate:hash===previousHash});
   if(hash===previousHash){
    stats.duplicateFrameCount++;
    stats.duplicateFrameCategories[state.motionExpected?'expectedMotion':state.hold?'intentionalHold':'staticOrUnknown']++;
   }
   previousHash=hash;
   stats.renderedFrames++;stats.renderTotalMs+=elapsed;stats.renderMaxMs=Math.max(stats.renderMaxMs,elapsed);
   stats.maxFrameBytes=Math.max(stats.maxFrameBytes,data.length);
  }
 });}catch(error){error.frameProducerError=true;throw error;}
}

async function renderOfflineAttempt(options){
 const {sourcePath,outputPath,musicPath,fps=30,width=1080,height=1920,signal,onProgress=()=>{}}=options;
 if(!Number.isInteger(fps)||fps<1||fps>120)throw Error('无效的离线输出 FPS');
 if(!Number.isInteger(width)||!Number.isInteger(height)||width%2||height%2||width<2||height<2)throw Error('H.264 输出尺寸必须是正偶数');
 const logger=options.logger||{info(){},warn(){},error(){}};
 const {findDeterministicCaptureScript}=require('./render');
 const playerHint=Boolean(findDeterministicCaptureScript(sourcePath));
 const capture=frameConfig({format:options.frameFormat,quality:options.frameQuality});
 capture.width=width;capture.height=height;
 const stats={captureMode:'offline-frame-rendering',totalFrames:0,renderedFrames:0,encodedFrames:0,droppedFrames:0,
  duplicateFrameCount:0,duplicateFrameRatio:0,duplicateFrameCategories:{intentionalHold:0,expectedMotion:0,staticOrUnknown:0},
  renderTotalMs:0,renderAverageMs:0,renderMaxMs:0,encodingTotalMs:0,outputFps:fps,outputWidth:width,outputHeight:height,maxFrameBytes:0,pageErrors:[]};
 let browser,server,driver,frameQueue,frameSource,perf,encoder,finalMetrics,resourceFailures=[];const started=performance.now();
 const closeOnAbort=()=>{browser?.close().catch(()=>{});};signal?.addEventListener('abort',closeOnAbort,{once:true});
 try{
  abort(signal);onProgress(1,'启动离线浏览器','按固定视频时间轴渲染，不使用实时录屏');
  const browserStarted=performance.now();
  browser=await chromium.launch({headless:true,...(process.env.WEDDING_BROWSER_CHANNEL?{channel:process.env.WEDDING_BROWSER_CHANNEL}:{}),args:['--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
  stats.browserStartupMs=performance.now()-browserStarted;
  logger.info('浏览器环境',{browserVersion:browser.version(),playwrightVersion:require('playwright/package.json').version,nodeVersion:process.version,platform:process.platform,viewport:{width,height},deviceScaleFactor:1});
  abort(signal);
  const context=await browser.newContext({viewport:{width,height},screen:{width,height},deviceScaleFactor:1,colorScheme:'light',reducedMotion:'no-preference',serviceWorkers:'block'});
  await context.addInitScript(flag=>{window.__OFFLINE_CAPTURE=flag;},playerHint);
  await context.addInitScript(installOfflinePage);
  const page=await context.newPage();
  page.on('pageerror',e=>{stats.pageErrors.push(e.message);logger.error('页面脚本错误',{message:e.message});});
  const isPageResource=url=>{try{return new URL(url).pathname!=='/favicon.ico';}catch(_){return true;}};
  page.on('requestfailed',r=>{if(isPageResource(r.url()))resourceFailures.push({url:r.url(),reason:r.failure()?.errorText});});
  page.on('response',r=>{if(r.status()>=400&&isPageResource(r.url()))resourceFailures.push({url:r.url(),status:r.status()});});
  if(!playerHint){
   // Pause before navigation. Install in the past so pauseAt never targets a
   // timestamp already passed during the install round trip. No page timers
   // exist yet; the public page starts at today's frozen wall-clock date.
   const epoch=new Date();
   await page.clock.install({time:new Date(epoch.getTime()-60000)});
   await page.clock.pauseAt(epoch);
  }
  const app=express();app.use(express.static(path.dirname(sourcePath),{dotfiles:'ignore'}));server=http.createServer(app);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const navigationStarted=performance.now();
  await page.goto(`http://127.0.0.1:${server.address().port}/${encodeURIComponent(path.basename(sourcePath))}`,{waitUntil:'load',timeout:60000});
  stats.navigationMs=performance.now()-navigationStarted;
  onProgress(4,'准备时间轴','检查播放器、字体、图片和动画控制能力');
  const preparationStarted=performance.now();driver=await prepareDriver(page,{playerHint,durationMs:options.durationMs,signal,logger});stats.pagePreparationMs=performance.now()-preparationStarted;
  if(stats.pageErrors.length||resourceFailures.length)throw Error('页面准备失败：'+JSON.stringify({pageErrors:stats.pageErrors,resourceFailures}));
  if(options.analyzeOnly)return {mode:'timeline',captureMode:'offline-'+driver.mode,playbackSeconds:driver.totalMs/1000,videoSeconds:driver.totalMs/1000,tailSeconds:0,animationCompatibility:driver.media,analysisMs:performance.now()-started,details:'离线时间轴与素材兼容性检查；未进行实时录制'};
  const totalFrames=Math.ceil(driver.totalMs*fps/1000);stats.totalFrames=totalFrames;stats.captureMode='offline-'+driver.mode;
  logger.info('Player API 信息',{driverMode:driver.mode,playerKey:driver.playerKey,interfaces:driver.playerKey?['renderAt','renderCapture','ready']:['Playwright Clock']});
  logger.info('时间轴参数',{totalMs:driver.totalMs,expectedFrames:totalFrames,fps,frameIntervalMs:1000/fps,attempt:options.__forceSoftware?2:1});
  const selectionStarted=performance.now();encoder=await selectOfflineEncoder(ffmpegPath,{width,height,fps,signal,logger,forceSoftware:options.__forceSoftware,requestedEncoder:options.encoder});stats.encoderSelectionMs=performance.now()-selectionStarted;
  // Verify that repeated rendering at the same timestamp does not advance native
  // GIFs, canvas state, or independently running scripts before feeding FFmpeg.
  const determinismStarted=performance.now(),session=await context.newCDPSession(page);let first,second;
  stats.preflightCaptureCount=0;stats.preflightCaptureMs=0;
  const take=async()=>{const start=performance.now();try{const shot=await session.send('Page.captureScreenshot',{format:capture.format,captureBeyondViewport:false,optimizeForSpeed:true,...(capture.quality===null?{}:{quality:capture.quality})});stats.preflightCaptureCount++;return shot;}finally{stats.preflightCaptureMs+=performance.now()-start;}};
  try{await driver.render(0);
   try{first=(await take()).data;validateFrameFormat(Buffer.from(first,'base64'),capture.format,capture);}catch(error){
    if(capture.format==='png'||!/format|unsupported|Invalid parameters|格式不匹配/i.test(error.message))throw error;
    logger.warn('截图格式不受浏览器支持，回退无损 PNG',{requestedFormat:capture.format});
    capture.format='png';capture.quality=null;capture.decoder='png';first=(await take()).data;
   }
   await driver.render(0);second=(await take()).data;
  }finally{await session.detach();stats.determinismCheckMs=performance.now()-determinismStarted;}
  if(first!==second)throw Error('同一时间点重复渲染画面不一致，存在未受控动画/随机绘制；请检查 renderCapture，不会回退实时录屏');
  first=null;second=null;
  logger.info('图像采集参数',{format:capture.format,quality:capture.quality,optimizeForSpeed:true,lossless:capture.format==='png',qualityBenchmarkStatus:capture.format==='png'?'baseline-lossless':'explicit-opt-in-not-approved-as-default',screenshotTimingScope:'CDP call includes paint, image encoding and base64 transfer'});
  logger.info('队列参数',{queueSize:capture.queueSize,maxQueueBytes:capture.queueMaxBytes,maxCapacity:16,scope:'capacity excludes one in-flight producer and one consumer frame'});
  perf=new ExportPerformance({totalFrames,fps,logger});
  const checkPage=()=>{
   abort(signal);
   if(stats.pageErrors.length)throw Error('导出期间页面脚本错误：'+stats.pageErrors.join('；'));
   if(resourceFailures.length)throw Error('导出期间资源失败：'+JSON.stringify(resourceFailures));
  };
  frameSource=createOfflineFrames({page,driver,fps,totalFrames,stats,signal,onProgress,checkPage,capture,perf});
  stats.setupTotalMs=performance.now()-started;
  frameSource.stop=()=>{browser.close().catch(()=>{});};
  frameQueue=new FrameQueue(frameSource,{size:capture.queueSize,maxBytes:capture.queueMaxBytes,signal});
  const encoded=await transcodeFrameStream({frames:frameQueue,outputPath,musicPath,fps,width,height,captureWidth:width,captureHeight:height,frameFormat:capture.format,profile:encoder,collectDecodeTiming:options.collectDecodeTiming,expectedFrames:totalFrames,durationHint:totalFrames/fps,logger,signal,
   onProgress:(ratio,message)=>{if(stats.renderedFrames===totalFrames)onProgress(82+ratio*16,'编码与校验',message);},
   onEncodingTiming:ms=>{stats.encodingTotalMs=ms;},
   onFrameWritten:record=>perf.record(record),
   onEncoderProgress:state=>{stats.encodedFrames=state.frame;},
   onCommitted:()=>onProgress(99,'完成校验','MP4 编码、帧数与完整解码校验已完成'),
   validateBeforeCommit:checkPage
  });
  stats.encodedFrames=encoded.frames;stats.droppedFrames=totalFrames-encoded.frames;
  stats.inputStats=encoded.inputStats;
  stats.videoDuration=encoded.durationSeconds;
  stats.renderAverageMs=stats.renderTotalMs/stats.renderedFrames;stats.duplicateFrameRatio=stats.duplicateFrameCount/Math.max(1,totalFrames-1);
  const performanceSummary=perf.finish();
  const totalExportMs=performance.now()-(options.__exportStarted??started);
  const metrics={...stats,...performanceSummary,...frameQueue.stats,mode:'deterministic-player-frame-rendering',driverMode:driver.mode,frames:encoded.frames,expectedFrames:totalFrames,
   fps,width,height,durationSeconds:encoded.durationSeconds,avgFps:fps,captureWidth:width,captureHeight:height,nativeResolution:true,
   renderTimelineMs:driver.totalMs,totalSeconds:totalExportMs/1000,totalExportMs,attemptCount:options.__forceSoftware?2:1,outputSizeBytes:encoded.size,
   format:capture.format,requestedFormat:capture.requestedFormat,quality:capture.quality,captureCount:stats.renderedFrames,averageImageBytes:perf.records.reduce((sum,r)=>sum+r.imageDataBytes,0)/totalFrames,maxImageBytes:stats.maxFrameBytes,minImageBytes:perf.records.reduce((min,r)=>Math.min(min,r.imageDataBytes),Infinity),
   screenshotAverageMs:performanceSummary.timing.screenshot.averageMs,screenshotP95Ms:performanceSummary.timing.screenshot.p95Ms,totalCaptureMs:performanceSummary.timing.screenshot.totalMs,captureStatisticsScope:'output-frame screenshots; preflight capture count/time recorded separately',totalCaptureCount:stats.renderedFrames+stats.preflightCaptureCount,
   ffmpegWallTime:encoded.ffmpegWallTime,ffmpegTailMs:encoded.ffmpegTailMs,ffmpegStartTime:encoded.ffmpegStartTime,ffmpegFirstProgressTime:encoded.ffmpegFirstProgressTime,ffmpegEndTime:encoded.ffmpegEndTime,
   validationTotalMs:encoded.validationTotalMs,ffmpegDecodeTime:encoded.ffmpegDecodeTime,ffmpegDecodeTimeScope:encoded.ffmpegDecodeTimeScope,finalVideoSize:encoded.size,
   actualEncoder:encoded.actualEncoder,encoderPreset:encoded.encoderPreset,crf:encoded.crf,pixelFormat:encoded.pixelFormat,requestedThreads:encoder.requestedThreads,cpuLogicalCores:encoder.cpuLogicalCores,backpressureWaits:encoded.inputStats.backpressureWaits,
   encoderRequested:encoder.requested,encoderCapabilities:encoder.availableEncoders,encoderBenchmarkStatus:encoder.benchmarkStatus,ffmpegProgressState:encoded.ffmpegProgressState,
   inputSize:encoded.inputSize,outputSize:encoded.outputSize,scaleApplied:encoded.scaleApplied,padApplied:encoded.padApplied,filter:encoded.filter,
   unexpectedDuplicateDuringMotion:stats.duplicateFrameCategories.expectedMotion,encodingTimingScope:'stream-start-to-encoder-exit-includes-render-overlap'};
  finalMetrics=metrics;
  return metrics;
 }catch(error){
  stats.unrenderedFrames=Math.max(0,stats.totalFrames-stats.renderedFrames);
  stats.renderAverageMs=stats.renderedFrames?stats.renderTotalMs/stats.renderedFrames:0;
  stats.duplicateFrameRatio=stats.duplicateFrameCount/Math.max(1,stats.renderedFrames-1);
  let partialPerformance=null;try{if(perf)partialPerformance=perf.finish();}catch(_){}
  logger.error('离线导出失败',{message:error.message,...stats,partialPerformance,queue:frameQueue?.stats,ffmpegTiming:error.ffmpegTiming,ffmpegProgress:error.ffmpegProgress,resourceFailures});throw error;
 }
 finally{
  signal?.removeEventListener('abort',closeOnAbort);
  if(frameQueue){if(!frameQueue.ended)frameQueue.stop(Error('导出任务已结束'));await timeout(frameQueue.return(),5000,'帧队列关闭超时').catch(()=>{});}
  if(driver)await timeout(driver.dispose(),3000,'媒体资源清理超时').catch(()=>{});
  await browser?.close().catch(()=>{});
  if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});
  if(finalMetrics){
   finalMetrics.totalExportMs=performance.now()-(options.__exportStarted??started);finalMetrics.totalSeconds=finalMetrics.totalExportMs/1000;
   finalMetrics.retryOverheadMs=options.__forceSoftware?started-(options.__exportStarted??started):0;
   finalMetrics.totalExportTimingScope='start through validation, output commit and resource teardown; includes any hardware retry';
   finalMetrics.browserImageEncodeMs=null;finalMetrics.browserImageEncodeScope='included in screenshotMs; no separate timing exposed by CDP';
   finalMetrics.bottleneckConfidenceMethod='rule-based indicator, not a calibrated probability';
   const baseline=width===1080&&height===1920&&driver.totalMs===40000&&driver.info.metrics?.pageHeight===23040&&driver.info.metrics?.endY===21120?({30:{totalSeconds:123.70,renderAverageMs:98.87},60:{totalSeconds:226.52,renderAverageMs:90.82}}[fps]):null;
   finalMetrics.baselineComparison=baseline?{baselineSource:'user-provided historical measurements; same geometry/timeline, source revision not independently verified',before:baseline,after:{totalSeconds:finalMetrics.totalSeconds,renderAverageMs:finalMetrics.renderAverageMs},speedRatio:baseline.totalSeconds/finalMetrics.totalSeconds}:null;
   const diagnosis=diagnoseBottleneck(finalMetrics);Object.assign(finalMetrics,diagnosis);
   logger.info('最终性能统计',finalMetrics);logger.info('自动瓶颈判断',diagnosis);logger.info('导出指标',finalMetrics);
   if(stats.duplicateFrameCategories.expectedMotion)logger.warn('运动状态出现重复画面，可能存在 player.renderAt / renderCapture 时间轴问题。',stats.duplicateFrameCategories);
   onProgress(100,'完成',`离线逐帧 MP4 已生成 · ${finalMetrics.frames} 帧 · ${finalMetrics.durationSeconds} 秒`,finalMetrics);
  }
 }
}
async function renderOfflineVideo(options){
 const started=performance.now();
 try{return await renderOfflineAttempt({...options,__exportStarted:started});}
 catch(error){
  if(!error.encoderFailure||options.signal?.aborted||options.analyzeOnly)throw error;
  options.logger?.warn('硬件编码失败，重新初始化页面并完整回退 libx264',{reason:'hardware encode/validation failure',action:'discard partial output; render every frame again from zero'});
  return renderOfflineAttempt({...options,__exportStarted:started,__forceSoftware:true});
 }
}
module.exports={renderOfflineVideo,prepareDriver,createOfflineFrames};
