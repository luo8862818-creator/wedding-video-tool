(() => {
  const pages=[...document.querySelectorAll(".page")];
  const counter=document.getElementById("counter");
  const progress=document.getElementById("progress");
  const hint=document.getElementById("hint");
  const total=pages.length;
  let started=false,finished=false,raf=0,startAt=0;
  const duration=36000; // 36秒走完整个12屏，便于快速测试导出
  function update(){
    const max=document.documentElement.scrollHeight-innerHeight;
    const ratio=max>0?scrollY/max:0;
    const index=Math.min(total,Math.floor(ratio*total)+1);
    counter.textContent=String(index).padStart(2,"0")+" / "+total;
    progress.style.width=(ratio*100)+"%";
  }
  function animate(now){
    if(!started)return;
    const elapsed=now-startAt;
    const ratio=Math.min(1,elapsed/duration);
    const max=document.documentElement.scrollHeight-innerHeight;
    window.scrollTo(0,max*ratio);
    update();
    if(ratio<1)raf=requestAnimationFrame(animate);
    else {finished=true;hint.textContent="播放完成";}
  }
  function start(){
    if(started)return;
    started=true;hint.textContent="正在自动播放 · 12 屏";
    startAt=performance.now();raf=requestAnimationFrame(animate);
  }
  window.addEventListener("scroll",update,{passive:true});
  window.addEventListener("load",()=>{update();setTimeout(start,2000);});
  // 测试工具可通过该标志确认自动播放状态；不依赖任何外部库。
  window.templatePlayer={get started(){return started},get ended(){return finished},get duration(){return duration},get totalPages(){return total}};
})();
