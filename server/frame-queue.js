const {performance}=require('node:perf_hooks');

// One browser producer, one ordered consumer. Capacity excludes the single
// in-flight producer/consumer frames; no image is retained for statistics.
class FrameQueue {
 constructor(source,{size=4,maxBytes=64*1024*1024,signal}={}){
  if(!Number.isInteger(size)||size<1||size>16)throw Error('帧队列容量必须为 1～16');
  this.source=source;this.capacity=size;this.maxBytes=maxBytes;this.signal=signal;
  this.items=[];this.bytes=0;this.ended=false;this.error=null;this.waiters=new Set();
  this.stats={queueSize:size,queueMaxBytes:maxBytes,queueHighWaterMark:0,queueByteHighWaterMark:0,queueWaitCount:0,queueWaitMs:0,producerWaitMs:0,consumerWaitMs:0,producerWaitCount:0,consumerWaitCount:0};
  this.abort=()=>this.stop(signal?.reason instanceof Error?signal.reason:Object.assign(Error('导出已停止'),{name:'AbortError'}));
  signal?.addEventListener('abort',this.abort,{once:true});
 }
 wake(){for(const resolve of this.waiters)resolve();this.waiters.clear();}
 async wait(kind){
  const start=performance.now();this.stats.queueWaitCount++;this.stats[kind+'WaitCount']++;
  await new Promise(resolve=>this.waiters.add(resolve));
  const elapsed=performance.now()-start;this.stats.queueWaitMs+=elapsed;this.stats[kind+'WaitMs']+=elapsed;
 }
 start(){
  if(this.task)return;
  this.task=(async()=>{
   try{
    for await(const frame of this.source){
     if(this.ended)break;
     if(!Buffer.isBuffer(frame.buffer))throw Error('帧队列只接受带 Buffer 的帧对象');
     if(frame.buffer.length>this.maxBytes)throw Error('单帧超过帧队列内存预算');
     const start=performance.now();let waited=false;
     while(!this.ended&&(this.items.length>=this.capacity||this.bytes+frame.buffer.length>this.maxBytes)){waited=true;await this.wait('producer');}
     if(this.ended)break;
     frame.diagnostic.producerWaitMs=waited?performance.now()-start:0;
     frame.enqueuedAt=performance.now();
     this.items.push(frame);this.bytes+=frame.buffer.length;
     this.stats.queueHighWaterMark=Math.max(this.stats.queueHighWaterMark,this.items.length);
     this.stats.queueByteHighWaterMark=Math.max(this.stats.queueByteHighWaterMark,this.bytes);this.wake();
    }
   }catch(error){if(!this.error)this.error=error;this.items=[];this.bytes=0;}
   finally{this.ended=true;this.wake();}
  })();
 }
 async next(){
  if(this.signal?.aborted)this.abort();
  this.start();
  while(!this.items.length&&!this.ended)await this.wait('consumer');
  if(this.error){this.signal?.removeEventListener('abort',this.abort);throw this.error;}
  if(!this.items.length){this.signal?.removeEventListener('abort',this.abort);return {done:true};}
  const value=this.items.shift();this.bytes-=value.buffer.length;
  value.diagnostic.ffmpegQueueWaitMs=performance.now()-value.enqueuedAt;this.wake();
  return {value,done:false};
 }
 stop(reason=Error('帧管道已停止')){
  if(!this.error)this.error=reason;this.ended=true;this.items=[];this.bytes=0;this.wake();
  this.signal?.removeEventListener('abort',this.abort);
  this.source.stop?.();
 }
 async return(){
  if(!this.ended||this.items.length)this.stop();
  if(this.task)await this.task;
  await this.source.return?.();this.signal?.removeEventListener('abort',this.abort);
  return {done:true};
 }
 [Symbol.asyncIterator](){return this;}
}
module.exports={FrameQueue};
