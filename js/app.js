const $=selector=>document.querySelector(selector);
const form=$("#export-form"),exportButton=$("#export-button"),preset=$("#preset"),fps=$("#fps");
const statusPill=$("#status-pill"),progressText=$("#progress-text"),progressValue=$("#progress-value"),progressBar=$("#progress-bar");
const stepText=$("#step-text"),fileText=$("#file-text"),message=$("#message");
const folderInput=$("#project-folder"),singleHtmlInput=$("#single-html-file"),musicInput=$("#music-file"),sourcePathInput=$("#source-path");
const invitationPreview=$("#invitation-preview"),previewViewport=$("#preview-viewport"),posterPreview=$("#poster-preview"),resultPanel=$("#result-panel");
const previewStatus=$("#preview-status"),reloadPreviewButton=$("#reload-preview"),openPreviewButton=$("#open-preview");
let previewUrl=null,previewBaseUrl=null;
const presets={
 portrait:{width:1080,height:1920,label:"1080 × 1920"},
 landscape:{width:1920,height:1080,label:"1920 × 1080"},
 square:{width:1080,height:1080,label:"1080 × 1080"}
};
let workspaceId=null,pollingTimer=null,isImporting=false;

function setWorkspaceName(name){
 const element=$("#workspace-name");
 if(element)element.textContent=name||"尚未载入项目";
}

function setPreviewStatus(label,state=""){
 if(!previewStatus)return;
 previewStatus.textContent=label;
 previewStatus.className="preview-status"+(state?" "+state:"");
}

function updatePreviewPreset(){
 if(!invitationPreview||!previewViewport)return;
 const target=presets[preset.value];
 const stage=previewViewport.parentElement;
 const availableWidth=Math.max(180,Math.min((stage?.clientWidth||700)-52,560));
 const availableHeight=Math.max(220,Math.min(window.innerHeight-230,620));
 const scale=Math.min(1,availableWidth/target.width,availableHeight/target.height);
 previewViewport.style.width=Math.round(target.width*scale)+"px";
 previewViewport.style.height=Math.round(target.height*scale)+"px";
 invitationPreview.style.width=target.width+"px";
 invitationPreview.style.height=target.height+"px";
 invitationPreview.style.transform="scale("+scale+")";
 invitationPreview.style.transformOrigin="top left";
}

function hideLivePreview(){
 previewUrl=null;previewBaseUrl=null;
 if(invitationPreview){
  invitationPreview.dataset.previewUrl="";
  invitationPreview.src="about:blank";
 }
 if(previewViewport)previewViewport.hidden=true;
 if(posterPreview)posterPreview.hidden=false;
 if(reloadPreviewButton)reloadPreviewButton.disabled=true;
 if(openPreviewButton)openPreviewButton.disabled=true;
 setPreviewStatus("等待导入");
}

function showLivePreview(){
 if(!workspaceId||!previewUrl||!invitationPreview)return false;
 resultPanel.hidden=true;
 if(invitationPreview.src==="about:blank"){invitationPreview.dataset.previewUrl=previewUrl;invitationPreview.src=previewUrl;}
 posterPreview.hidden=true;
 previewViewport.hidden=false;
 updatePreviewPreset();
 return true;
}

function loadWorkspacePreview(id,baseUrl){
 if(!id||!invitationPreview)return;
 if(!baseUrl){
  setPreviewStatus("预览服务未启动","error");
  return;
 }
 previewBaseUrl=baseUrl.endsWith("/")?baseUrl:baseUrl+"/";
 const url=previewBaseUrl+"?preview="+Date.now();
 previewUrl=url;
 invitationPreview.dataset.previewUrl=url;
 invitationPreview.onload=()=>{
  if(invitationPreview.dataset.previewUrl!==url)return;
  try{
   const doc=invitationPreview.contentDocument;
   const bodyText=(doc?.body?.innerText||"").trim();
   if(doc&&/Preview resource not found|Not Found/i.test(bodyText)){
    setPreviewStatus("页面资源未找到","error");
   }else{
    setPreviewStatus("实时预览已载入","ready");
   }
  }catch(_){
   // 预览运行在独立本地端口，浏览器会按同源策略隔离 iframe；load 事件可确认主文档已打开。
   setPreviewStatus("网页已打开","ready");
  }
  reloadPreviewButton.disabled=false;
  openPreviewButton.disabled=false;
 };
 invitationPreview.onerror=()=>{
  if(invitationPreview.dataset.previewUrl===url)setPreviewStatus("预览加载失败","error");
 };
 previewViewport.hidden=false;
 posterPreview.hidden=true;
 resultPanel.hidden=true;
 if(reloadPreviewButton)reloadPreviewButton.disabled=true;
 if(openPreviewButton)openPreviewButton.disabled=true;
 setPreviewStatus("正在加载邀请函","loading");
 updatePreviewPreset();
 invitationPreview.src=url;
}

