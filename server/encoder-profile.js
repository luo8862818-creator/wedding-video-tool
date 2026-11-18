const os=require('node:os');
const fs=require('node:fs');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {performance}=require('node:perf_hooks');
const config=require('../config/video.config');
const encoderNames=['libx264','h264_nvenc','h264_qsv','h264_amf','h264_mf'];
function command(binary,args,{signal,timeout=15000}={}){
 return new Promise((resolve,reject)=>execFile(binary,args,{windowsHide:true,signal,timeout,maxBuffer:4*1024*1024},(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));
}
function threadConfig(){
 const requestedThreads=String(process.env.WEDDING_FFMPEG_THREADS||'auto').trim().toLowerCase();
 if(requestedThreads!=='auto'&&(!/^\d+$/.test(requestedThreads)||Number(requestedThreads)<1||Number(requestedThreads)>256))throw Error('WEDDING_FFMPEG_THREADS 必须为 auto 或 1～256');
 return {requestedThreads,threadValue:requestedThreads==='auto'?'0':requestedThreads,cpuLogicalCores:os.cpus().length};
}
function frameConfig(overrides={}){
 const format=(overrides.format??process.env.WEDDING_FRAME_FORMAT??'png').toLowerCase();
 if(!['png','webp','jpeg'].includes(format))throw Error('WEDDING_FRAME_FORMAT 必须为 png、webp 或 jpeg');
 const quality=Number(overrides.quality??process.env.WEDDING_FRAME_QUALITY??100);
 if(!Number.isInteger(quality)||quality<1||quality>100)throw Error('WEDDING_FRAME_QUALITY 必须为 1～100');
 const queueSize=Number(process.env.WEDDING_FRAME_QUEUE_SIZE||4);
 if(!Number.isInteger(queueSize)||queueSize<1||queueSize>16)throw Error('WEDDING_FRAME_QUEUE_SIZE 必须为 1～16');
 return {format,requestedFormat:format,quality:format==='png'?null:quality,queueSize,queueMaxBytes:64*1024*1024,decoder:{png:'png',webp:'webp',jpeg:'mjpeg'}[format]};
}
function softwareProfile(binary){
 const threads=threadConfig(),crf=config.crf??18,preset=config.preset||'veryfast';
 return {name:'libx264',kind:'software',binary,preset,crf,pixelFormat:'yuv420p',...threads,args:['-c:v','libx264','-preset',preset,'-threads',threads.threadValue,'-crf',String(crf),'-profile:v','high','-pix_fmt','yuv420p']};
}
function hardwareProfiles(binary){
 const threads=threadConfig();
 return [
  {name:'h264_nvenc',preset:'p4',pixelFormat:'yuv420p',args:['-c:v','h264_nvenc','-preset','p4','-cq','18','-b:v','0','-pix_fmt','yuv420p']},
  {name:'h264_qsv',preset:'veryfast',pixelFormat:'nv12',args:['-c:v','h264_qsv','-preset','veryfast','-global_quality','18','-pix_fmt','nv12']},
  {name:'h264_amf',preset:'speed',pixelFormat:'nv12',args:['-c:v','h264_amf','-quality','speed','-rc','cqp','-qp_i','18','-qp_p','18','-pix_fmt','nv12']},
  {name:'h264_mf',preset:'quality',pixelFormat:'nv12',args:['-c:v','h264_mf','-rate_control','quality','-quality','90','-pix_fmt','nv12']}
 ].map(p=>({...p,binary,kind:'hardware',crf:null,...threads}));
}
async function selectOfflineEncoder(binary,{width,height,fps,signal,logger,forceSoftware=false,requestedEncoder}){
 const requested=forceSoftware?'software':(requestedEncoder||process.env.WEDDING_ENCODER||'auto');
 if(!['auto','software','hardware',...encoderNames].includes(requested))throw Error('未知的 WEDDING_ENCODER：'+requested);
 let software=softwareProfile(process.env.FFMPEG_SOFTWARE_PATH||binary),compiled=[];
 try{const r=await command(binary,['-hide_banner','-encoders'],{signal});compiled=[...r.stdout.matchAll(/^\s*V\S*\s+(\S+)\s+/gm)].map(m=>m[1]);}
 catch(error){if(signal?.aborted)throw error;logger.warn('编码器能力列表读取失败',{code:error.code||'unknown'});}
 if(!compiled.includes('libx264')&&!process.env.FFMPEG_SOFTWARE_PATH){const fallback=require('ffmpeg-static');if(fallback&&fs.existsSync(fallback))software=softwareProfile(fallback);}
 const availableEncoders=encoderNames.map(name=>({name,compiled:compiled.includes(name),runtimeValidated:name==='libx264'?null:false}));
 logger.info('FFmpeg 编码器能力',{requested,availableEncoders,softwareFallbackUsesBundledBinary:software.binary!==binary,defaultPolicy:'auto retains libx264 until real-page speed/quality/compatibility benchmark is accepted'});
 if(['auto','software','libx264'].includes(requested))return {...software,availableEncoders,benchmarkStatus:'hardware-not-selected',requested};
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wedding-encoder-probe-'));
 const probes=[];
 try{
  const candidates=hardwareProfiles(binary).filter(p=>compiled.includes(p.name)&&(requested==='hardware'||requested===p.name));
  for(const p of candidates){
   const output=path.join(directory,p.name+'.mp4');const start=performance.now();
   try{
    const input=`testsrc2=size=${width}x${height}:rate=${fps}`;
    await command(binary,['-y','-v','error','-f','lavfi','-i',input,'-frames:v','8','-an',...p.args,output],{signal,timeout:15000});
    const encodeMs=performance.now()-start;
    await command(binary,['-v','error','-xerror','-err_detect','explode','-i',output,'-f','null','-'],{signal});
    const quality=await command(binary,['-hide_banner','-v','info','-f','lavfi','-i',input,'-i',output,'-lavfi','[0:v][1:v]ssim','-frames:v','8','-an','-f','null','-'],{signal});
    const match=quality.stderr.match(/All:([\d.]+)/);const ssim=match?Number(match[1]):null;
    if(ssim===null||ssim<.99)throw Error('synthetic-quality-gate-failed');
    probes.push({name:p.name,ok:true,encodeMs,ssim,decodeValidated:true,compatibility:'local FFmpeg decode; target players not yet benchmarked'});
    const entry=availableEncoders.find(e=>e.name===p.name);entry.runtimeValidated=true;
    logger.info('显式硬件编码探测',{probes,scope:'8 synthetic frames; not proof of sustained real-page speed or cross-player quality'});
    return {...p,availableEncoders,probes,requested,benchmarkStatus:'synthetic-only-explicit-opt-in'};
   }catch(error){if(signal?.aborted)throw error;probes.push({name:p.name,ok:false,reason:error.killed?'probe-timeout':error.code||error.message.slice(0,120)});}
  }
  logger.warn('硬件探测未通过，回退软件编码',{requested,probes});
  return {...software,availableEncoders,probes,requested,benchmarkStatus:'hardware-failed-software-fallback'};
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
}
module.exports={threadConfig,frameConfig,softwareProfile,selectOfflineEncoder,command};
