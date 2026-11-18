const stages=['renderAt','renderCapture','playerRoundTrip','mediaSync','clockAdvance','screenshot','base64Decode','pipeWrite','backpressureWait','ffmpegQueueWait','totalFrame'];
function percentile(values,p){if(!values.length)return 0;const sorted=values.slice().sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)];}
function summarize(values){const total=values.reduce((a,b)=>a+b,0);return {count:values.length,totalMs:total,averageMs:values.length?total/values.length:0,minMs:values.length?values.reduce((a,b)=>Math.min(a,b),Infinity):0,maxMs:values.reduce((a,b)=>Math.max(a,b),0),p50Ms:percentile(values,.5),p95Ms:percentile(values,.95),p99Ms:percentile(values,.99)};}
class ExportPerformance{
 constructor({totalFrames,fps,logger}){
  this.totalFrames=totalFrames;this.fps=fps;this.logger=logger;this.records=[];this.previousY=null;this.lastLog=0;
  this.sampleIndices=new Set([0,.25,.5,.75,.9,1].map(p=>Math.round((totalFrames-1)*p)));
 }
 motion(state){
  const cameraY=Number.isFinite(state.cameraY)?state.cameraY:null;
  const deltaY=cameraY!==null&&this.previousY!==null?cameraY-this.previousY:0;
  if(cameraY!==null)this.previousY=cameraY;
  return {cameraY,deltaY,absDeltaY:Math.abs(deltaY),motionExpected:!!state.motionExpected,hold:!!state.hold,playerState:state.playerState||''};
 }
 record(record){
  if(record.frameIndex!==this.records.length||Math.abs(record.timelineMs-record.frameIndex*1000/this.fps)>1e-6){const error=Error('帧序号或固定时间轴不连续');error.frameProducerError=true;throw error;}
  // Only technical numeric metadata is retained, never PNGs, DOM or page text.
  const clean={...record};delete clean.buffer;this.records.push(clean);
  if(this.sampleIndices.has(clean.frameIndex))this.logger.info('固定时间点帧诊断',clean);
  const now=Date.now();if(now-this.lastLog>=4000){this.lastLog=now;this.logger.info('周期性帧性能',{completedFrames:this.records.length,totalFrames:this.totalFrames,latest:clean});}
 }
 finish(){
  const timing=Object.fromEntries(stages.map(stage=>[stage,summarize(this.records.map(r=>r[stage==='totalFrame'?'frameTotalMs':stage+'Ms']).filter(Number.isFinite))]));
  const percentiles={};for(const [key,stage] of [['renderAt','renderAt'],['renderCapture','renderCapture'],['screenshot','screenshot'],['frameTotal','totalFrame'],['backpressure','backpressureWait']])for(const p of [50,95,99])percentiles[key+'P'+p]=timing[stage]['p'+p+'Ms'];
  const delta=this.records.filter(r=>r.motionExpected&&r.cameraY!==null).map(r=>r.absDeltaY);
  const slow=this.records.filter(r=>timing.totalFrame.p50Ms>0&&r.frameTotalMs>3*timing.totalFrame.p50Ms);
  for(const r of slow.slice(0,200))this.logger.warn('异常帧（超过最终 P50 的三倍）',r);
  return {timing,percentiles,
   framesOver16_67ms:this.records.filter(r=>r.frameTotalMs>1000/60).length,framesOver33_33ms:this.records.filter(r=>r.frameTotalMs>1000/30).length,
   framesOver50ms:this.records.filter(r=>r.frameTotalMs>50).length,framesOver100ms:this.records.filter(r=>r.frameTotalMs>100).length,
   motionFrames:this.records.filter(r=>r.motionExpected).length,holdFrames:this.records.filter(r=>r.hold).length,
   deltaY:{min:delta.length?delta.reduce((a,b)=>Math.min(a,b),Infinity):null,max:delta.length?delta.reduce((a,b)=>Math.max(a,b),0):null,average:delta.length?delta.reduce((a,b)=>a+b,0)/delta.length:null,p50:percentile(delta,.5),p95:percentile(delta,.95),p99:percentile(delta,.99)},
   anomalousFrames:slow.length,anomalousFramesLogged:Math.min(200,slow.length),frameDiagnosticsCount:this.records.length,
   timingScopes:{renderAt:'native browser performance.now elapsed, excludes RPC',renderCapture:'native browser performance.now elapsed, excludes RPC',playerRoundTrip:'host evaluate round trip; includes renderAt/renderCapture, do not add these twice',screenshot:'CDP round trip including paint/image encode/base64 transfer',base64Decode:'Node Buffer.from',pipeWrite:'synchronous stdin.write call',backpressureWait:'stdin drain wait; count can equal frame count; overlaps producer',ffmpegQueueWait:'bounded queue residence, not FFmpeg internal decoder/encoder queues',totalFrame:'producer frame start to consumer drain completion; overlaps other frames'}};
 }
}
function diagnoseBottleneck(metrics){
 const t=metrics.timing;if(!t||!metrics.renderedFrames)return {bottleneck:'unknown',reason:'缺少完整阶段计时',confidence:0};
 const render=(t.playerRoundTrip.count?t.playerRoundTrip.totalMs:t.renderAt.totalMs+t.renderCapture.totalMs)+t.mediaSync.totalMs+t.clockAdvance.totalMs;
 const capture=t.screenshot.totalMs,decode=t.base64Decode.totalMs;
 const wall=metrics.totalExportMs||metrics.totalSeconds*1000;
 if(metrics.retryOverheadMs>wall*.3)return {bottleneck:'unknown',reason:'硬件失败重试占显著耗时，不能用成功尝试的帧计时归因整个任务',confidence:0};
 if(metrics.setupTotalMs>wall*.5)return {bottleneck:'unknown',reason:'页面准备/编码器探测占总耗时超过一半；请查看 setupTotalMs 的分阶段计时',confidence:0};
 if(metrics.validationTotalMs>wall*.5)return {bottleneck:'validation',reason:'完整解码与参数校验占总耗时超过一半',confidence:.9};
 const production=render+capture+decode;
 if(metrics.ffmpegTailMs>wall*.5)return {bottleneck:'ffmpeg-encode',reason:'输入结束后的 FFmpeg 尾部处理占总耗时超过一半；可能包含编码器排空和封装',confidence:.75};
 if(t.backpressureWait.totalMs>metrics.renderTotalMs*.7&&metrics.producerWaitMs>metrics.renderTotalMs*.3)return {bottleneck:'pipe-backpressure',reason:'管道 drain 等待与生产者队列背压均较高，不能据此区分 FFmpeg 解码和编码瓶颈',confidence:.8};
 if(production>0&&capture/production>.6)return {bottleneck:'screenshot',reason:'截图 CDP 调用占生产阶段超过 60%；包含浏览器图像编码和传输，不能单独归因为 PNG 编码',confidence:.85};
 if(production>0&&render/production>.6)return {bottleneck:'player-render',reason:'播放器定位、画面等待和媒体同步占生产阶段超过 60%',confidence:.85};
 if(production>0&&Math.max(render,capture,decode)/production<.6)return {bottleneck:'balanced',reason:'已测生产阶段没有单项超过 60%',confidence:.7};
 return {bottleneck:'unknown',reason:'现有计时不足以可靠区分图像编码、传输或 FFmpeg 内部阶段',confidence:0};
}
module.exports={ExportPerformance,diagnoseBottleneck,percentile,summarize};