function refreshWorkspacePreview(){
 if(!workspaceId||!previewBaseUrl)return;
 loadWorkspacePreview(workspaceId,previewBaseUrl);
}
window.addEventListener("resize",updatePreviewPreset);

reloadPreviewButton?.addEventListener("click",()=>{
 if(showLivePreview())refreshWorkspacePreview();
});
openPreviewButton?.addEventListener("click",()=>{
 if(previewBaseUrl)window.open(previewBaseUrl,"_blank","noopener,noreferrer");
});

document.querySelectorAll(".sidebar-link").forEach(link=>{
 link.addEventListener("click",event=>{
  event.preventDefault();
  const target=document.querySelector(link.getAttribute("href"));
  if(!target)return;
  document.querySelectorAll(".sidebar-link").forEach(item=>item.classList.remove("active"));
  link.classList.add("active");
  target.scrollIntoView({behavior:"smooth",block:"start"});
 });
});

function setStatus(type,label){statusPill.className="status-pill "+type;statusPill.textContent=label;}
function showMessage(text,type=""){message.textContent=text;message.className="message "+type;}
function setProgress(value,label){
 const n=Math.max(0,Math.min(100,Math.round(Number(value)||0)));
 progressBar.style.width=n+"%";progressValue.textContent=n+"%";
 if(label)progressText.textContent=label;
}
function formatSeconds(value){
 const seconds=Number(value);
 if(!Number.isFinite(seconds)||seconds<0)return "—";
 return seconds.toFixed(2).replace(/\.?0+$/,"")+" 秒";
}
function formatElapsed(ms){
 const total=Math.max(0,Math.floor((Number(ms)||0)/1000));
 const h=Math.floor(total/3600),m=Math.floor(total%3600/60),s=total%60;
 return h?String(h).padStart(2,"0")+":"+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0"):String(m).padStart(2,"0")+":"+String(s).padStart(2,"0");
}
function escapeHtml(value){
 return String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
}
async function requestJson(url,options={}){
 const response=await fetch(url,options);
 let data={};
 try{data=await response.json();}catch(_){}
 if(!response.ok)throw new Error(data.error||"请求失败");
 return data;
}
async function uploadBinary(url,file){
 const response=await fetch(url,{method:"PUT",headers:{"Content-Type":"application/octet-stream"},body:file});
 const responseText=await response.text();
 let data={};
 try{data=responseText?JSON.parse(responseText):{};}catch(_){}
 if(!response.ok){
  const detail=data.error||responseText.slice(0,240)||("HTTP "+response.status);
  throw new Error(detail);
 }
 return data;
}
async function createWorkspace(){
 const result=await requestJson("/api/workspaces",{method:"POST"});
 return result.workspaceId;
}
async function completeWorkspace(id){
 return requestJson("/api/workspaces/"+encodeURIComponent(id)+"/complete",{method:"POST"});
}
async function deleteWorkspace(id){
 return requestJson("/api/workspaces/"+encodeURIComponent(id),{method:"DELETE"});
}
function clearProjectLabels(){
 $("#html-file-name").textContent="尚未选择 HTML 文件";
 $("#folder-name").textContent="尚未选择项目文件夹";
 $("#music-name").textContent="未选择音乐";
 musicInput.value="";
}

