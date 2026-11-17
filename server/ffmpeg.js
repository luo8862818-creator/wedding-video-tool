const fs=require("node:fs");
const {spawn}=require("node:child_process");
const ffmpegPath=require("ffmpeg-static");

function runFfmpeg(args,{onProgress=()=>{}}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(ffmpegPath,args,{windowsHide:true,stdio:["ignore","ignore","pipe"]});
  let stderr="",pending="",frame=0,outTimeUs=0,settled=false;
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
    if(key==="progress")onProgress({frame,outTimeSeconds:outTimeUs/1000000,progress:value});
   }
  });
  child.once("error",error=>{
   if(settled)return;settled=true;
   reject(new Error("无法启动 FFmpeg："+error.message));
  });
  child.once("close",code=>{
   if(settled)return;settled=true;
   if(code===0)resolve({frame,outTimeSeconds:outTimeUs/1000000,stderr});
   else reject(new Error("FFmpeg 处理失败（退出码 "+code+"）。"+stderr.slice(-5000)));
  });
 });
}

async function transcodeRecordedVideo({inputPath,outputPath,musicPath,fps,width,height,durationHint,onProgress=()=>{}}){
 if(!ffmpegPath||!fs.existsSync(ffmpegPath))throw new Error("没有找到 FFmpeg 可执行文件。请检查 ffmpeg-static 是否安装完整。");
 if(!fs.existsSync(inputPath)||fs.statSync(inputPath).size===0)throw new Error("浏览器录制文件不存在或为空，无法生成 MP4。");
 const filter="fps="+fps+",scale="+width+":"+height+":force_original_aspect_ratio=decrease,pad="+width+":"+height+":(ow-iw)/2:(oh-ih)/2,setsar=1";
 const args=["-y","-hide_banner","-loglevel","error","-i",inputPath];
 if(musicPath)args.push("-stream_loop","-1","-i",musicPath);
 args.push("-map","0:v:0");
 if(musicPath)args.push("-map","1:a:0");
 args.push("-vf",filter,"-c:v","libx264","-preset","veryfast","-crf","20","-pix_fmt","yuv420p","-fps_mode","cfr");
 if(musicPath)args.push("-c:a","aac","-b:a","192k","-shortest");
 else args.push("-an");
 args.push("-movflags","+faststart","-progress","pipe:2",outputPath);

 onProgress(0,"开始转码");
 const converted=await runFfmpeg(args,{onProgress:state=>{
  const ratio=durationHint>0?Math.min(1,state.outTimeSeconds/durationHint):0;
  onProgress(ratio,"正在转码 MP4 · "+state.frame+" 帧");
 }});
 if(!fs.existsSync(outputPath)||fs.statSync(outputPath).size<1024)throw new Error("FFmpeg 未生成有效 MP4 文件。");

 // 再解码一次成品，确认文件可读，并以实际输出帧数计算时长。
 // 不再用 ceil(duration * fps) 与 FFmpeg 的最后一帧做容易产生 1 帧误差的比较。
 const checked=await runFfmpeg([
  "-hide_banner","-loglevel","error","-i",outputPath,
  "-map","0:v:0","-progress","pipe:2","-f","null","-"
 ]);
 if(!checked.frame)throw new Error("MP4 校验失败：没有检测到有效视频帧。");
 const size=fs.statSync(outputPath).size;
 const durationSeconds=Number((checked.frame/fps).toFixed(3));
 return {frames:checked.frame,durationSeconds,size,encodedFrames:converted.frame};
}

module.exports={transcodeRecordedVideo};
