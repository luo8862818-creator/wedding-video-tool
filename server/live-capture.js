const fs=require("node:fs");
const path=require("node:path");
const {spawn}=require("node:child_process");
const {performance}=require("node:perf_hooks");
const config=require("../config/video.config");

function makeAbortError(signal){
 const error=new Error(signal?.reason?.message||"导出任务已停止。");
 error.name="AbortError";error.code="ABORT_ERR";
 return error;
}
function throwIfAborted(signal){
 if(signal?.aborted)throw makeAbortError(signal);
}

// Consume native screencast JPEGs. No screenshot(), DOM clock control or PNG round-trip.
// Timestamp resampling preserves wall-clock pauses; CFR must not speed up sparse input.
class CaptureQueue{
 constructor(fps,{maxFrames=fps*2,maxBytes=32*1024*1024,onOverflow="drop"}={}){
  this.fps=fps;this.maxFrames=maxFrames;this.maxBytes=maxBytes;this.onOverflow=onOverflow;this.items=[];this.bytes=0;
  this.ended=false;this.startMs=null;this.endMs=null;this.wake=null;
  this.stats={sourceFrames:0,sampledSourceFrames:0,outputFrames:0,repeatedFrames:0,droppedSourceFrames:0,maxSourceGapMs:0,maxQueueBytes:0};
 }
 start(time=Date.now()){this.startMs=time;}
 push(frame){
  if(this.ended)return;
  const time=Number(frame.timestamp);if(!Buffer.isBuffer(frame.data)||!Number.isFinite(time))throw Error("无效的连续录屏帧");
  if(this.startMs===null)this.startMs=time;
  if(this.lastTime!==undefined&&time<this.lastTime)return;
  if(this.lastTime!==undefined)this.stats.maxSourceGapMs=Math.max(this.stats.maxSourceGapMs,time-this.lastTime);
  this.firstTime??=time;this.lastTime=time;this.stats.sourceFrames++;
  const slot=Math.ceil((time-this.startMs)*this.fps/1000-1e-6);
  const last=this.items[this.items.length-1];
  if(last&&last.slot===slot){this.bytes-=this.items.pop().data.length;this.stats.sampledSourceFrames++;}
  this.items.push({...frame,slot});this.bytes+=frame.data.length;
  while(this.items.length>1&&(this.items.length>this.maxFrames||this.bytes>this.maxBytes)){
   this.bytes-=this.items.shift().data.length;this.stats.droppedSourceFrames++;
  }
  if(this.stats.droppedSourceFrames&&this.onOverflow==="error")throw Error("编码器跟不上实时采集，已停止导出以避免生成卡顿视频。请设置 WEDDING_ENCODER=software 后重试，或改用 30 FPS。");
  this.stats.maxQueueBytes=Math.max(this.stats.maxQueueBytes,this.bytes);
  this.wake?.();this.wake=null;
 }
 stop(time=Date.now()){if(this.ended)return;this.ended=true;this.endMs=time;this.wake?.();this.wake=null;}
 snapshot(){
  const span=(this.lastTime||0)-(this.firstTime||0);
  return {...this.stats,sourceFps:span>0?Number(((this.stats.sourceFrames-1)*1000/span).toFixed(2)):0,
   repeatedFrameRatio:this.stats.outputFrames?Number((this.stats.repeatedFrames/this.stats.outputFrames).toFixed(4)):0};
 }
 async *[Symbol.asyncIterator](){
  let previous=null;
  while(!this.ended||this.items.length){
   if(!this.items.length){await new Promise(resolve=>this.wake=resolve);continue;}
   const next=this.items.shift();this.bytes-=next.data.length;
   const boundary=Math.max(0,Math.ceil((next.timestamp-this.startMs)*this.fps/1000-1e-6));
   let repetitions=0;
   if(previous)while(this.stats.outputFrames<boundary){
    this.stats.outputFrames++;if(repetitions++)this.stats.repeatedFrames++;yield previous;
   }
   previous=next.data;
  }
  if(!previous)throw Error("浏览器没有输出任何连续录屏画面");
  const total=Math.max(1,Math.ceil((this.endMs-this.startMs)*this.fps/1000-1e-6));let tail=0;
  while(this.stats.outputFrames<total){this.stats.outputFrames++;if(tail++)this.stats.repeatedFrames++;yield previous;}
 }
}