async function loadHistory(){
 const list=$("#history-list");
 if(!list)return;
 try{
  const data=await requestJson("/api/history");
  if(!data.items?.length){
   list.innerHTML='<span class="history-empty">暂无导出记录，完成第一次导出后会自动记录。</span>';
   return;
  }
  list.innerHTML=data.items.slice(0,10).map(item=>{
   const date=item.startedAt?new Date(item.startedAt).toLocaleString():"时间未知";
   const status=item.status==="completed"?"成功":"失败";
   const dimensions=item.width&&item.height?item.width+" × "+item.height:"尺寸未知";
   const capture=item.metrics?.captureWidth&&item.metrics?.captureHeight
    ?("采集 "+item.metrics.captureWidth+" × "+item.metrics.captureHeight+(item.metrics.nativeResolution?" · 原生采集":" · 缩放采集"))
    :"";
   const details=[dimensions,capture,(item.fps||"-")+" FPS",formatSeconds(item.duration),item.frameCount?item.frameCount+" 帧":"帧数未知"].filter(Boolean).join(" · ");
   return '<article class="history-item"><div class="history-top"><strong>'+escapeHtml(item.outputName||"未命名视频")+'</strong><span class="history-status '+(item.status==="completed"?"done":"failed")+'">'+status+'</span></div><div class="history-meta">'+escapeHtml(date)+' · 导出耗时 <b>'+formatElapsed(item.elapsedMs)+'</b></div><div class="history-meta">'+escapeHtml(details)+' · 输出帧率 '+escapeHtml(item.avgFps||"-")+'</div>'+(item.error?'<div class="history-error">'+escapeHtml(item.error)+'</div>':"")+(item.logUrl?'<a class="history-log-link" href="'+escapeHtml(item.logUrl)+'" download>下载诊断日志</a>':"")+'</article>';
  }).join("");
 }catch(error){
  list.innerHTML='<span class="history-empty">读取历史记录失败：'+escapeHtml(error.message)+'</span>';
 }
}
$("#refresh-history")?.addEventListener("click",loadHistory);

preset.addEventListener("change",()=>{
 $("#resolution-label").textContent=presets[preset.value].label;
 updatePreviewPreset();
});
$("#resolution-label").textContent=presets[preset.value].label;
updatePreviewPreset();

$("#choose-html").addEventListener("click",()=>singleHtmlInput.click());
$("#choose-folder").addEventListener("click",()=>folderInput.click());
$("#choose-music").addEventListener("click",()=>musicInput.click());

singleHtmlInput.addEventListener("change",async()=>{
 const file=singleHtmlInput.files[0];
 if(!file)return;
 workspaceId=null;folderInput.value="";sourcePathInput.value="";musicInput.value="";isImporting=true;
 hideLivePreview();
 exportButton.disabled=true;
 $("#choose-html").disabled=true;$("#choose-folder").disabled=true;$("#choose-music").disabled=true;
 $("#html-file-name").textContent=file.name+" · 正在导入";
 $("#folder-name").textContent="未选择项目文件夹";
 $("#music-name").textContent="未选择音乐";
 showMessage("正在导入单个 HTML 文件……");
 let id=null;
 try{
  id=await createWorkspace();
  await uploadBinary("/api/workspaces/"+encodeURIComponent(id)+"/file?path=index.html",file);
  const completed=await completeWorkspace(id);
  workspaceId=id;
  $("#html-file-name").textContent=file.name+" · 导入完成";
  setWorkspaceName(file.name);
  loadWorkspacePreview(workspaceId,completed.previewUrl);
  showMessage("HTML 文件导入成功，中央区域正在加载实时预览。单文件模式不包含它引用的外部图片、字体、CSS 或 JS；如果网页依赖这些资源，请改用完整文件夹导入。","success");
 }catch(error){
  if(id)await deleteWorkspace(id).catch(()=>{});
  workspaceId=null;$("#html-file-name").textContent=file.name+" · 导入失败";
  setWorkspaceName("项目导入失败");
  hideLivePreview();
  showMessage(error.message,"error");
 }finally{
  isImporting=false;singleHtmlInput.value="";
  exportButton.disabled=false;$("#choose-html").disabled=false;$("#choose-folder").disabled=false;$("#choose-music").disabled=false;
 }
});

