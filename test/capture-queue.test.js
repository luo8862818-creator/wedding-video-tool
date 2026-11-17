const test=require("node:test"),assert=require("node:assert/strict");
const {CaptureQueue}=require("../server/live-capture");

test("30 FPS preserves wall time and intentional holds",async()=>{
 const q=new CaptureQueue(30);q.start(1000);
 q.push({timestamp:1000,data:Buffer.from("first")});
 q.push({timestamp:2000,data:Buffer.from("last")});q.stop(3000);
 const out=[];for await(const data of q)out.push(data.toString());
 assert.equal(out.length,60);assert.deepEqual(out.slice(0,30),Array(30).fill("first"));
 assert.deepEqual(out.slice(30),Array(30).fill("last"));
});
test("higher source cadence is sampled without stretching the recording",async()=>{
 const q=new CaptureQueue(30);q.start(1000);
 for(let i=0;i<60;i++)q.push({timestamp:1000+i*1000/60,data:Buffer.from(String(i))});
 q.stop(2000);const out=[];for await(const data of q)out.push(+data.toString());
 assert.equal(out.length,30);assert.ok(out.every((v,i)=>!i||v>out[i-1]));
 assert.equal(q.snapshot().droppedSourceFrames,0);
});
test("slow consumer memory is bounded and lost source frames are reported",async()=>{
 const q=new CaptureQueue(30,{maxFrames:2,maxBytes:16});q.start(0);
 for(let i=0;i<20;i++)q.push({timestamp:i*40,data:Buffer.alloc(8,i)});
 assert.ok(q.bytes<=16);assert.equal(q.snapshot().droppedSourceFrames,18);q.stop(800);
 let count=0;for await(const _ of q)count++;assert.equal(count,24);
});
test("empty recording rejects instead of producing a successful black video",async()=>{
 const q=new CaptureQueue(30);q.start(0);q.stop(1000);
 await assert.rejects(async()=>{for await(const _ of q){}},/没有输出/);
});
test("stop wakes an idle consumer",async()=>{
 const q=new CaptureQueue(30);q.start(0);const consume=(async()=>{let n=0;for await(const _ of q)n++;return n;})();
 q.push({timestamp:0,data:Buffer.from("a")});setTimeout(()=>q.stop(100),5);
 assert.equal(await consume,3);
});
