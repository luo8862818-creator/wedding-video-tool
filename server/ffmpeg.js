const fs=require("node:fs");
const path=require("node:path");
const {spawn}=require("node:child_process");
const {performance}=require('node:perf_hooks');
const {threadConfig,softwareProfile}=require('./encoder-profile');
const ffmpegPath=process.env.FFMPEG_PATH||require("ffmpeg-static");
function technicalStderr(text){return text.split(/\r?\n/).filter(line=>/^\[[^\]]+\]|^(Error|Invalid|Unknown|Failed|Cannot|Unable|No such|Permission)/i.test(line.trim())).slice(-12).map(line=>line.slice(0,300)).join('\n');}

function makeAbortError(signal){
 const error=new Error(signal?.reason?.message||"导出任务已停止。");
 error.name="AbortError";error.code="ABORT_ERR";
 return error;
}
function throwIfAborted(signal){
 if(signal?.aborted)throw makeAbortError(signal);
}

function runFfmpeg(args,{onProgress=()=>{},onFrameWritten=()=>{},logger,phase="FFmpeg",inputFrames=null,binary=ffmpegPath,signal}={}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(makeAbortError(signal));return;}
  const hasInputFrames=inputFrames!==null;
  const processStart=performance.now(),ffmpegStartTime=new Date().toISOString();
  let ffmpegFirstProgressTime=null,inputFinishedAt=null;
  const progressFields={fps:null,speed:null,bitrate:null,totalSize:null,dupFrames:0,dropFrames:0};
  const mediaInfo={},decodeProfile={enabled:args.includes('-benchmark_all'),decodeSamples:0,decodeRealMs:0,decodeUserMs:0,decodeSystemMs:0,encodeRealMs:0};
  function processTiming(){const end=performance.now();return {ffmpegStartTime,ffmpegFirstProgressTime,ffmpegEndTime:new Date().toISOString(),ffmpegWallTime:end-processStart,ffmpegTailMs:inputFinishedAt===null?null:end-inputFinishedAt};}
  const child=spawn(binary,args,{windowsHide:true,stdio:[hasInputFrames?"pipe":"ignore","ignore","pipe"]});
  let stderr="",pending="",frame=0,outTimeUs=0,settled=false,lastProgressLogAt=0,inputError=null;
  let inputTask=Promise.resolve();
  let inputFinished=!hasInputFrames;
  const inputStats={inputFrames:0,maxBufferedBytes:0,backpressureWaits:0};
  let abortHandler=null;
  const cleanupAbort=()=>{if(signal&&abortHandler)signal.removeEventListener("abort",abortHandler);};
  abortHandler=()=>{
   inputError=makeAbortError(signal);
   if(hasInputFrames&&!child.stdin.destroyed)child.stdin.destroy();
   if(!child.killed)child.kill();
  };
  signal?.addEventListener("abort",abortHandler,{once:true});
  child.stderr.on("data",chunk=>{
   const text=chunk.toString();
   stderr=(stderr+text).slice(-12000);
   pending+=text;
   const lines=pending.split(/\r?\n/);
   pending=lines.pop()||"";
   for(const line of lines){
    const dimensions=line.match(/\bs:(\d+)x(\d+)/);if(dimensions){mediaInfo.width=Number(dimensions[1]);mediaInfo.height=Number(dimensions[2]);}
    const rate=line.match(/frame_rate:\s*(\d+)\/(\d+)/);if(rate&&Number(rate[2]))mediaInfo.fps=Number(rate[1])/Number(rate[2]);
    const timeBase=line.match(/time_base:\s*(\d+)\/(\d+)/);if(timeBase&&Number(timeBase[2]))mediaInfo.timeBase=Number(timeBase[1])/Number(timeBase[2]);
    const codec=line.match(/Video:\s*(h264)\b/);if(codec)mediaInfo.codec=codec[1];
    const pts=line.match(/\bn:\s*\d+\s+pts:\s*(-?\d+)\s+pts_time:([\d.-]+)/);
    if(pts){const time=mediaInfo.timeBase?Number(pts[1])*mediaInfo.timeBase:Number(pts[2]);mediaInfo.firstPts??=time;mediaInfo.lastPts=time;mediaInfo.timestampCount=(mediaInfo.timestampCount||0)+1;}
    const bench=line.match(/bench:\s*(\d+)\s+user\s+(\d+)\s+sys\s+(\d+)\s+real\s+(decode_video|encode_video)/);
    if(bench){const key=bench[4]==='decode_video'?'decodeRealMs':'encodeRealMs';decodeProfile[key]+=Number(bench[3])/1000;if(bench[4]==='decode_video'){decodeProfile.decodeSamples++;decodeProfile.decodeUserMs+=Number(bench[1])/1000;decodeProfile.decodeSystemMs+=Number(bench[2])/1000;}}
    const index=line.indexOf("=");
    if(index<0)continue;
    const key=line.slice(0,index),value=line.slice(index+1);
    if(key==="frame")frame=Number.parseInt(value,10)||frame;
    if(key==="out_time_ms"||key==='out_time_us')outTimeUs=Number(value)||outTimeUs;
    const field={fps:'fps',speed:'speed',bitrate:'bitrate',total_size:'totalSize',dup_frames:'dupFrames',drop_frames:'dropFrames'}[key];
    if(field){const number=parseFloat(value);progressFields[field]=Number.isFinite(number)?number:null;}
    if(key==="progress"){
     ffmpegFirstProgressTime??=new Date().toISOString();
     const state={frame,...progressFields,outTimeSeconds:outTimeUs/1000000,progress:value};
     onProgress(state);
     if(Date.now()-lastProgressLogAt>=4000){
      lastProgressLogAt=Date.now();
      logger?.info(phase+"进度",state);
     }
    }
   }
  });
  if(hasInputFrames){
   child.stdin.on("error",error=>{inputError=inputError||error;});
   inputTask=(async()=>{
    try{
     for await(const framePacket of inputFrames){
      const packet=Buffer.isBuffer(framePacket)?null:framePacket;
      const buffer=packet?packet.buffer:framePacket;
      if(child.stdin.destroyed)throw inputError||new Error("FFmpeg 输入管道已关闭");
      if(!Buffer.isBuffer(buffer))throw new Error("逐帧采集器必须输出 Buffer 图片数据。");
      const writeStarted=performance.now();
      const writable=child.stdin.write(buffer);inputStats.inputFrames++;
      const pipeWriteMs=performance.now()-writeStarted;let backpressureWaitMs=0;
      inputStats.maxBufferedBytes=Math.max(inputStats.maxBufferedBytes,child.stdin.writableLength);
      if(!writable){
       inputStats.backpressureWaits++;
       const waitStarted=performance.now();
       await new Promise((resolveDrain,rejectDrain)=>{
        const cleanup=()=>{
         child.stdin.removeListener("drain",onDrain);
         child.stdin.removeListener("error",onError);
         child.stdin.removeListener("close",onClose);
        };
        const onDrain=()=>{cleanup();resolveDrain();};
        const onError=error=>{cleanup();rejectDrain(error);};
        const onClose=()=>{cleanup();rejectDrain(new Error("FFmpeg 提前关闭了图片输入管道。"));};
        child.stdin.once("drain",onDrain);
        child.stdin.once("error",onError);
        child.stdin.once("close",onClose);
       });
       backpressureWaitMs=performance.now()-waitStarted;
      }
      if(packet){Object.assign(packet.diagnostic,{pipeWriteMs,backpressureWaitMs,frameTotalMs:performance.now()-packet.startedAt});onFrameWritten(packet.diagnostic);}
     }
     inputFinished=true;
     inputFinishedAt=performance.now();
     if(!child.stdin.destroyed)child.stdin.end();
    }catch(error){
     inputError=inputError||error;
     try{child.stdin.destroy();}catch(_){}
     if(!child.killed)child.kill();
    }
   })();
  }
  child.once("error",error=>{
   if(settled)return;settled=true;cleanupAbort();
   reject(signal?.aborted?makeAbortError(signal):new Error("无法启动 FFmpeg："+error.message));
  });
  child.once("close",async code=>{
   const ffmpegTiming=processTiming();
   logger?.info(phase+'进程耗时',ffmpegTiming);
   if(!inputFinished){
    inputError=inputError||new Error("FFmpeg 在输入流完成前退出（退出码 "+code+"）");
    // Wake legacy queues, or cancel the currently rendering offline frame.
    try{inputFrames?.stop?.();}catch(_){}
   }
   await inputTask;
   if(settled)return;settled=true;cleanupAbort();
   if(signal?.aborted){
    reject(makeAbortError(signal));
   }else if(inputError){
    logger?.error(phase+"输入失败",{message:inputError.message.slice(0,500),stderr:technicalStderr(stderr)});
    reject(Object.assign(inputError,{ffmpegTiming,ffmpegProgress:{frame,...progressFields},ffmpegInputStats:inputStats}));
   }else if(code===0){
    logger?.info(phase+"完成",{frame,outTimeSeconds:outTimeUs/1000000});
    resolve({frame,outTimeSeconds:outTimeUs/1000000,stderr,inputStats,ffmpegTiming,mediaInfo,decodeProfile,progressFields});
   }else{
    logger?.error(phase+"失败",{exitCode:code,stderr:technicalStderr(stderr)});
    reject(Object.assign(new Error("FFmpeg 处理失败（退出码 "+code+"）。"+technicalStderr(stderr)),{ffmpegTiming,ffmpegProgress:{frame,...progressFields},ffmpegInputStats:inputStats}));
   }
  });
 });
}