const ignoredUploadDirs=new Set([
 ".git","node_modules","output","workspaces","temp","frames",
 ".vscode",".cache","coverage","logs"
]);
const maxUploadFileBytes=150*1024*1024;
function shouldSkipUploadPath(relative){
 const parts=relative.split("/").filter(Boolean);
 if(parts.some(part=>ignoredUploadDirs.has(part.toLowerCase())))return true;
 const name=parts[parts.length-1]||"";
 return ["thumbs.db","desktop.ini",".ds_store"].includes(name.toLowerCase());
}
async function uploadProject(files){
 const firstFile=files.find(file=>file.webkitRelativePath);
 if(!firstFile)throw new Error("浏览器没有提供文件夹相对路径，请使用 Chrome 或 Edge 重新选择文件夹。");
 const selectedRootName=firstFile.webkitRelativePath.split("/")[0];
 let normalized=files.map(file=>({
  file,
  relative:(file.webkitRelativePath||"").split("/").filter(Boolean).slice(1).join("/")
 })).filter(item=>item.relative&&!shouldSkipUploadPath(item.relative));

 let projectPrefix="";
 if(!normalized.some(item=>/^index\.html$/i.test(item.relative))){
  const candidates=normalized.filter(item=>/^[^/]+\/index\.html$/i.test(item.relative));
  if(candidates.length===1){
   projectPrefix=candidates[0].relative.slice(0,candidates[0].relative.lastIndexOf("/")+1);
   normalized=normalized
    .filter(item=>item.relative.startsWith(projectPrefix))
    .map(item=>({...item,relative:item.relative.slice(projectPrefix.length)}));
  }
 }
 if(!normalized.some(item=>/^index\.html$/i.test(item.relative))){
  throw new Error("没有找到项目根目录的 index.html。请直接选择包含 index.html 的 wedding-invitation 文件夹；如果选择上一级目录，系统只会在唯一子项目中自动识别。");
 }
 const oversized=normalized.find(item=>item.file.size>maxUploadFileBytes);
 if(oversized){
  const size=(oversized.file.size/1024/1024).toFixed(1);
  throw new Error("文件超过单文件 150 MB 上传限制："+oversized.relative+"（"+size+" MB）。请先移除不需要的大文件后再导入。");
 }
 if(normalized.length>3000){
  throw new Error("项目文件数量为 "+normalized.length+"，超过 3000 个文件的导入上限。请移除缓存、依赖或生成目录后再导入。");
 }

 const id=await createWorkspace();
 const displayRootName=selectedRootName+(projectPrefix?"/"+projectPrefix.slice(0,-1):"");
 try{
  let done=0;
  for(let i=0;i<normalized.length;i+=4){
   const batch=normalized.slice(i,i+4);
   const results=await Promise.allSettled(batch.map(async item=>{
    try{
     const url="/api/workspaces/"+encodeURIComponent(id)+"/file?path="+encodeURIComponent(item.relative);
     await uploadBinary(url,item.file);
    }catch(error){
     throw new Error(item.relative+"："+error.message);
    }
   }));
   const failures=results.filter(result=>result.status==="rejected");
   done+=results.length-failures.length;
   $("#folder-name").textContent=displayRootName+" · 正在导入 "+done+"/"+normalized.length;
   if(failures.length){
    const details=failures.slice(0,5).map(result=>result.reason.message).join("\n");
    throw new Error("以下文件上传失败：\n"+details+(failures.length>5?"\n另有 "+(failures.length-5)+" 个文件失败。":""));
   }
  }
  const completed=await completeWorkspace(id);
  return {workspaceId:id,fileCount:done,rootName:displayRootName,skippedCount:files.length-normalized.length,previewUrl:completed.previewUrl};
 }catch(error){
  await deleteWorkspace(id).catch(()=>{});
  throw error;
 }
}

