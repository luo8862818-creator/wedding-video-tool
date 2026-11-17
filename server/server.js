const express=require("express");
const path=require("node:path");
const fs=require("node:fs");
const {randomUUID}=require("node:crypto");
const {renderVideo}=require("./render");
const {createFileLogger}=require("./logger");
const app=express(),HOST="127.0.0.1",PORT=Number(process.env.PORT||3000);
const ROOT=path.resolve(__dirname,".."),OUTPUT_DIR=path.join(ROOT,"output"),WORKSPACE_DIR=path.join(ROOT,"workspaces"),LOG_DIR=path.join(OUTPUT_DIR,"logs");
const jobs=new Map(),workspaces=new Map();let activeJobId=null;
const HISTORY_FILE=path.join(OUTPUT_DIR,"export-history.json");
fs.mkdirSync(OUTPUT_DIR,{recursive:true});fs.mkdirSync(WORKSPACE_DIR,{recursive:true});fs.mkdirSync(LOG_DIR,{recursive:true});
const serverLogger=createFileLogger(path.join(LOG_DIR,"server.log"));

function readHistory(){
 try{const data=JSON.parse(fs.readFileSync(HISTORY_FILE,"utf8"));return Array.isArray(data)?data:[];}
 catch(error){if(error.code!=="ENOENT")serverLogger.warn("无法读取导出历史记录",{message:error.message});return [];}
}
function writeHistory(records){
 const temp=HISTORY_FILE+".tmp";
 fs.writeFileSync(temp,JSON.stringify(records.slice(0,100),null,2),"utf8");
 fs.renameSync(temp,HISTORY_FILE);
}
function saveHistory(job){
 const records=readHistory();
 records.unshift({
  id:job.id,status:job.status,startedAt:job.startedAt,finishedAt:job.finishedAt,
  elapsedMs:job.elapsedMs,elapsedSeconds:Number((job.elapsedMs/1000).toFixed(1)),
  outputName:job.outputName,duration:job.duration,fps:job.fps,width:job.width,height:job.height,
  frameCount:job.frameCount,avgFps:job.avgFps,metrics:job.metrics||null,music:job.music,error:job.error||null,
   logUrl:job.logUrl||null
 });
 writeHistory(records);
}
function fail(res,status,error){return res.status(status).json({error});}
function resolveInside(root,relative){
 const normalized=String(relative||"").replace(/\\/g,"/");
 if(!normalized||normalized.startsWith("/")||/^[a-zA-Z]:/.test(normalized))throw new Error("文件路径不合法。");
 const parts=normalized.split("/").filter(Boolean);
 if(!parts.length||parts.some(part=>part==="."||part===".."))throw new Error("文件路径包含不安全内容。");
 const target=path.resolve(root,...parts);
 if(!target.startsWith(root+path.sep))throw new Error("文件路径超出项目目录。");
 return target;
}

app.use(express.json({limit:"1mb"}));
app.use(express.static(ROOT,{index:"index.html",dotfiles:"ignore"}));
app.get("/api/health",(_req,res)=>res.json({ok:true,service:"wedding-video-tool"}));
app.get("/api/history",(_req,res)=>res.json({items:readHistory()}));