async function transcodeFrameStream({frames,outputPath,musicPath,fps,width,height,captureWidth=width,captureHeight=height,frameFormat='png',profile,collectDecodeTiming,expectedFrames,durationHint,onProgress=()=>{},onCommitted=()=>{},onEncodingTiming=()=>{},onFrameWritten=()=>{},onEncoderProgress=()=>{},validateBeforeCommit=()=>{},logger,signal}){
 if(!ffmpegPath||!fs.existsSync(ffmpegPath))throw new Error("没有找到 FFmpeg 可执行文件。请检查 ffmpeg-static 是否安装完整。");
 if(!frames||typeof frames[Symbol.asyncIterator]!=="function")throw new Error("逐帧图片输入流无效。");
 if(!Number.isFinite(fps)||fps<1)throw new Error("逐帧编码帧率无效。");

 const outputDir=path.dirname(outputPath);
 fs.mkdirSync(outputDir,{recursive:true});
 const partialPath=path.join(outputDir,path.parse(outputPath).name+".partial-"+process.pid+"-"+Date.now()+".mp4");
 // Each input image already represents one exact timeline frame. Do not
 // resample it through an fps filter or synthesize/drop frames a second time.
 const scaleApplied=captureWidth!==width||captureHeight!==height,padApplied=scaleApplied;
 const filter=scaleApplied?"scale="+width+":"+height+":flags=lanczos:force_original_aspect_ratio=decrease,pad="+width+":"+height+":(ow-iw)/2:(oh-ih)/2,setsar=1":"setsar=1";
 const decoder={png:'png',webp:'webp',jpeg:'mjpeg'}[frameFormat];if(!decoder)throw Error('不支持的帧编码格式：'+frameFormat);
 const threads=threadConfig(),encoder=profile||softwareProfile(ffmpegPath);
 const profiling=collectDecodeTiming??(process.env.WEDDING_FFMPEG_PROFILE==='1');
 logger?.info("FFmpeg 逐帧转码参数",{
  input:frameFormat+" image2pipe",inputSize:captureWidth+'x'+captureHeight,outputSize:width+'x'+height,scaleApplied,padApplied,fps,width,height,expectedFrames,
  expectedDurationSeconds:durationHint,filter,actualEncoder:encoder.name,encoderPreset:encoder.preset,crf:encoder.crf,pixelFormat:encoder.pixelFormat,cpuLogicalCores:threads.cpuLogicalCores,requestedThreads:threads.requestedThreads,music:Boolean(musicPath),profiling,
  filterScope:'explicit geometric scale/pad only; pixel-format conversion remains necessary',progressUnits:{fps:'frames/s',speed:'x realtime including input wait',bitrate:'kbits/s',totalSize:'bytes',outTimeSeconds:'seconds'}
 });
 const args=["-y","-hide_banner","-loglevel",profiling?"info":"error",...(profiling?['-benchmark_all']:[]),
  "-threads",threads.threadValue,"-probesize","32","-analyzeduration","0","-fpsprobesize","0",
  "-f","image2pipe","-framerate",String(fps),"-vcodec",decoder,"-i","pipe:0"];
 if(musicPath)args.push("-stream_loop","-1","-i",musicPath);
 args.push("-map","0:v:0");
 if(musicPath)args.push("-map","1:a:0");
 args.push("-vf",filter,...encoder.args,"-fps_mode","passthrough");
 if(musicPath)args.push("-af","asetpts=PTS-STARTPTS","-c:a","aac","-b:a","192k","-t",String(durationHint));
 else args.push("-an");
 args.push("-movflags","+faststart","-progress","pipe:2",partialPath);

 let phase='encode';
 try{
  onProgress(0,"开始逐帧编码");
  const encodingStarted=performance.now();
  let converted;
  try{converted=await runFfmpeg(args,{
   logger,phase:"逐帧 MP4 视频编码",inputFrames:frames,signal,binary:encoder.binary||ffmpegPath,onFrameWritten,
   onProgress:state=>{
    onEncoderProgress(state);
    const ratio=durationHint>0?Math.min(1,state.outTimeSeconds/durationHint):0;
    onProgress(ratio,"正在编码逐帧 MP4 · "+state.frame+" 帧");
   }
  });}catch(error){error.encoderFailure=encoder.kind==='hardware'&&!error.frameProducerError&&!signal?.aborted;throw error;}
  phase='validation';
  onEncodingTiming(performance.now()-encodingStarted);
  if(Number.isFinite(expectedFrames)&&converted.inputStats.inputFrames!==expectedFrames)throw Error('FFmpeg 实际输入帧数与预期不一致');
  if((converted.progressFields.dropFrames||0)>0||(converted.progressFields.dupFrames||0)>0)throw Error('FFmpeg 发生了丢帧或补帧，拒绝交付离线成片');
  if(!fs.existsSync(partialPath)||fs.statSync(partialPath).size<1024)throw new Error("FFmpeg 未生成有效 MP4 文件。");

  const validationStarted=performance.now();
  const checked=await runFfmpeg([
   "-hide_banner","-loglevel","info","-xerror","-err_detect","explode","-i",partialPath,
   "-map","0:v:0","-vf","showinfo=checksum=0","-fps_mode","passthrough","-progress","pipe:2","-f","null","-"
  ],{logger,phase:"MP4 完整解码校验",signal});
  const validationTotalMs=performance.now()-validationStarted;
  if(!checked.frame)throw new Error("MP4 校验失败：没有检测到有效视频帧。");
  if(Number.isFinite(expectedFrames)&&checked.frame!==expectedFrames){
   throw new Error("逐帧输出帧数不一致，已停止交付：预期 "+expectedFrames+" 帧，实际 "+checked.frame+" 帧。");
  }
  const actual=checked.mediaInfo;
  if(actual.width!==width||actual.height!==height||Math.abs((actual.fps||0)-fps)>.000001||actual.codec!=='h264')throw new Error('MP4 分辨率、FPS 或编码参数校验失败：'+JSON.stringify(actual));
  if(actual.timestampCount!==checked.frame||Math.abs(actual.firstPts||0)>.0001||Math.abs((actual.lastPts||0)+1/fps-checked.frame/fps)>.001)throw new Error('MP4 固定时间轴校验失败');
  const size=fs.statSync(partialPath).size;
  // Decoder progress may report the last frame PTS, which excludes its duration.
  const durationSeconds=Number((checked.frame/fps).toFixed(3));
  phase='commit';await validateBeforeCommit();
  throwIfAborted(signal);
  const backupPath=outputPath+".previous-"+process.pid+"-"+Date.now();
  const hadPrevious=fs.existsSync(outputPath);
  if(hadPrevious)fs.renameSync(outputPath,backupPath);
  try{
   fs.renameSync(partialPath,outputPath);
  }catch(renameError){
   if(hadPrevious&&fs.existsSync(backupPath)&&!fs.existsSync(outputPath))fs.renameSync(backupPath,outputPath);
   throw renameError;
  }
  if(hadPrevious){
   try{fs.rmSync(backupPath,{force:true});}
   catch(cleanupError){logger?.warn("旧视频备份清理失败",{message:cleanupError.message});}
  }
  logger?.info("逐帧 MP4 输出校验通过",{
   width,height,fps,durationSeconds,sizeBytes:size,
   frames:checked.frame,expectedFrames,encodedFrames:converted.frame
  });
  onCommitted({frames:checked.frame,durationSeconds,size});
  return {
   frames:checked.frame,durationSeconds,size,encodedFrames:converted.frame,
   expectedFrames,avgFps:Number((checked.frame/(durationSeconds||1)).toFixed(2)),inputStats:converted.inputStats,
   ...converted.ffmpegTiming,validationTotalMs,mediaInfo:actual,actualEncoder:encoder.name,encoderPreset:encoder.preset,crf:encoder.crf,pixelFormat:encoder.pixelFormat,
   inputSize:captureWidth+'x'+captureHeight,outputSize:width+'x'+height,scaleApplied,padApplied,filter,
   ffmpegDecodeTime:profiling&&converted.decodeProfile.decodeSamples?converted.decodeProfile.decodeRealMs:null,ffmpegDecodeTimeScope:profiling?'sum of benchmark_all decode_video real intervals; null if this FFmpeg emitted no counters; not exclusive CPU time':'not collected; enable WEDDING_FFMPEG_PROFILE=1',decodeProfile:converted.decodeProfile,ffmpegProgressState:converted.progressFields
  };
 }catch(error){
  if(error.encoderFailure===undefined)error.encoderFailure=encoder.kind==='hardware'&&phase==='validation'&&!signal?.aborted;
  fs.rmSync(partialPath,{force:true});
  logger?.error("逐帧 MP4 转码失败",{message:error.message,stack:error.stack||""});
  throw error;
 }
}

