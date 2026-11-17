const fs=require("node:fs");
const path=require("node:path");
const {spawn}=require("node:child_process");
const ffmpegPath=process.env.FFMPEG_PATH||require("ffmpeg-static");

function runFfmpeg(args,{onProgress=()=>{},logger,phase="FFmpeg",inputFrames=null,binary=ffmpegPath}={}){
 return new Promise((resolve,reject)=>{
  const hasInputFrames=inputFrames!==null;
  const child=spawn(binary,args,{windowsHide:true,stdio:[hasInputFrames?"pipe":"ignore","ignore","pipe"]});
  let stderr="",pending="",frame=0,outTimeUs=0,settled=false,lastProgressLogAt=0,inputError=null;
  child.stderr.on("data",chunk=>{
   const text=chunk.toString();
   stderr=(stderr+text).slice(-12000);
   pending+=text;
   const lines=pending.split(/\r?\n/);
   pending=lines.pop()||"";
   for(const line of lines){
    const index=line.indexOf("=");
    if(index<0)continue;
    const key=line.slice(0,index),value=line.slice(index+1);
    if(key==="frame")frame=Number.parseInt(value,10)||frame;
    if(key==="out_time_ms")outTimeUs=Number(value)||outTimeUs;
    if(key==="progress"){
     const state={frame,outTimeSeconds:outTimeUs/1000000,progress:value};
     onProgress(state);
     if(Date.now()-lastProgressLogAt>=5000){
      lastProgressLogAt=Date.now();
      logger?.info(phase+"进度",state);
     }
    }
   }
  });
  if(hasInputFrames){
   child.stdin.on("error",error=>{inputError=inputError||error;});
   (async()=>{
    try{
     for await(const buffer of inputFrames){
      if(!Buffer.isBuffer(buffer))throw new Error("逐帧采集器必须输出 Buffer 图片数据。");
      if(!child.stdin.write(buffer)){
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
      }
     }
     if(!child.stdin.destroyed)child.stdin.end();
    }catch(error){
     inputError=inputError||error;
     try{child.stdin.destroy();}catch(_){}
     if(!child.killed)child.kill();
    }
   })();
  }
  child.once("error",error=>{
   if(settled)return;settled=true;
   reject(new Error("无法启动 FFmpeg："+error.message));
  });
  child.once("close",code=>{
   if(settled)return;settled=true;
   if(inputError){
    logger?.error(phase+"输入失败",{message:inputError.message,stderr:stderr.slice(-5000)});
    reject(inputError);
   }else if(code===0){
    logger?.info(phase+"完成",{frame,outTimeSeconds:outTimeUs/1000000});
    resolve({frame,outTimeSeconds:outTimeUs/1000000,stderr});
   }else{
    logger?.error(phase+"失败",{exitCode:code,stderr:stderr.slice(-5000)});
    reject(new Error("FFmpeg 处理失败（退出码 "+code+"）。"+stderr.slice(-5000)));
   }
  });
 });
}

