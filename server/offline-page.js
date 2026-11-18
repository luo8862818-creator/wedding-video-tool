// Runs inside every document, including invitation iframes. Native image/media
// decoders have a separate clock; Playwright Clock alone does not seek them.
function installOfflinePage() {
 const nativeNow=performance.now.bind(performance);
 const tracks=new Map(),animationStarts=new WeakMap(),videoTimes=new WeakMap(),uncontrolled=[];
 let encodedBytes=0,decodedPixels=0;
 function releaseTrack(track){
  track.decoder?.close();
  if(track.blob!==track.source)URL.revokeObjectURL(track.blob);
  encodedBytes-=track.encodedBytes||0;decodedPixels-=track.decodedPixels||0;
 }
 const NativeWorker=window.Worker;
 if(NativeWorker)window.Worker=new Proxy(NativeWorker,{construct(target,args){uncontrolled.push('Worker: '+args[0]);return Reflect.construct(target,args);}});
 for(const name of ['WebSocket','EventSource']){
  const Type=window[name];if(Type)window[name]=new Proxy(Type,{construct(target,args){uncontrolled.push(name+': '+args[0]);return Reflect.construct(target,args);}});
 }
 let logicalTime=0,clockMode=false,clockOrigin=0;
 function collectAnimations(){
  for(const a of document.getAnimations())if(!animationStarts.has(a)){
   if(a.timeline&&a.timeline!==document.timeline)throw Error('发现 CSS 滚动/视图时间轴动画，需要页面提供专用 renderCapture');
   animationStarts.set(a,clockMode?performance.now()-clockOrigin:logicalTime);a.pause();a.currentTime=0;
  }
 }
 // New CSS animations/transitions started by a timer get their virtual origin
 // at the mutation, rather than being incorrectly reset to absolute video time.
 const observer=new MutationObserver(()=>{if(clockMode)collectAnimations();});
 observer.observe(document,{subtree:true,attributes:true,childList:true});
 // Advancing an animated image must not fire the page's onload handler once
 // per video frame (native GIF playback does not do that).
 window.addEventListener('load',event=>{
  const track=tracks.get(event.target);
  if(track?.decoder&&event.target.currentSrc===track.blob)event.stopImmediatePropagation();
 },true);
 async function imageTrack(img,time){
  let track=tracks.get(img);
  const changedSource=track?.decoder&&img.src!==track.source;
  if(changedSource&&img.srcset===track.blob)img.removeAttribute('srcset');
  const source=changedSource||!img.srcset?img.src:(img.currentSrc||img.src);
  if(track&&source!==track.blob&&img.src!==track.blob){releaseTrack(track);tracks.delete(img);track=null;}
  if(track)return track;
  if(!source)return null;
  // Static images are cached too, avoiding a fetch on every output frame.
  const response=await fetch(source).catch(error=>{throw Error('无法读取图片以定位动画帧（请检查资源或跨域权限）：'+source+'；'+error.message);});if(!response.ok)throw Error('图片读取失败：'+source);
  const data=await response.arrayBuffer(),b=new Uint8Array(data);
  const gif=String.fromCharCode(...b.slice(0,3))==='GIF';
  const webp=String.fromCharCode(...b.slice(8,12))==='WEBP';
  const png=String.fromCharCode(...b.slice(1,4))==='PNG';
  if(/svg/i.test(response.headers.get('content-type')||'')&&/<(?:animate\w*|set)\b|@keyframes|animation\s*:/i.test(new TextDecoder().decode(data)))throw Error('SVG 图片内含未受控动画，请转换素材或提供逐帧接口：'+source);
  if(!(gif||webp||png)){await img.decode();track={source,blob:source};tracks.set(img,track);return track;}
  if(typeof ImageDecoder==='undefined')throw Error('浏览器缺少 ImageDecoder，无法保证动图确定性：'+source);
  if(data.byteLength>32*1024*1024||encodedBytes+data.byteLength>64*1024*1024)throw Error('动图超过内存解码预算：'+source);
  const decoder=new ImageDecoder({data,type:gif?'image/gif':webp?'image/webp':'image/png',preferAnimation:true});
  await decoder.tracks.ready;
  const selected=decoder.tracks.selectedTrack;
  if(!selected||selected.frameCount<2){decoder.close();await img.decode();track={source,blob:source};tracks.set(img,track);return track;}
  if(img.srcset){decoder.close();throw Error('响应式动图 srcset 需要页面提供专用 renderCapture：'+source);}
  if([...tracks.values()].filter(t=>t.decoder).length>=32||selected.frameCount>2000){decoder.close();throw Error('动图资源超出逐帧解码预算：'+source);}
  const ends=[];let duration=0,pixels=0;
  try{
   for(let i=0;i<selected.frameCount;i++){
    const {image}=await decoder.decode({frameIndex:i,completeFramesOnly:true});
    if(image.displayWidth*image.displayHeight>4096*4096){image.close();throw Error('动图分辨率超出解码预算：'+source);}
    if(i===0){pixels=image.displayWidth*image.displayHeight*selected.frameCount;if(decodedPixels+pixels>64*1024*1024){image.close();throw Error('动图总解码像素超出预算：'+source);}}
    const ms=image.duration/1000;image.close();if(!(ms>0))throw Error('动图没有有效帧时长：'+source);
    duration+=ms;ends.push(duration);
   }
  }catch(error){decoder.close();throw error;}
  encodedBytes+=data.byteLength;decodedPixels+=pixels;
  track={source,blob:source,decoder,ends,duration,start:time,index:-1,repetitions:selected.repetitionCount,encodedBytes:data.byteLength,decodedPixels:pixels};
  tracks.set(img,track);return track;
 }
 async function renderImages(time){
  const indices=[];
  for(const img of document.images){
   const t=await imageTrack(img,time);if(!t?.decoder)continue;
   let local=Math.max(0,time-t.start),index;
   if(Number.isFinite(t.repetitions)&&local>=t.duration*(t.repetitions+1))index=t.ends.length-1;
   else{local%=t.duration;index=t.ends.findIndex(end=>local<end);}
   if(index!==t.index){
    const {image}=await t.decoder.decode({frameIndex:index,completeFramesOnly:true});
    const canvas=document.createElement('canvas');canvas.width=image.displayWidth;canvas.height=image.displayHeight;
    canvas.getContext('2d').drawImage(image,0,0);image.close();
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    if(!blob)throw Error('无法转换动图帧：'+t.source);
    // Preserve src so the page's img[src=...] styles and source bookkeeping
    // continue to work; an internal single-candidate srcset supplies the frame.
    const previous=t.blob;t.blob=URL.createObjectURL(blob);img.srcset=t.blob;await img.decode();
    if(previous!==t.source)URL.revokeObjectURL(previous);t.index=index;
   }
   indices.push([t.source,index]);
  }
  for(const [img,t] of tracks)if(!img.isConnected){releaseTrack(t);tracks.delete(img);}
  return indices;
 }
 async function renderVideos(time){
  const states=[];
  for(const video of document.querySelectorAll('video')){
   if(video.srcObject)throw Error('不支持实时视频 srcObject，请提供可定位的视频文件');
   if(!video.autoplay&&!video.hasAttribute('data-capture-start-ms'))throw Error('视频需设置 autoplay 或 data-capture-start-ms，才能明确时间起点：'+(video.currentSrc||video.src));
   if(video.readyState<1)await new Promise((resolve,reject)=>{video.addEventListener('loadedmetadata',resolve,{once:true});video.addEventListener('error',()=>reject(Error('视频加载失败：'+video.src)),{once:true});});
   if(!Number.isFinite(video.duration)||video.duration<=0)throw Error('无法定位直播/无时长视频：'+video.currentSrc);
   video.pause();const start=Number(video.dataset.captureStartMs||0);
   if(!Number.isFinite(start))throw Error('data-capture-start-ms 无效');
   let seconds=Math.max(0,time-start)/1000;
   seconds=video.loop?seconds%video.duration:Math.min(seconds,Math.max(0,video.duration-.001));
   const previous=videoTimes.get(video);
   if(!previous||previous.source!==video.currentSrc||Math.abs(video.currentTime-seconds)>.0001||video.readyState<2){
    await new Promise((resolve,reject)=>{
     let sought=false,presented=!video.requestVideoFrameCallback,callbackId;
     const finish=()=>{if(sought&&presented&&video.readyState>=2){cleanup();resolve();}};
     const done=()=>{sought=true;finish();},bad=()=>{cleanup();reject(Error('视频定位解码失败：'+video.currentSrc));};
     const cleanup=()=>{video.removeEventListener('seeked',done);video.removeEventListener('error',bad);if(callbackId!==undefined)video.cancelVideoFrameCallback?.(callbackId);};
     video.addEventListener('seeked',done);video.addEventListener('error',bad);
     if(video.requestVideoFrameCallback)callbackId=video.requestVideoFrameCallback(()=>{presented=true;finish();});
     video.currentTime=seconds;
    });
   }
   if(video.readyState<2)throw Error('视频目标帧尚未解码：'+video.currentSrc);
   videoTimes.set(video,{source:video.currentSrc,time:seconds});
   states.push([video.currentSrc,seconds]);
  }
  return states;
 }
 window.__offlinePage={
  now:nativeNow,
  async prepare({clock=false,playerOwned=false}={}){
   clockMode=clock;
   clockOrigin=performance.now();
   await document.fonts.ready;
   await Promise.all([...document.images].map(img=>{img.loading='eager';return img.decode();}));
   if(!playerOwned&&document.querySelector('canvas'))throw Error('普通网页包含 Canvas/WebGL，需提供 renderAt/renderCapture 确定性接口');
   if(document.querySelector('svg animate,svg animateTransform,svg animateMotion,svg set'))throw Error('不支持原生 SVG SMIL 动画，请提供逐帧渲染接口或转换素材');
   const backgroundUrls=new Set();
   for(const node of document.querySelectorAll('*'))for(const pseudo of [null,'::before','::after']){
    const bg=getComputedStyle(node,pseudo).backgroundImage;
    for(const match of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g))backgroundUrls.add(match[1]);
   }
   for(const url of backgroundUrls){
    const r=await fetch(url);if(!r.ok)throw Error('CSS 背景资源读取失败：'+url);const data=await r.arrayBuffer();
    const bytes=new Uint8Array(data),prefix=String.fromCharCode(...bytes.slice(0,12));
    const type=prefix.startsWith('GIF')?'image/gif':prefix.slice(8)==='WEBP'?'image/webp':prefix.slice(1,4)==='PNG'?'image/png':null;
    if(!type){if(/svg/i.test(r.headers.get('content-type')||'')&&/<(?:animate\w*|set)\b|@keyframes|animation\s*:/i.test(new TextDecoder().decode(data)))throw Error('CSS 背景 SVG 内含未受控动画：'+url);continue;}
    if(typeof ImageDecoder==='undefined')throw Error('浏览器无法检查 CSS 背景动图：'+url);
    if(data.byteLength>32*1024*1024)throw Error('CSS 背景图超出检查预算：'+url);
    const d=new ImageDecoder({data,type});let count;try{await d.tracks.ready;count=d.tracks.selectedTrack?.frameCount||0;}finally{d.close();}
    if(count>1)throw Error('CSS 背景动图无法直接定位，请改为 img 或提供静态逐帧背景：'+url);
   }
   collectAnimations();
   await renderImages(0);
   return {images:tracks.size,animatedImages:[...tracks.values()].filter(t=>t.decoder).map(t=>({source:t.source,frames:t.ends.length,durationMs:t.duration})),videos:document.querySelectorAll('video').length};
  },
  async render(time){
   logicalTime=time;
   if(uncontrolled.length)throw Error('发现未受虚拟时间控制的外部执行源：'+uncontrolled.join('；'));
   collectAnimations();
   const animationState=[];
   for(const a of document.getAnimations()){
    a.pause();a.currentTime=Math.max(0,time-(animationStarts.get(a)||0));
    animationState.push(a.effect?.getComputedTiming().progress??null);
   }
   const images=await renderImages(time),videos=await renderVideos(time);
   document.documentElement.getBoundingClientRect();
   return {scrollY,animationState,images,videos};
  },
  dispose(){observer.disconnect();for(const [img,t] of tracks){if(t.decoder&&img.srcset===t.blob)img.removeAttribute('srcset');releaseTrack(t);}tracks.clear();}
 };
}
module.exports={installOfflinePage};