async function probeEncoder(binary,profile,{width,height,fps,directory,sample,signal}){
 const output=path.join(directory,"probe-"+profile.name+".mp4");
 try{return await new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(makeAbortError(signal));return;}
  const input=sample?["-threads","2","-probesize","32","-analyzeduration","0","-fpsprobesize","0","-f","image2pipe","-framerate",String(fps),"-vcodec","mjpeg","-i","pipe:0"]:["-f","lavfi","-i",`testsrc2=size=${width}x${height}:rate=${fps}`];
  const child=spawn(profile.binary||binary,["-y","-v","error",...input,"-frames:v","30","-an",...profile.args,output],{windowsHide:true,stdio:[sample?"pipe":"ignore","ignore","ignore"]});
  let settled=false;
  const finish=(error,value)=>{
   if(settled)return;settled=true;clearTimeout(timer);
   signal?.removeEventListener("abort",abortHandler);
   if(error)reject(error);else resolve(value);
  };
  const timer=setTimeout(()=>child.kill(),5000);
  const abortHandler=()=>{
   if(!child.killed)child.kill();
   finish(makeAbortError(signal));
  };
  signal?.addEventListener("abort",abortHandler,{once:true});
  if(signal?.aborted){abortHandler();return;}
  if(sample){child.stdin.on("error",()=>{});child.stdin.end(Buffer.concat(Array(30).fill(sample)));}
  child.once("error",()=>finish(signal?.aborted?makeAbortError(signal):null,false));
  child.once("close",code=>finish(signal?.aborted?makeAbortError(signal):null,
   code===0&&fs.existsSync(output)&&fs.statSync(output).size>1000));
 });}finally{try{fs.rmSync(output,{force:true});}catch(_){}}
}
async function makeProbeImage(binary,{width,height,signal}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(makeAbortError(signal));return;}
  const chunks=[];const child=spawn(binary,["-v","error","-f","lavfi","-i",`testsrc2=size=${width}x${height}`,"-frames:v","1","-c:v","mjpeg","-q:v","3","-threads","2","-f","image2pipe","pipe:1"],{windowsHide:true,stdio:["ignore","pipe","ignore"]});
  let settled=false;
  const finish=(error,value)=>{
   if(settled)return;settled=true;clearTimeout(timer);
   signal?.removeEventListener("abort",abortHandler);
   if(error)reject(error);else resolve(value);
  };
  const timer=setTimeout(()=>child.kill(),5000);
  const abortHandler=()=>{
   if(!child.killed)child.kill();
   finish(makeAbortError(signal));
  };
  signal?.addEventListener("abort",abortHandler,{once:true});
  if(signal?.aborted){abortHandler();return;}
  child.stdout.on("data",data=>chunks.push(data));
  child.on("error",()=>finish(signal?.aborted?makeAbortError(signal):null,null));
  child.on("close",code=>finish(signal?.aborted?makeAbortError(signal):null,code===0?Buffer.concat(chunks):null));
 });
}
async function selectEncoder(binary,options){
 const {signal}=options;
 throwIfAborted(signal);
 const fallback=process.env.FFMPEG_SOFTWARE_PATH||require("ffmpeg-static");
 const software={name:"libx264",kind:"software",binary:fs.existsSync(fallback||"")?fallback:binary,args:["-c:v","libx264","-preset",config.preset||"veryfast","-crf",String(config.crf??18),"-threads",String(config.threads||2),"-pix_fmt","yuv420p"]};
 const hardware=[
  {name:"h264_nvenc",kind:"hardware",args:["-c:v","h264_nvenc","-preset","p4","-cq","18","-b:v","0","-pix_fmt","yuv420p"]},
  {name:"h264_qsv",kind:"hardware",args:["-c:v","h264_qsv","-preset","veryfast","-global_quality","18","-pix_fmt","nv12"]},
  {name:"h264_amf",kind:"hardware",args:["-c:v","h264_amf","-quality","speed","-rc","cqp","-qp_i","18","-qp_p","18","-pix_fmt","nv12"]}
 ];
 const requested=process.env.WEDDING_ENCODER||"auto";
 if(!["auto","software",...hardware.map(p=>p.name)].includes(requested))throw Error("未知的 WEDDING_ENCODER："+requested);
 const candidates=requested==="software"?[software]:requested==="auto"?[software,...hardware]:[...hardware.filter(p=>p.name===requested),software];
 const sample=await makeProbeImage(binary,options),probes=[],valid=[];
 throwIfAborted(signal);
 for(const profile of candidates){
  throwIfAborted(signal);
  const started=performance.now(),ok=await probeEncoder(binary,profile,{...options,sample});
  const elapsedMs=Math.round(performance.now()-started);probes.push({name:profile.name,kind:profile.kind,ok,elapsedMs});
  if(ok)valid.push({...profile,benchmarkMs:elapsedMs});
 }
 if(!valid.length)throw Error("硬件及 libx264 编码探测均失败，请检查 FFMPEG_PATH 或 ffmpeg-static 安装");
 const fastest=valid.slice().sort((a,b)=>a.benchmarkMs-b.benchmarkMs)[0],cpu=valid.find(p=>p.kind==="software");
 // A small startup win on a synthetic image is not evidence of better sustained
 // capture. Prefer bounded two-thread x264 unless hardware has a clear margin.
 const automatic=cpu&&fastest.kind==="hardware"&&fastest.benchmarkMs>cpu.benchmarkMs*.7?cpu:fastest;
 const chosen=requested==="auto"?automatic:valid[0];
 return {...chosen,probes};
}
module.exports={CaptureQueue,selectEncoder,probeEncoder};