async function transcodeRecordedVideo({inputPath,outputPath,musicPath,fps,width,height,durationHint,onProgress=()=>{},onCommitted=()=>{},logger,copyVideo=false,signal}){
 if(!ffmpegPath||!fs.existsSync(ffmpegPath))throw new Error("没有找到 FFmpeg 可执行文件。请检查 ffmpeg-static 是否安装完整。");
 if(!fs.existsSync(inputPath)||fs.statSync(inputPath).size===0)throw new Error("浏览器录制文件不存在或为空，无法生成 MP4。");

 const outputDir=path.dirname(outputPath);
 fs.mkdirSync(outputDir,{recursive:true});
 const partialPath=path.join(outputDir,path.parse(outputPath).name+".partial-"+process.pid+"-"+Date.now()+".mp4");
 const filter="fps="+fps+":round=near,scale="+width+":"+height+":flags=lanczos:force_original_aspect_ratio=decrease,pad="+width+":"+height+":(ow-iw)/2:(oh-ih)/2,setsar=1";
 logger?.info("FFmpeg 转码参数",{fps,width,height,filter,videoCodec:copyVideo?"copy":"libx264",preset:"fast",crf:18,music:Boolean(musicPath)});
 const args=["-y","-hide_banner","-loglevel","error","-i",inputPath];
 if(musicPath)args.push("-stream_loop","-1","-i",musicPath);
 args.push("-map","0:v:0");
 if(musicPath)args.push("-map","1:a:0");
 if(copyVideo)args.push("-c:v","copy");
 else args.push("-vf",filter,"-c:v","libx264","-preset","veryfast","-crf","18","-threads",threadConfig().threadValue,"-profile:v","high","-pix_fmt","yuv420p","-fps_mode","cfr");
 if(musicPath)args.push("-c:a","aac","-b:a","192k","-shortest");
 else args.push("-an");
 args.push("-movflags","+faststart","-progress","pipe:2",partialPath);

 try{
  onProgress({frame:0,outTimeSeconds:0,progress:"continue"});
  const converted=await runFfmpeg(args,{logger,phase:"MP4 视频编码",signal,onProgress:state=>{
   onProgress(state);
  }});
  if(!fs.existsSync(partialPath)||fs.statSync(partialPath).size<1024)throw new Error("FFmpeg 未生成有效 MP4 文件。");

  // 完整解码成品，直接读取实际帧数与媒体时间戳。
  // 不再用 ceil(预估时长 × FPS) 预测帧数，彻底避免 1224/1223 这种边界误报。
  const checked=await runFfmpeg([
   "-hide_banner","-loglevel","error","-i",partialPath,
   "-map","0:v:0","-progress","pipe:2","-f","null","-"
  ],{logger,phase:"MP4 完整解码校验",signal});
  if(!checked.frame)throw new Error("MP4 校验失败：没有检测到有效视频帧。");
  const size=fs.statSync(partialPath).size;
  const durationSeconds=Number((checked.outTimeSeconds>0?checked.outTimeSeconds:checked.frame/fps).toFixed(3));

  // 只有完整转码并解码校验成功后，才替换正式输出文件。
  throwIfAborted(signal);
  const backupPath=outputPath+".previous-"+process.pid+"-"+Date.now();
  const hadPrevious=fs.existsSync(outputPath);
  if(hadPrevious)fs.renameSync(outputPath,backupPath);
  try{
   fs.renameSync(partialPath,outputPath);
  }catch(renameError){
   if(hadPrevious&&fs.existsSync(backupPath)&&!fs.existsSync(outputPath))fs.renameSync(backupPath,outputPath);
   throw renameError;
  }
  if(hadPrevious){
   try{fs.rmSync(backupPath,{force:true});}
   catch(cleanupError){logger?.warn("旧视频备份清理失败",{message:cleanupError.message});}
  }
  logger?.info("MP4 输出校验通过",{width,height,fps,durationSeconds,sizeBytes:size,frames:checked.frame,encodedFrames:converted.frame});
  onCommitted({frames:checked.frame,durationSeconds,size});
  return {
   frames:checked.frame,
   durationSeconds,
   size,
   encodedFrames:converted.frame,
   avgFps:Number((checked.frame/(durationSeconds||1)).toFixed(2))
  };
 }catch(error){
  fs.rmSync(partialPath,{force:true});
  logger?.error("MP4 转码失败",{message:error.message,stack:error.stack||""});
  throw error;
 }
}

async function encodeLiveFrames({frames,outputPath,fps,profile,logger,signal}){
 return runFfmpeg(["-y","-hide_banner","-loglevel","error","-threads",threadConfig().threadValue,"-probesize","32","-analyzeduration","0","-fpsprobesize","0","-f","image2pipe","-framerate",String(fps),"-vcodec","mjpeg","-i","pipe:0","-an",...profile.args,"-fps_mode","cfr","-progress","pipe:2",outputPath],{logger,phase:"连续 H.264 编码",inputFrames:frames,binary:profile.binary||ffmpegPath,signal});
}
module.exports={transcodeRecordedVideo,transcodeFrameStream,encodeLiveFrames,ffmpegPath,runFfmpeg};