folderInput.addEventListener("change",async()=>{
 const files=[...folderInput.files];
 if(!files.length)return;
 workspaceId=null;singleHtmlInput.value="";sourcePathInput.value="";musicInput.value="";isImporting=true;
 hideLivePreview();
 exportButton.disabled=true;
 $("#choose-html").disabled=true;$("#choose-folder").disabled=true;$("#choose-music").disabled=true;
 $("#folder-name").textContent="准备导入 "+files.length+" 个文件……";
 $("#html-file-name").textContent="未选择 HTML 文件";
 $("#music-name").textContent="未选择音乐";
 showMessage("正在导入完整项目文件夹，文件较多时请稍候……");
 try{
  const result=await uploadProject(files);
  workspaceId=result.workspaceId;
  $("#folder-name").textContent=result.rootName+" · 导入完成（"+result.fileCount+" 个文件）";
  setWorkspaceName(result.rootName);
  loadWorkspacePreview(workspaceId,result.previewUrl);
  showMessage("项目导入成功，中央区域正在加载真实网页预览。"+(result.skippedCount?" 已忽略 "+result.skippedCount+" 个 Git、输出、缓存或项目外文件。":""),"success");
 }catch(error){
  workspaceId=null;$("#folder-name").textContent="导入失败";
  setWorkspaceName("项目导入失败");
  hideLivePreview();
  showMessage(error.message,"error");
 }finally{
  isImporting=false;folderInput.value="";
  exportButton.disabled=false;$("#choose-html").disabled=false;$("#choose-folder").disabled=false;$("#choose-music").disabled=false;
 }
});

sourcePathInput.addEventListener("input",()=>{
 if(sourcePathInput.value.trim()){
  workspaceId=null;
  $("#html-file-name").textContent="使用本机路径";
  $("#folder-name").textContent="使用本机路径";
  setWorkspaceName(sourcePathInput.value.trim().split(/[\\/]/).pop());
  hideLivePreview();
  setPreviewStatus("本机路径模式不提供预览");
 }
});

musicInput.addEventListener("change",async()=>{
 const file=musicInput.files[0];
 if(!file)return;
 if(!workspaceId){
  showMessage("请先导入单个 HTML 文件或完整项目文件夹，再选择背景音乐。","error");
  musicInput.value="";return;
 }
 $("#music-name").textContent=file.name+" · 正在导入";
 $("#choose-music").disabled=true;
 try{
  const url="/api/workspaces/"+encodeURIComponent(workspaceId)+"/music?name="+encodeURIComponent(file.name);
  await uploadBinary(url,file);
  $("#music-name").textContent=file.name+" · 已导入";
  showMessage("背景音乐已导入，导出时会与网页实际播放时长同步结束。","success");
 }catch(error){
  $("#music-name").textContent=file.name+" · 导入失败";
  showMessage(error.message,"error");
 }finally{
  musicInput.value="";
  $("#choose-music").disabled=false;
 }
});

function showResult(result){
 const panel=$("#result-panel"),video=$("#result-video"),download=$("#download-link"),open=$("#open-video");
 posterPreview.hidden=true;
 previewViewport.hidden=true;
 setPreviewStatus("成片已生成","ready");
 const url=result.outputUrl+"?v="+Date.now();
 video.pause();video.src=url;video.load();
 download.href=result.outputUrl;download.download=result.outputName;download.textContent="下载 "+result.outputName;
 open.onclick=()=>window.open(result.outputUrl,"_blank","noopener");
 panel.hidden=false;
}

