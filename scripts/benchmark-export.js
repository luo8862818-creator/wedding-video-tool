const path=require('node:path');
const {parseArgs}=require('node:util');
const {benchmarkExports}=require('../server/export-benchmark');
const {values,positionals}=parseArgs({allowPositionals:true,options:{fps:{type:'string',default:'60'},width:{type:'string',default:'1080'},height:{type:'string',default:'1920'},'duration-ms':{type:'string'},formats:{type:'string',default:'png,webp,jpeg'},encoders:{type:'string',default:'software'},output:{type:'string'}}});
if(!positionals[0])throw Error('请提供 HTML 路径：npm run benchmark -- <index.html>');
const controller=new AbortController();
for(const event of ['SIGINT','SIGTERM'])process.once(event,()=>controller.abort(Object.assign(Error('用户停止 Benchmark'),{name:'AbortError'})));
benchmarkExports({sourcePath:path.resolve(positionals[0]),directory:path.resolve(values.output||path.join('output','benchmarks',Date.now()+'-'+process.pid)),fps:Number(values.fps),width:Number(values.width),height:Number(values.height),durationMs:values['duration-ms']===undefined?undefined:Number(values['duration-ms']),formats:values.formats.split(','),encoders:values.encoders.split(','),signal:controller.signal})
 .then(result=>process.stdout.write(JSON.stringify({variants:result.results.map(r=>({format:r.format,actualEncoder:r.actualEncoder,status:r.status,totalSeconds:r.metrics?.totalSeconds,bottleneck:r.metrics?.bottleneck,qualityGate:r.qualityGate})),defaultUnchanged:true},null,2)+'\n'))
 .catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=controller.signal.aborted?130:1;});
