const express=require("express");
const path=require("node:path");
const fs=require("node:fs");
const os=require("node:os");
const multer=require("multer");
const {randomUUID}=require("node:crypto");
const {renderVideo}=require("./render");
const app=express(),HOST="127.0.0.1",PORT=Number(process.env.PORT||3000);
const ROOT=path.resolve(__dirname,".."),OUTPUT_DIR=path.join(ROOT,"output"),WORKSPACE_DIR=path.join(ROOT,"workspaces"),UPLOAD_TMP=path.join(os.tmpdir(),"wedding-video-uploads");
const jobs=new Map(),workspaces=new Map();let activeJobId=null;
fs.mkdirSync(OUTPUT_DIR,{recursive:true});fs.mkdirSync(WORKSPACE_DIR,{recursive:true});fs.mkdirSync(UPLOAD_TMP,{recursive:true});
app.use(express.json({limit:"1mb"}));app.use(express.static(ROOT,{index:"index.html",dotfiles:"ignore"}));
const upload=multer({dest:UPLOAD_TMP,preservePath:true,limits:{files:600,fileSize:150*1024*1024}});
function fail(res,status,error){return res.status(status).json({error});}
function safeRelativePath(name){const normalized=String(name).replace(/\\/g,"/").replace(/^([A-Za-z]:)?\/?/,"");const parts=normalized.split("/").filter(Boolean);if(!parts.length||parts.some(part=>part==="."||part===".."))throw new Error("上传文件包含不安全的路径。");return parts;}
function moveUploaded(file,destination){fs.mkdirSync(path.dirname(destination),{recursive:true});fs.renameSync(file.path,destination);}
app.get("/api/health",(_req,res)=>res.json({ok:true,service:"wedding-video-tool"}));
app.post("/api/upload-project",upload.array("files",600),(req,res)=>{
 const files=req.files||[];if(!files.length)return fail(res,400,"没有收到项目文件。");
 const workspaceId=randomUUID(),workspacePath=path.join(WORKSPACE_DIR,workspaceId);fs.mkdirSync(workspacePath,{recursive:true});
 try{
  let rootName=null;const entries=[];
  for(const file of files){const parts=safeRelativePath(file.originalname);if(!rootName)rootName=parts.shift();else if(parts[0]===rootName)parts.shift();if(!parts.length)continue;const relative=parts.join(path.sep),destination=path.resolve(workspacePath,relative);if(!destination.startsWith(workspacePath+path.sep))throw new Error("文件路径超出项目目录。");moveUploaded(file,destination);entries.push(relative);}
  const indexCandidates=entries.filter(item=>item.toLowerCase()==="index.html");
  if(indexCandidates.length!==1)throw new Error("项目根目录必须且只能有一个 index.html。请选择完整项目文件夹，不要只选择 assets 子目录。");
  const sourcePath=path.join(workspacePath,"index.html");workspaces.set(workspaceId,{path:workspacePath,sourcePath,musicPath:null});
  res.json({workspaceId,sourceName:"index.html",fileCount:entries.length});
 }catch(error){fs.rmSync(workspacePath,{recursive:true,force:true});for(const file of files)if(fs.existsSync(file.path))fs.rmSync(file.path,{force:true});return fail(res,400,error.message);}
});
app.post("/api/upload-music/:workspaceId",upload.single("music"),(req,res)=>{
 const workspace=workspaces.get(req.params.workspaceId);if(!workspace){if(req.file)fs.rmSync(req.file.path,{force:true});return fail(res,404,"项目工作区不存在，请重新选择项目文件夹。");}
 if(!req.file)return fail(res,400,"没有收到音乐文件。");
 try{const ext=path.extname(req.file.originalname).replace(/[^.a-zA-Z0-9]/g,"").slice(0,12)||".audio";const destination=path.join(workspace.path,"__selected_music__"+ext);moveUploaded(req.file,destination);workspace.musicPath=destination;res.json({musicPath:destination});}
 catch(error){return fail(res,500,"音乐文件导入失败："+error.message);}
});
app.post("/api/export",async(req,res)=>{
 if(activeJobId)return fail(res,409,"当前已有导出任务，请等待完成后再试。");
 const body=req.body||{},workspace=body.workspaceId?workspaces.get(body.workspaceId):null;
 const source=workspace?workspace.sourcePath:(typeof body.sourcePath==="string"?path.resolve(body.sourcePath.trim()):"");
 const music=workspace?.musicPath||(typeof body.musicPath==="string"&&body.musicPath.trim()?path.resolve(body.musicPath.trim()):null);
 if(!source||path.extname(source).toLowerCase()!==".html"||!fs.existsSync(source)||!fs.statSync(source).isFile())return fail(res,400,"找不到 HTML 文件。请重新选择项目文件夹或检查路径。");
 if(music&&(!fs.existsSync(music)||!fs.statSync(music).isFile()))return fail(res,400,"找不到背景音乐文件，请重新选择。");
 const seconds=Number(body.duration),frameRate=Number(body.fps),width=Number(body.width),height=Number(body.height);
 if(!Number.isFinite(seconds)||seconds<5||seconds>300)return fail(res,400,"最终视频时长必须是 5～300 秒。");
 if(![25,30,60].includes(frameRate))return fail(res,400,"帧率仅支持 25、30 或 60 FPS。");
 if(![1080,1920].includes(width)||![1080,1920].includes(height)||width===height&&width!==1080)return fail(res,400,"视频尺寸不受支持。");
 const safeName=path.basename(String(body.outputName||"wedding-invitation.mp4")).replace(/[^\\w\\-.\\u4e00-\\u9fa5]/g,"_");
 const finalName=safeName.toLowerCase().endsWith(".mp4")?safeName:safeName+".mp4",jobId=randomUUID();
 const job={id:jobId,status:"running",progress:0,stepLabel:"启动浏览器",message:"正在准备渲染",outputName:finalName,outputUrl:"/api/output/"+encodeURIComponent(finalName),error:null};
 jobs.set(jobId,job);activeJobId=jobId;res.status(202).json({jobId});
 renderVideo({sourcePath:source,musicPath:music,outputPath:path.join(OUTPUT_DIR,finalName),duration:seconds,fps:frameRate,width,height,onProgress:(progress,stepLabel,message)=>Object.assign(job,{progress,stepLabel,message})})
 .then(()=>Object.assign(job,{status:"completed",progress:100,stepLabel:"完成",message:"视频已生成"}))
 .catch(error=>{job.status="failed";job.error=error.message||"未知导出错误";job.stepLabel="导出失败";console.error("[export:"+jobId+"]",error);})
 .finally(()=>{activeJobId=null;});
});
app.get("/api/jobs/:id",(req,res)=>{const job=jobs.get(req.params.id);if(!job)return fail(res,404,"任务不存在或服务已重启。");res.json(job);});
app.get("/api/output/:name",(req,res)=>{const name=path.basename(req.params.name),filePath=path.join(OUTPUT_DIR,name);if(!fs.existsSync(filePath))return fail(res,404,"输出文件不存在。");res.sendFile(filePath);});
app.listen(PORT,HOST,()=>{console.log("==========================================");console.log(" Wedding Video Tool 已启动");console.log(" 本地地址：http://"+HOST+":"+PORT);console.log(" 输出目录："+OUTPUT_DIR);console.log(" 按 Ctrl + C 停止服务");console.log("==========================================");});
