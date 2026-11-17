const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const enabled=process.env.RUN_MEDIA_TESTS==='1';
test('known player in an iframe uses the lightweight API and keeps final hold',{skip:!enabled},async()=>{
 const {chromium}=require('playwright'),{readPlaybackState}=require('../server/render');const b=await chromium.launch({headless:true,...(process.env.WEDDING_BROWSER_CHANNEL?{channel:process.env.WEDDING_BROWSER_CHANNEL}:{})});
 try{const page=await b.newPage();await page.setContent('<iframe></iframe>');const frame=page.frames()[1];await frame.evaluate(()=>{window.weddingPlayer={state:'FINISHED',time:1500,totalMs:2000,metrics:{chapters:10}};window.getComputedStyle=()=>{throw Error('unexpected full DOM scan')};});const first=await readPlaybackState(page);assert.equal(first.stateReadMode,'player-api');assert.equal(first.ended,false);await page.waitForTimeout(550);assert.equal((await readPlaybackState(page)).ended,true);}finally{await b.close()}
});
test('live 1080p30 output decodes and all progress callbacks are finite',{skip:!enabled,timeout:60000},async()=>{
 const {renderVideo}=require('../server/render');const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wedding-live-test-'));try{
  const source=path.join(directory,'index.html'),output=path.join(directory,'result.mp4');
  fs.writeFileSync(source,`<!doctype html><link rel="icon" href="data:,"><body style="background:ivory"><div id="box" style="width:100px;height:100px;background:green"></div><script>window.weddingPlayer={state:'AUTO_SCROLL',time:0,totalMs:2500,metrics:{chapters:10}};const start=performance.now();function f(t){weddingPlayer.time=Math.min(2000,t-start);box.style.transform='translateY('+weddingPlayer.time/5+'px)';if(weddingPlayer.time>=2000)weddingPlayer.state='FINISHED';else requestAnimationFrame(f)}requestAnimationFrame(f)</script>`);
  let metrics;await renderVideo({sourcePath:source,outputPath:output,fps:30,width:1080,height:1920,onProgress:(n,_,__,extra)=>{assert.ok(Number.isFinite(n));if(n===100)metrics=extra;}});
  assert.ok(fs.statSync(output).size>1024);assert.equal(metrics.fps,30);assert.equal(metrics.captureWidth,1080);assert.equal(metrics.captureHeight,1920);assert.ok(metrics.durationSeconds>=2.5);assert.equal(metrics.captureStats.droppedSourceFrames,0);assert.equal(metrics.encodedFrames,metrics.frames);assert.deepEqual(metrics.pageErrors,[]);
  const {spawnSync}=require('node:child_process'),{ffmpegPath,transcodeRecordedVideo}=require('../server/ffmpeg');const music=path.join(directory,'music.wav');
  const tone=spawnSync(ffmpegPath,['-y','-v','error','-f','lavfi','-i','sine=frequency=440:duration=1',music],{windowsHide:true});assert.equal(tone.status,0);
  const muxed=await transcodeRecordedVideo({inputPath:output,outputPath:path.join(directory,'with-music.mp4'),musicPath:music,fps:30,width:1080,height:1920,copyVideo:true,onProgress:s=>{assert.ok(Number.isFinite(s.outTimeSeconds))}});
  assert.equal(muxed.frames,metrics.frames);assert.ok(Math.abs(muxed.durationSeconds-metrics.durationSeconds)<.1);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