app.post("/api/workspaces",(_req,res)=>{
 const id=randomUUID(),workspacePath=path.join(WORKSPACE_DIR,id);
 fs.mkdirSync(workspacePath,{recursive:true});
 workspaces.set(id,{path:workspacePath,sourcePath:path.join(workspacePath,"index.html"),musicPath:null,fileCount:0,ready:false});
 res.status(201).json({workspaceId:id});
});
app.delete("/api/workspaces/:id",(req,res)=>{
 const workspace=workspaces.get(req.params.id);
 if(!workspace)return res.json({ok:true});
 try{
  fs.rmSync(workspace.path,{recursive:true,force:true});
  workspaces.delete(req.params.id);
  res.json({ok:true});
 }catch(error){
  return fail(res,500,"清理导入失败的临时项目时出错："+error.message);
 }
});
app.put("/api/workspaces/:id/file",express.raw({type:"application/octet-stream",limit:"150mb"}),(req,res)=>{
 const workspace=workspaces.get(req.params.id);
 if(!workspace)return fail(res,404,"项目工作区不存在，请重新选择文件。");
 if(!Buffer.isBuffer(req.body)||req.body.length===0)return fail(res,400,"上传文件内容为空。");
 try{
  const relativePath=String(req.query.path||"").replace(/\\/g,"/");
  const ignoredSegments=new Set([".git","node_modules","output","workspaces","temp","frames",".vscode",".cache","coverage","logs"]);
  if(relativePath.split("/").some(part=>ignoredSegments.has(part.toLowerCase()))){
   return fail(res,400,"无需导入 Git、依赖、缓存或导出目录："+relativePath);
  }
  const destination=resolveInside(workspace.path,relativePath);
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.writeFileSync(destination,req.body);
  workspace.fileCount++;workspace.ready=false;
  res.json({ok:true});
 }catch(error){return fail(res,400,error.message);}
});
app.post("/api/workspaces/:id/complete",(req,res)=>{
 const workspace=workspaces.get(req.params.id);
 if(!workspace)return fail(res,404,"项目工作区不存在。");
 if(!fs.existsSync(workspace.sourcePath))return fail(res,400,"没有找到 index.html。单文件导入会自动保存为 index.html；文件夹导入时请确保它位于所选文件夹根目录。");
 workspace.ready=true;
 res.json({ok:true,fileCount:workspace.fileCount,sourceName:"index.html"});
});
app.put("/api/workspaces/:id/music",express.raw({type:"application/octet-stream",limit:"150mb"}),(req,res)=>{
 const workspace=workspaces.get(req.params.id);
 if(!workspace)return fail(res,404,"项目工作区不存在，请先导入 HTML 文件或项目文件夹。");
 if(!Buffer.isBuffer(req.body)||req.body.length===0)return fail(res,400,"音乐文件内容为空。");
 const ext=path.extname(String(req.query.name||"music.mp3")).toLowerCase().replace(/[^.a-z0-9]/g,"").slice(0,10)||".mp3";
 const destination=path.join(workspace.path,"selected-music"+ext);
 try{fs.writeFileSync(destination,req.body);workspace.musicPath=destination;res.json({ok:true});}
 catch(error){return fail(res,500,"音乐文件保存失败："+error.message);}
});