async function transcodeFrameStream({frames,outputPath,musicPath,fps,width,height,expectedFrames,durationHint,onProgress=()=>{},logger}){
 if(!ffmpegPath||!fs.existsSync(ffmpegPath))throw new Error("没有找到 FFmpeg 可执行文件。请检查 ffmpeg-static 是否安装完整。");
 if(!frames||typeof frames[Symbol.asyncIterator]!=="function")throw new Error("逐帧图片输入流无效。");
 if(!Number.isFinite(fps)||fps<1)throw new Error("逐帧编码帧率无效。");

 const outputDir=path.dirname(outputPath);
 fs.mkdirSync(outputDir,{recursive:true});
 const partialPath=path.join(outputDir,path.parse(outputPath).name+".partial-"+process.pid+"-"+Date.now()+".mp4");
 const filter="fps="+fps+":round=near,scale="+width+":"+height+":flags=lanczos:force_original_aspect_ratio=decrease,pad="+width+":"+height+":(ow-iw)/2:(oh-ih)/2,setsar=1";
 logger?.info("FFmpeg 逐帧转码参数",{
  input:"PNG image2pipe",fps,width,height,expectedFrames,
  expectedDurationSeconds:durationHint,filter,videoCodec:"libx264",preset:"fast",crf:18,music:Boolean(musicPath)
 });
 const args=["-y","-hide_banner","-loglevel","error",
  "-f","image2pipe","-framerate",String(fps),"-vcodec","png","-i","pipe:0"];
 if(musicPath)args.push("-stream_loop","-1","-i",musicPath);
 args.push("-map","0:v:0");
 if(musicPath)args.push("-map","1:a:0");
 args.push("-vf",filter,"-c:v","libx264","-preset","fast","-crf","18","-profile:v","high","-pix_fmt","yuv420p","-fps_mode","cfr");
 if(musicPath)args.push("-c:a","aac","-b:a","192k","-shortest");
 else args.push("-an");
 args.push("-movflags","+faststart","-progress","pipe:2",partialPath);

 try{
  onProgress(0,"开始逐帧编码");
  const converted=await runFfmpeg(args,{
   logger,phase:"逐帧 MP4 视频编码",inputFrames:frames,
   onProgress:state=>{
    const ratio=durationHint>0?Math.min(1,state.outTimeSeconds/durationHint):0;
    onProgress(ratio,"正在编码逐帧 MP4 · "+state.frame+" 帧");
   }
  });
  if(!fs.existsSync(partialPath)||fs.statSync(partialPath).size<1024)throw new Error("FFmpeg 未生成有效 MP4 文件。");

  const checked=await runFfmpeg([
   "-hide_banner","-loglevel","error","-i",partialPath,
   "-map","0:v:0","-progress","pipe:2","-f","null","-"
  ],{logger,phase:"MP4 完整解码校验"});
  if(!checked.frame)throw new Error("MP4 校验失败：没有检测到有效视频帧。");
  if(Number.isFinite(expectedFrames)&&checked.frame!==expectedFrames){
   logger?.warn("逐帧输出数量与预期不一致",{expectedFrames,actualFrames:checked.frame});
  }
  const size=fs.statSync(partialPath).size;
  const durationSeconds=Number((checked.outTimeSeconds>0?checked.outTimeSeconds:checked.frame/fps).toFixed(3));
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
  return {
   frames:checked.frame,durationSeconds,size,encodedFrames:converted.frame,
   expectedFrames,avgFps:Number((checked.frame/(durationSeconds||1)).toFixed(2))
  };
 }catch(error){
  fs.rmSync(partialPath,{force:true});
  logger?.error("逐帧 MP4 转码失败",{message:error.message,stack:error.stack||""});
  throw error;
 }
}

async function transcodeRecordedVideo({inputPath,outputPath,musicPath,fps,width,height,durationHint,onProgress=()=>{},logger,copyVideo=false}){
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
 else args.push("-vf",filter,"-c:v","libx264","-preset","veryfast","-crf","18","-threads","2","-profile:v","high","-pix_fmt","yuv420p","-fps_mode","cfr");
 if(musicPath)args.push("-c:a","aac","-b:a","192k","-shortest");
 else args.push("-an");
 args.push("-movflags","+faststart","-progress","pipe:2",partialPath);

 try{
  onProgress({frame:0,outTimeSeconds:0,progress:"continue"});
  const converted=await runFfmpeg(args,{logger,phase:"MP4 视频编码",onProgress:state=>{
   onProgress(state);
  }});
  if(!fs.existsSync(partialPath)||fs.statSync(partialPath).size<1024)throw new Error("FFmpeg 未生成有效 MP4 文件。");

  // 完整解码成品，直接读取实际帧数与媒体时间戳。
  // 不再用 ceil(预估时长 × FPS) 预测帧数，彻底避免 1224/1223 这种边界误报。
  const checked=await runFfmpeg([
   "-hide_banner","-loglevel","error","-i",partialPath,
   "-map","0:v:0","-progress","pipe:2","-f","null","-"
  ],{logger,phase:"MP4 完整解码校验"});
  if(!checked.frame)throw new Error("MP4 校验失败：没有检测到有效视频帧。");
  const size=fs.statSync(partialPath).size;
  const durationSeconds=Number((checked.outTimeSeconds>0?checked.outTimeSeconds:checked.frame/fps).toFixed(3));

  // 只有完整转码并解码校验成功后，才替换正式输出文件。
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

async function encodeLiveFrames({frames,outputPath,fps,profile,logger}){
 return runFfmpeg(["-y","-hide_banner","-loglevel","error","-threads","2","-probesize","32","-analyzeduration","0","-fpsprobesize","0","-f","image2pipe","-framerate",String(fps),"-vcodec","mjpeg","-i","pipe:0","-an",...profile.args,"-fps_mode","cfr","-progress","pipe:2",outputPath],{logger,phase:"连续 H.264 编码",inputFrames:frames,binary:profile.binary||ffmpegPath});
}
module.exports={transcodeRecordedVideo,transcodeFrameStream,encodeLiveFrames,ffmpegPath};

