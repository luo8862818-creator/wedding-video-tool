const fs=require("node:fs");
const {spawn}=require("node:child_process");
const ffmpegPath=require("ffmpeg-static");

function startVideoEncoder({outputPath,fps,duration,musicPath,expectedFrames,onProgress}){
 if(!ffmpegPath||!fs.existsSync(ffmpegPath))throw new Error("没有找到 FFmpeg 可执行文件。请检查 ffmpeg-static 是否安装完整。");
 const args=[
  "-y","-hide_banner","-loglevel","error","-nostats",
  "-f","image2pipe","-vcodec","mjpeg","-framerate",String(fps),"-i","pipe:0"
 ];
 if(musicPath)args.push("-stream_loop","-1","-i",musicPath);
 args.push("-t",String(duration),"-map","0:v:0");
 if(musicPath)args.push("-map","1:a:0");
 args.push("-frames:v",String(expectedFrames||Math.ceil(duration*fps)));
 args.push("-c:v","libx264","-preset","veryfast","-crf","20","-pix_fmt","yuv420p");
 if(musicPath)args.push("-c:a","aac","-b:a","192k","-af","apad");
 args.push("-movflags","+faststart","-progress","pipe:2",outputPath);

 const child=spawn(ffmpegPath,args,{windowsHide:true,stdio:["pipe","ignore","pipe"]});
 let stderr="",closed=false,closeError=null,reportedFrames=0;
 child.stderr.on("data",chunk=>{
  const text=chunk.toString();
  stderr=(stderr+text).slice(-16000);
  const matches=[...stderr.matchAll(/(?:^|\n)frame=(\d+)/g)];
  if(matches.length)reportedFrames=Number(matches[matches.length-1][1])||reportedFrames;
 });
 const done=new Promise((resolve,reject)=>{
  child.once("error",error=>{closeError=new Error("无法启动 FFmpeg："+error.message);});
  child.once("close",code=>{
   closed=true;
   const expected=expectedFrames||Math.ceil(duration*fps);
   if(code===0&&fs.existsSync(outputPath)){
    const size=fs.statSync(outputPath).size;
    if(size<=0)return reject(new Error("FFmpeg 已退出，但输出 MP4 文件为空。"));
    if(reportedFrames!==expected){
     return reject(new Error("视频帧数校验失败：期望 "+expected+" 帧，FFmpeg 实际报告 "+reportedFrames+" 帧。请检查输入帧管道。"));
    }
    onProgress?.(100);
    resolve({frames:reportedFrames,size});
   }else reject(closeError||new Error("FFmpeg 合成失败（退出码 "+code+"）。"+stderr.slice(-4000)));
  });
 });
 async function writeFrame(buffer){
  if(closed||child.stdin.destroyed)throw closeError||new Error("FFmpeg 已提前退出，无法继续接收画面。");
  if(!child.stdin.write(buffer)){
   await new Promise((resolve,reject)=>{
    const onDrain=()=>{cleanup();resolve();};
    const onError=error=>{cleanup();reject(error);};
    const cleanup=()=>{child.stdin.off("drain",onDrain);child.stdin.off("error",onError);};
    child.stdin.once("drain",onDrain);child.stdin.once("error",onError);
   });
  }
 }
 async function finish(){child.stdin.end();return done;}
 async function abort(error){
  if(!closed){child.stdin.destroy();child.kill();}
  try{await done;}catch(_){}
  throw error;
 }
 return {writeFrame,finish,abort};
}
module.exports={startVideoEncoder};