app.post("/api/export",async(req,res)=>{
 if(activeJobId)return fail(res,409,"当前已有导出任务，请等待完成后再试。");
 const body=req.body||{},workspace=body.workspaceId?workspaces.get(body.workspaceId):null;
 if(body.workspaceId&&(!workspace||!workspace.ready))return fail(res,400,"所选文件尚未导入完成，请重新选择。");
 const source=workspace?workspace.sourcePath:(typeof body.sourcePath==="string"?path.resolve(body.sourcePath.trim()):"");
 const music=workspace?.musicPath||(typeof body.musicPath==="string"&&body.musicPath.trim()?path.resolve(body.musicPath.trim()):null);
 if(!source||path.extname(source).toLowerCase()!==".html"||!fs.existsSync(source)||!fs.statSync(source).isFile())return fail(res,400,"找不到 HTML 文件。请先选择单个 HTML 文件或项目文件夹。");
 if(music&&(!fs.existsSync(music)||!fs.statSync(music).isFile()))return fail(res,400,"找不到背景音乐文件，请重新选择。");
 const frameRate=Number(body.fps),width=Number(body.width),height=Number(body.height);
 if(![25,30,60].includes(frameRate))return fail(res,400,"帧率仅支持 25、30 或 60 FPS。");
 if(![1080,1920].includes(width)||![1080,1920].includes(height)||width===height&&width!==1080)return fail(res,400,"视频尺寸不受支持。");
 const safeName=path.basename(String(body.outputName||"wedding-invitation.mp4")).replace(/[^\w\-. \u4e00-\u9fa5]/g,"_").trim();
 const finalName=(safeName||"wedding-invitation").toLowerCase().endsWith(".mp4")?(safeName||"wedding-invitation.mp4"):(safeName||"wedding-invitation")+".mp4";
 const jobId=randomUUID(),startedAt=new Date().toISOString();
 const logPath=path.join(LOG_DIR,jobId+".log");
 const logger=createFileLogger(logPath);
 const job={
  id:jobId,status:"running",progress:0,stepLabel:"启动浏览器",message:"正在准备真实网页录制",
  outputName:finalName,outputUrl:"/api/output/"+encodeURIComponent(finalName),
  logUrl:"/api/logs/"+jobId,
  error:null,startedAt,startedAtMs:Date.now(),duration:null,playbackRate:1,
  fps:frameRate,width,height,frameCount:null,avgFps:null,music:Boolean(music),metrics:null
 };
 jobs.set(jobId,job);activeJobId=jobId;
 logger.info("导出任务开始",{
  jobId,sourcePath:source,musicSelected:Boolean(music),fps:frameRate,
  output:{width,height,file:finalName},nodeVersion:process.version,logPath
 });
 res.status(202).json({jobId,logUrl:job.logUrl});
 renderVideo({
  sourcePath:source,musicPath:music,outputPath:path.join(OUTPUT_DIR,finalName),
  fps:frameRate,width,height,logger,
  onProgress:(progress,stepLabel,message,metrics)=>{
   Object.assign(job,{progress,stepLabel,message});
   if(metrics){
    job.metrics={...(job.metrics||{}),...metrics};
    if(Number.isFinite(metrics.durationSeconds))job.duration=metrics.durationSeconds;
    if(Number.isFinite(metrics.frames))job.frameCount=metrics.frames;
    if(Number.isFinite(metrics.avgFps))job.avgFps=metrics.avgFps;
   }
  }
 })
 .then(()=>{Object.assign(job,{status:"completed",progress:100,stepLabel:"完成",message:"视频已生成"});})
 .catch(error=>{
  job.status="failed";job.error=error.message||"未知导出错误";job.stepLabel="导出失败";
  logger.error("导出任务失败",{message:job.error,stack:error.stack||""});
 })
 .finally(async()=>{
  job.finishedAt=new Date().toISOString();
  job.elapsedMs=Math.max(0,Date.now()-job.startedAtMs);
  if(!job.avgFps&&job.frameCount&&job.duration)job.avgFps=Number((job.frameCount/job.duration).toFixed(2));
  logger.info("导出任务结束",{
   status:job.status,elapsedMs:job.elapsedMs,duration:job.duration,
   outputName:job.outputName,outputPath:path.join(OUTPUT_DIR,finalName),
   error:job.error||null,logPath
  });
  try{saveHistory(job);}catch(error){logger.error("保存导出历史记录失败",{message:error.message});}
  activeJobId=null;
  await logger.close();
 });
});

app.get("/api/logs/:id",(req,res)=>{
 const id=String(req.params.id||"");
 if(!/^[0-9a-f-]{36}$/i.test(id))return fail(res,400,"日志编号不合法。");
 const filePath=path.join(LOG_DIR,id+".log");
 if(!fs.existsSync(filePath))return fail(res,404,"没有找到本次任务的诊断日志。");
 res.download(filePath,"wedding-video-"+id+".log",error=>{
  if(error&&!res.headersSent)serverLogger.error("下载任务日志失败",{id,message:error.message});
 });
});

app.get("/api/jobs/:id",(req,res)=>{
 const job=jobs.get(req.params.id);
 if(!job)return fail(res,404,"任务不存在或服务已重启。");
 const elapsedMs=job.status==="running"?Date.now()-job.startedAtMs:(job.elapsedMs||0);
 res.json({...job,elapsedMs,elapsedSeconds:Number((elapsedMs/1000).toFixed(1))});
});
app.get("/api/output/:name",(req,res)=>{
 const name=path.basename(req.params.name),filePath=path.join(OUTPUT_DIR,name);
 if(!fs.existsSync(filePath))return fail(res,404,"输出文件不存在。");
 res.sendFile(filePath);
});
app.use((error,req,res,next)=>{
 if(res.headersSent)return next(error);
 const status=Number(error.status||error.statusCode)||500;
 const message=status===413
  ?"单个文件超过 150 MB 上传限制。请移除大型视频、缓存或 Git 历史文件后重新导入。"
  :(error.message||"服务器处理请求失败。");
 serverLogger.error("HTTP 请求处理失败",{method:req.method,url:req.originalUrl,status,message});
 res.status(status).json({error:message});
});

app.listen(PORT,HOST,()=>{
 serverLogger.info("Wedding Video Tool 已启动",{address:"http://"+HOST+":"+PORT,outputDir:OUTPUT_DIR,logDir:LOG_DIR});
});
