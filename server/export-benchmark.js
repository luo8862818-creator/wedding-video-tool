const fs=require('node:fs');
const path=require('node:path');
const {performance}=require('node:perf_hooks');
const {renderOfflineVideo}=require('./offline-render');
const {runFfmpeg,ffmpegPath}=require('./ffmpeg');
const {createFileLogger}=require('./logger');

// Explicit opt-in entry point only. Normal exports never run the matrix and
// never promote a lossy image format or a hardware encoder automatically.
async function benchmarkExports({sourcePath,directory,fps=60,width=1080,height=1920,durationMs,formats=['png','webp','jpeg'],encoders=['software'],signal,onProgress=()=>{}}){
 if(!/\.html?$/i.test(sourcePath)||!fs.statSync(sourcePath).isFile())throw Error('Benchmark 需要本地 HTML 文件');
 if(!formats.every(f=>['png','webp','jpeg'].includes(f)))throw Error('无效的 Benchmark 截图格式');
 if(!encoders.every(e=>['software','hardware','auto','libx264','h264_nvenc','h264_qsv','h264_amf','h264_mf'].includes(e)))throw Error('无效的 Benchmark 编码器');
 fs.mkdirSync(directory,{recursive:true});
 const log=createFileLogger(path.join(directory,'benchmark.log'));
 const matrix=[{format:'png',encoder:'software'},...encoders.flatMap(encoder=>formats.map(format=>({format,encoder})))];
 const unique=matrix.filter((entry,i)=>matrix.findIndex(x=>x.format===entry.format&&x.encoder===entry.encoder)===i);
 const results=[];let baseline;
 const started=performance.now();
 try{
  log.info('Benchmark 开始',{fps,width,height,durationMs:durationMs??'page timeline',formats,encoders,profileDecodeTiming:true,scope:'same page/path, timeline, FPS and viewport; final H264 quality compared against PNG/software baseline; profiler overhead included'});
  for(const variant of unique){
   if(signal?.aborted)throw signal.reason;
   const name=variant.format+'-'+variant.encoder;
   const outputPath=path.join(directory,name+'.mp4');
   const logger=createFileLogger(path.join(directory,name+'.log'));
   let metrics;
   try{
    logger.info('导出任务开始',{benchmark:true,...variant,fps,width,height});
    metrics=await renderOfflineVideo({sourcePath,outputPath,fps,width,height,durationMs,frameFormat:variant.format,frameQuality:100,encoder:variant.encoder,collectDecodeTiming:true,signal,logger,onProgress});
    logger.info('导出任务结束',{status:'completed',totalExportMs:metrics.totalExportMs});
   }catch(error){
    logger.error('导出任务结束',{status:signal?.aborted?'cancelled':'failed',message:error.message.slice(0,300)});
    if(signal?.aborted||!baseline)throw error;
    results.push({...variant,status:'failed',reason:error.code||error.name});continue;
   }finally{await logger.close();}
   const result={...variant,actualFormat:metrics.format,actualEncoder:metrics.actualEncoder,metrics,status:'completed'};
   if(!baseline){baseline={outputPath,metrics};result.ssim=1;result.psnrDb='inf';result.qualityGate=true;}
   else{
    const same=metrics.fps===baseline.metrics.fps&&metrics.width===baseline.metrics.width&&metrics.height===baseline.metrics.height&&metrics.renderTimelineMs===baseline.metrics.renderTimelineMs&&metrics.frames===baseline.metrics.frames;
    if(!same)throw Error('Benchmark 工作负载不一致，拒绝比较速度/画质');
    if(metrics.format!==variant.format){result.status='format-unsupported-png-fallback';result.qualityGate=false;}
    else{
     const comparison=await runFfmpeg(['-hide_banner','-loglevel','info','-i',baseline.outputPath,'-i',outputPath,
      '-filter_complex','[0:v]setpts=PTS-STARTPTS,split=2[ra][rb];[1:v]setpts=PTS-STARTPTS,split=2[ca][cb];[ra][ca]ssim=shortest=1[s];[rb][cb]psnr=shortest=1[p]',
      '-map','[s]','-map','[p]','-an','-progress','pipe:2','-f','null','-'],{signal,logger:log,phase:'成片画质比较',binary:ffmpegPath});
     const ssim=comparison.stderr.match(/All:([\d.]+)/),psnr=comparison.stderr.match(/average:([\d.]+|inf)/);
     result.ssim=ssim?Number(ssim[1]):null;result.psnrDb=psnr?(psnr[1]==='inf'?'inf':Number(psnr[1])):null;
     result.qualityGate=result.ssim!==null&&result.ssim>=.995&&(result.psnrDb==='inf'||(typeof result.psnrDb==='number'&&result.psnrDb>=50));
    }
   }
   result.speedVsBaseline=baseline.metrics.totalExportMs/metrics.totalExportMs;
   result.crossPlayerCompatibility='requires manual playback review';
   results.push(result);log.info('格式/编码器 Benchmark 结果',result);
  }
  const summary={results,totalBenchmarkMs:performance.now()-started,defaultFormat:'png',defaultEncoder:'libx264',policy:'objective quality gates do not grant subjective approval; no automatic default changes',baseline60fps226_52sComparison:baseline&&fps===60&&width===1080&&height===1920&&baseline.metrics.frames===2400&&baseline.metrics.renderTimelineMs===40000?{oldTotalSeconds:226.52,newTotalSeconds:baseline.metrics.totalSeconds,improvementRatio:226520/baseline.metrics.totalExportMs}:null};
  log.info('Benchmark 完成',summary);return summary;
 }finally{await log.close();}
}
module.exports={benchmarkExports};
