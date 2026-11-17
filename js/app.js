const $=selector=>document.querySelector(selector);
const form=$("#export-form"),exportButton=$("#export-button"),preset=$("#preset"),fps=$("#fps"),duration=$("#duration"),speed=$("#speed");
const statusPill=$("#status-pill"),progressText=$("#progress-text"),progressValue=$("#progress-value"),progressBar=$("#progress-bar"),stepText=$("#step-text"),fileText=$("#file-text"),message=$("#message");
const folderInput=$("#project-folder"),musicInput=$("#music-file");
const presets={portrait:{width:1080,height:1920,label:"1080 × 1920"},landscape:{width:1920,height:1080,label:"1920 × 1080"},square:{width:1080,height:1080,label:"1080 × 1080"}};
let workspaceId=null,musicPath="",pollingTimer=null;
function setStatus(type,label){statusPill.className="status-pill "+type;statusPill.textContent=label;}
function showMessage(text,type=""){message.textContent=text;message.className="message "+type;}
function setProgress(value,label){const n=Math.max(0,Math.min(100,Math.round(Number(value)||0)));progressBar.style.width=n+"%";progressValue.textContent=n+"%";if(label)progressText.textContent=label;}
function formatSeconds(value){const s=Math.max(0,Math.round(value));return s>=60?Math.floor(s/60)+"分"+(s%60?String(s%60)+"秒":""):s+"秒";}
function updateEstimate(){$("#resolution-label").textContent=presets[preset.value].label;const base=Number(duration.value)||0,multiplier=Number(speed.value)||1;$("#actual-duration").textContent=formatSeconds(base/multiplier);}
[preset,duration,speed].forEach(el=>el.addEventListener("change",updateEstimate));duration.addEventListener("input",updateEstimate);
$("#choose-folder").addEventListener("click",()=>folderInput.click());
$("#choose-music").addEventListener("click",()=>musicInput.click());
async function requestJson(url,options={}){const response=await fetch(url,options);const data=await response.json();if(!response.ok)throw new Error(data.error||"请求失败");return data;}
async function uploadProject(files){
 const created=await requestJson("/api/workspaces",{method:"POST"}),id=created.workspaceId;
 const rootName=files[0].webkitRelativePath.split("/")[0];let done=0;
 const normalized=files.map(file=>({file,relative:file.webkitRelativePath.split("/").slice(1).join("/")})).filter(item=>item.relative);
 for(let i=0;i<normalized.length;i+=4){
  await Promise.all(normalized.slice(i,i+4).map(async item=>{
   const url="/api/workspaces/"+encodeURIComponent(id)+"/file?path="+encodeURIComponent(item.relative);
   const response=await fetch(url,{method:"PUT",headers:{"Content-Type":"application/octet-stream"},body:item.file});
   const result=await response.json();if(!response.ok)throw new Error(result.error||"上传文件失败："+item.relative);done++;
  }));
  $("#folder-name").textContent=rootName+" · 正在导入 "+done+"/"+normalized.length;
 }
 await requestJson("/api/workspaces/"+encodeURIComponent(id)+"/complete",{method:"POST"});
 return {workspaceId:id,fileCount:done,sourceName:"index.html",rootName};
}
folderInput.addEventListener("change",async()=>{
 const files=[...folderInput.files];if(!files.length)return;
 $("#folder-name").textContent="准备导入 "+files.length+" 个文件……";$("#source-path").value="";workspaceId=null;musicPath="";
 $("#choose-folder").disabled=true;$("#choose-music").disabled=true;showMessage("正在导入完整项目文件夹，文件较多时请稍候……");
 try{const result=await uploadProject(files);workspaceId=result.workspaceId;$("#folder-name").textContent=result.rootName+" · 导入完成（"+result.fileCount+" 个文件）";$("#music-name").textContent="未选择音乐";showMessage("项目导入成功，已识别根目录 index.html。");}
 catch(error){showMessage(error.message,"error");}
 finally{$("#choose-folder").disabled=false;$("#choose-music").disabled=false;}
});
musicInput.addEventListener("change",async()=>{
 const file=musicInput.files[0];if(!file)return;
 if(!workspaceId){showMessage("请先选择并导入邀请函项目文件夹，再选择音乐。","error");musicInput.value="";return;}
 $("#music-name").textContent=file.name+" · 正在导入";$("#choose-music").disabled=true;
 try{const url="/api/workspaces/"+encodeURIComponent(workspaceId)+"/music?name="+encodeURIComponent(file.name);await requestJson(url,{method:"PUT",headers:{"Content-Type":"application/octet-stream"},body:file});musicPath="";$("#music-name").textContent=file.name+" · 已导入";showMessage("背景音乐已导入。");}
 catch(error){showMessage(error.message,"error");}
 finally{$("#choose-music").disabled=false;}
});
function showResult(result){
 const panel=$("#result-panel"),video=$("#result-video"),download=$("#download-link"),open=$("#open-video");
 $("#poster-preview").hidden=true;
 const url=result.outputUrl+"?v="+Date.now();video.pause();video.src=url;video.load();download.href=result.outputUrl;download.download=result.outputName;download.textContent="下载 "+result.outputName;open.onclick=()=>window.open(result.outputUrl,"_blank","noopener");panel.hidden=false;
}
async function pollJob(jobId){
 try{const response=await fetch("/api/jobs/"+encodeURIComponent(jobId));const result=await response.json();if(!response.ok)throw new Error(result.error||"无法获取任务状态");
 setProgress(result.progress,result.message);stepText.textContent=result.stepLabel||"处理中";fileText.textContent=result.outputName||"生成中";
 if(result.status==="completed"){clearInterval(pollingTimer);pollingTimer=null;exportButton.disabled=false;setStatus("success","导出完成");setProgress(100,"视频已生成");showMessage("导出成功。现在可以直接在下方播放、拖动进度或下载 MP4。","success");showResult(result);}
 if(result.status==="failed"){clearInterval(pollingTimer);pollingTimer=null;exportButton.disabled=false;setStatus("error","导出失败");showMessage(result.error||"导出失败，请查看服务端终端日志。","error");}
 }catch(error){clearInterval(pollingTimer);pollingTimer=null;exportButton.disabled=false;setStatus("error","连接中断");showMessage(error.message,"error");}
}
form.addEventListener("submit",async event=>{
 event.preventDefault();if(pollingTimer)clearInterval(pollingTimer);
 const presetConfig=presets[preset.value],baseDuration=Number(duration.value),multiplier=Number(speed.value),finalDuration=baseDuration/multiplier,sourcePath=$("#source-path").value.trim();
 if(!workspaceId&&!sourcePath){showMessage("请先选择项目文件夹，或填写 HTML 文件完整路径。","error");return;}
 if(!Number.isFinite(finalDuration)||finalDuration<5||finalDuration>300){showMessage("按当前播放速度计算，最终视频时长必须在 5～300 秒之间。","error");return;}
 const payload={workspaceId,sourcePath,duration:Number(finalDuration.toFixed(3)),fps:Number(fps.value),width:presetConfig.width,height:presetConfig.height,outputName:$("#output-name").value.trim()};
 exportButton.disabled=true;$("#result-panel").hidden=true;$("#poster-preview").hidden=false;setStatus("running","准备导出");setProgress(0,"正在提交任务");stepText.textContent="检查参数";fileText.textContent=payload.outputName;showMessage("正在连接本地导出服务……");
 try{const result=await requestJson("/api/export",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});setStatus("running","正在导出");showMessage("任务已启动。正在按设定速度逐帧渲染，请保持服务运行。");pollingTimer=setInterval(()=>pollJob(result.jobId),700);await pollJob(result.jobId);}
 catch(error){exportButton.disabled=false;setStatus("error","启动失败");showMessage(error.message,"error");}
});
updateEstimate();