async function pollJob(jobId){
 try{
  const response=await fetch("/api/jobs/"+encodeURIComponent(jobId));
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||"无法获取任务状态");
  setProgress(result.progress,result.message);
  if(result.logUrl){
   const logLink=$("#log-download-link");
   logLink.href=result.logUrl;
   logLink.download="wedding-video-"+jobId+".log";
   logLink.hidden=false;
  }
  stepText.textContent=result.stepLabel||"处理中";
  fileText.textContent=result.outputName||"生成中";
  $("#elapsed-text").textContent=formatElapsed(result.elapsedMs);
  if(result.duration!==null&&result.duration!==undefined)$("#video-duration").textContent=formatSeconds(result.duration);
  else if(result.metrics?.recordingSeconds)$("#video-duration").textContent="录制中 · "+formatSeconds(result.metrics.recordingSeconds);
  if(result.status==="completed"){
   reloadPreviewButton.disabled=false;openPreviewButton.disabled=false;
   clearInterval(pollingTimer);pollingTimer=null;exportButton.disabled=false;
   setStatus("success","导出完成");setProgress(100,"视频已生成");
   $("#video-duration").textContent=formatSeconds(result.duration);
   const captureInfo=result.metrics?.captureWidth&&result.metrics?.captureHeight
    ?("原始采集："+result.metrics.captureWidth+" × "+result.metrics.captureHeight+(result.metrics.nativeResolution?"（原生高清采集）。":"（采集后缩放）。"))
    :"";
   const captureStats=result.metrics?.captureStats;
   const qualityInfo=captureStats?(" 编码器："+result.metrics.encoder+"；源画面采集约 "+captureStats.sourceFps+" FPS；队列丢帧 "+captureStats.droppedSourceFrames+"。源帧率包含停顿与静止画面，输出 FPS 不单独代表流畅度。 "):"";
   showMessage("导出成功。"+captureInfo+qualityInfo+"可以播放或下载 MP4。","success");
   showResult(result);loadHistory();
  }
  if(result.status==="failed"){
   reloadPreviewButton.disabled=false;openPreviewButton.disabled=false;
   clearInterval(pollingTimer);pollingTimer=null;exportButton.disabled=false;
   setStatus("error","导出失败");
   if(!showLivePreview())posterPreview.hidden=false;
   showMessage(result.error||"导出失败。请下载本次诊断日志排查原因。","error");
   loadHistory();
  }
 }catch(error){
  clearInterval(pollingTimer);pollingTimer=null;exportButton.disabled=false;
  setStatus("error","连接中断");showMessage(error.message,"error");
 }
}

form.addEventListener("submit",async event=>{
 event.preventDefault();
 if(isImporting){showMessage("文件仍在导入，请等待导入完成后再开始导出。","error");return;}
 if(pollingTimer)clearInterval(pollingTimer);
 const presetConfig=presets[preset.value],sourcePath=sourcePathInput.value.trim();
 if(!workspaceId&&!sourcePath){
  showMessage("请先选择单个 HTML 文件、完整项目文件夹，或填写 HTML 文件完整路径。","error");return;
 }
 const payload={
  workspaceId,sourcePath,fps:Number(fps.value),
  width:presetConfig.width,height:presetConfig.height,
  outputName:$("#output-name").value.trim()
 };
 exportButton.disabled=true;
 resultPanel.hidden=true;
 // Do not render a second live invitation and an old result video during export.
 $("#result-video").pause();
 invitationPreview.dataset.previewUrl="";invitationPreview.src="about:blank";
 previewViewport.hidden=true;posterPreview.hidden=false;
 reloadPreviewButton.disabled=true;openPreviewButton.disabled=true;
 setPreviewStatus("导出中 · 预览暂时停止","loading");
 setStatus("running","准备录制");setProgress(0,"正在启动浏览器");
 stepText.textContent="等待网页播放";fileText.textContent=payload.outputName;
 $("#video-duration").textContent="等待录制";
 $("#elapsed-text").textContent="00:00";
 showMessage("任务已启动。工具正在打开网页并等待其自动播放，不需要提前检测或填写时长。请保持本地服务运行。");
 try{
  const result=await requestJson("/api/export",{
   method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)
  });
  setStatus("running","正在导出视频");
  pollingTimer=setInterval(()=>pollJob(result.jobId),500);
  await pollJob(result.jobId);
 }catch(error){
  exportButton.disabled=false;reloadPreviewButton.disabled=false;openPreviewButton.disabled=false;showLivePreview();setStatus("error","启动失败");showMessage(error.message,"error");
 }
});

loadHistory();

