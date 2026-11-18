(() => {
 const video=document.getElementById('player-video');
 const name=document.getElementById('video-name');
 const stats=document.getElementById('playback-stats');
 const playback=createVideoPlayback(video,stats);
 function load(){
  const file=name.value.trim();
  if(!file||/[\\/]/.test(file)||!file.toLowerCase().endsWith('.mp4')){stats.textContent='请输入 output 目录中的 MP4 文件名';return;}
  const url='/api/output/'+encodeURIComponent(file);
  playback.load(url+'?v='+Date.now());
  const link=document.getElementById('download-video');link.href=url;link.download=file;
  history.replaceState(null,'','player.html?file='+encodeURIComponent(file));
 }
 document.getElementById('player-form').addEventListener('submit',event=>{event.preventDefault();load();});
 const requested=new URLSearchParams(location.search).get('file');
 if(requested)name.value=requested;
 load();
 fetch('/api/history').then(r=>{if(!r.ok)throw Error();return r.json();}).then(data=>{
  const list=document.getElementById('existing-videos');
  const files=new Set((data.items||[]).filter(item=>item.status==='completed').map(item=>item.outputName));
  for(const file of files){const option=document.createElement('option');option.value=file;list.append(option);}
 }).catch(()=>{});
})();
