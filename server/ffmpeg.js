const fs=require("node:fs");
const {spawn}=require("node:child_process");
const ffmpegPath=require("ffmpeg-static");

function startVideoEncoder({outputPath,fps,duration,musicPath,onProgress}){
 if(!ffmpegPath||!fs.existsSync(ffmpegPath))throw new Error("没有找到 FFmpeg 可执行文件。请检查 ffmpeg-static 是否安装完整。");
 const args=[
  "-y","-hide_banner","-loglevel","error",
  "-f","image2pipe","-vcodec","mjpeg","-framerate",String(fps),"-i","pipe:0"
 ];
 if(musicPath)args.push("-stream_loop","-1","-i",musicPath);
 args.push("-t",String(duration),"-map","0:v:0");
 if(musicPath)args.push("-map","1:a:0");
 args.push("-c:v","libx264","-preset","veryfast","-crf","20","-pix_fmt","yuv420p");
 if(musicPath)args.push("-c:a","aac","-b:a","192k","-af","apad");
 args.push("-movflags","+faststart",outputPath);

 const child=spawn(ffmpegPath,args,{windowsHide:true,stdio:["pipe","ignore","pipe"]});
 let stderr="",closed=false,closeError=null;
 child.stderr.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-12000);});
 const done=new Promise((resolve,reject)=>{
  child.once("error",error=>{closeError=new Error("无法启动 FFmpeg："+error.message);});
  child.once("close",code=>{
   closed=true;
   if(code===0&&fs.existsSync(outputPath)){onProgress?.(100);resolve();}
   else reject(closeError||new Error("FFmpeg 合成失败（退出码 "+code+"）。"+stderr.slice(-3000)));
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
