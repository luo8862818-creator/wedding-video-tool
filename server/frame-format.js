const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
function validateFrameFormat(buffer,format,{width,height}={}){
 const valid=format==='png'?buffer.length>=24&&buffer.subarray(0,8).equals(pngSignature):
  format==='jpeg'?buffer.length>=3&&buffer[0]===255&&buffer[1]===216:
  format==='webp'?buffer.length>=12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP':false;
 if(!valid)throw Error('浏览器截图数据与配置格式不匹配：'+format);
 if(format==='png'&&width&&height&&(buffer.readUInt32BE(16)!==width||buffer.readUInt32BE(20)!==height))throw Error('截图原生尺寸与输出配置不一致');
}
module.exports={validateFrameFormat};
