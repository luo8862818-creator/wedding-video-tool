const $=selector=>document.querySelector(selector);
const form=$("#export-form"),exportButton=$("#export-button"),preset=$("#preset"),fps=$("#fps");
const statusPill=$("#status-pill"),progressText=$("#progress-text"),progressValue=$("#progress-value"),progressBar=$("#progress-bar");
const stepText=$("#step-text"),fileText=$("#file-text"),message=$("#message");
const folderInput=$("#project-folder"),singleHtmlInput=$("#single-html-file"),musicInput=$("#music-file"),sourcePathInput=$("#source-path");
const presets={
 portrait:{width:1080,height:1920,label:"1080 × 1920"},
 landscape:{width:1920,height:1080,label:"1920 × 1080"},
 square:{width:1080,height:1080,label:"1080 × 1080"}
};
let workspaceId=null,pollingTimer=null,isImporting=false;

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
 let data={};
 try{data=await response.json();}catch(_){}
 if(!response.ok)throw new Error(data.error||"上传文件失败");
 return data;
}
async function createWorkspace(){
 const result=await requestJson("/api/workspaces",{method:"POST"});
 return result.workspaceId;
}
async function completeWorkspace(id){
 return requestJson("/api/workspaces/"+encodeURIComponent(id)+"/complete",{method:"POST"});
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
   const details=[dimensions,(item.fps||"-")+" FPS",formatSeconds(item.duration),item.frameCount?item.frameCount+" 帧":"帧数未知"].join(" · ");
   return '<article class="history-item"><div class="history-top"><strong>'+escapeHtml(item.outputName||"未命名视频")+'</strong><span class="history-status '+(item.status==="completed"?"done":"failed")+'">'+status+'</span></div><div class="history-meta">'+escapeHtml(date)+' · 导出耗时 <b>'+formatElapsed(item.elapsedMs)+'</b></div><div class="history-meta">'+escapeHtml(details)+' · 输出帧率 '+escapeHtml(item.avgFps||"-")+'</div>'+(item.error?'<div class="history-error">'+escapeHtml(item.error)+'</div>':"")+'</article>';
  }).join("");
 }catch(error){
  list.innerHTML='<span class="history-empty">读取历史记录失败：'+escapeHtml(error.message)+'</span>';
 }
}
$("#refresh-history")?.addEventListener("click",loadHistory);

preset.addEventListener("change",()=>{
 $("#resolution-label").textContent=presets[preset.value].label;
});
$("#resolution-label").textContent=presets[preset.value].label;

$("#choose-html").addEventListener("click",()=>singleHtmlInput.click());
$("#choose-folder").addEventListener("click",()=>folderInput.click());
$("#choose-music").addEventListener("click",()=>musicInput.click());

singleHtmlInput.addEventListener("change",async()=>{
 const file=singleHtmlInput.files[0];
 if(!file)return;
 workspaceId=null;folderInput.value="";sourcePathInput.value="";musicInput.value="";isImporting=true;
 exportButton.disabled=true;
 $("#choose-html").disabled=true;$("#choose-folder").disabled=true;$("#choose-music").disabled=true;
 $("#html-file-name").textContent=file.name+" · 正在导入";
 $("#folder-name").textContent="未选择项目文件夹";
 $("#music-name").textContent="未选择音乐";
 showMessage("正在导入单个 HTML 文件……");
 try{
  const id=await createWorkspace();
  await uploadBinary("/api/workspaces/"+encodeURIComponent(id)+"/file?path=index.html",file);
  await completeWorkspace(id);
  workspaceId=id;
  $("#html-file-name").textContent=file.name+" · 导入完成";
  showMessage("HTML 文件导入成功。单文件模式不包含它引用的外部图片、字体、CSS 或 JS；如果网页依赖这些资源，请改用完整文件夹导入。","success");
 }catch(error){
  workspaceId=null;$("#html-file-name").textContent=file.name+" · 导入失败";
  showMessage(error.message,"error");
 }finally{
  isImporting=false;singleHtmlInput.value="";
  exportButton.disabled=false;$("#choose-html").disabled=false;$("#choose-folder").disabled=false;$("#choose-music").disabled=false;
 }
});

async function uploadProject(files){
 const id=await createWorkspace();
 const rootName=files[0].webkitRelativePath.split("/")[0];
 const normalized=files.map(file=>({file,relative:file.webkitRelativePath.split("/").slice(1).join("/")})).filter(item=>item.relative);
 if(!normalized.some(item=>/^index\.html$/i.test(item.relative)))throw new Error("所选文件夹根目录没有 index.html。请确认选择的是邀请函项目文件夹，而不是它的上一级或下一级目录。");
 let done=0;
 for(let i=0;i<normalized.length;i+=4){
  await Promise.all(normalized.slice(i,i+4).map(async item=>{
   const url="/api/workspaces/"+encodeURIComponent(id)+"/file?path="+encodeURIComponent(item.relative);
   await uploadBinary(url,item.file);done++;
  }));
  $("#folder-name").textContent=rootName+" · 正在导入 "+done+"/"+normalized.length;
 }
 await completeWorkspace(id);
 return {workspaceId:id,fileCount:done,rootName};
}

folderInput.addEventListener("change",async()=>{
 const files=[...folderInput.files];
 if(!files.length)return;
 workspaceId=null;singleHtmlInput.value="";sourcePathInput.value="";musicInput.value="";isImporting=true;
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
  showMessage("项目导入成功，已识别根目录 index.html。","success");
 }catch(error){
  workspaceId=null;$("#folder-name").textContent="导入失败";
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
 $("#poster-preview").hidden=true;
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
  stepText.textContent=result.stepLabel||"处理中";
  fileText.textContent=result.outputName||"生成中";
  $("#elapsed-text").textContent=formatElapsed(result.elapsedMs);
  if(result.duration!==null&&result.duration!==undefined)$("#video-duration").textContent=formatSeconds(result.duration);
  else if(result.metrics?.recordingSeconds)$("#video-duration").textContent="录制中 · "+formatSeconds(result.metrics.recordingSeconds);
  if(result.status==="completed"){
   clearInterval(pollingTimer);pollingTimer=null;exportButton.disabled=false;
   setStatus("success","导出完成");setProgress(100,"视频已生成");
   $("#video-duration").textContent=formatSeconds(result.duration);
   showMessage("导出成功。视频已按网页实际播放节奏生成，可以直接播放、拖动进度或下载 MP4。","success");
   showResult(result);loadHistory();
  }
  if(result.status==="failed"){
   clearInterval(pollingTimer);pollingTimer=null;exportButton.disabled=false;
   setStatus("error","导出失败");showMessage(result.error||"导出失败，请查看服务端终端日志。","error");
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
 exportButton.disabled=true;$("#result-panel").hidden=true;$("#poster-preview").hidden=false;
 setStatus("running","准备录制");setProgress(0,"正在启动浏览器");
 stepText.textContent="等待网页播放";fileText.textContent=payload.outputName;
 $("#video-duration").textContent="等待录制";
 $("#elapsed-text").textContent="00:00";
 showMessage("任务已启动。工具正在打开网页并等待其自动播放，不需要提前检测或填写时长。请保持本地服务运行。");
 try{
  const result=await requestJson("/api/export",{
   method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)
  });
  setStatus("running","真实播放录制");
  pollingTimer=setInterval(()=>pollJob(result.jobId),500);
  await pollJob(result.jobId);
 }catch(error){
  exportButton.disabled=false;setStatus("error","启动失败");showMessage(error.message,"error");
 }
});

loadHistory();
