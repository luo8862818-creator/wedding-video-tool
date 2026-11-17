const fs=require("node:fs");
const path=require("node:path");

function serialize(value){
 if(value===undefined)return "";
 try{
  return JSON.stringify(value,(key,item)=>{
   if(item instanceof Error)return {name:item.name,message:item.message,stack:item.stack};
   return item;
  },2);
 }catch(error){
  return String(value);
 }
}

function createFileLogger(filePath){
 fs.mkdirSync(path.dirname(filePath),{recursive:true});
 const stream=fs.createWriteStream(filePath,{flags:"a",encoding:"utf8"});
 let closed=false;
 stream.on("error",()=>{});
 function write(level,event,details){
  if(closed)return;
  const timestamp=new Date().toISOString();
  const body=details===undefined?"":"\n"+serialize(details);
  stream.write("["+timestamp+"] ["+level+"] "+event+body+"\n");
 }
 return {
  filePath,
  write,
  info:(event,details)=>write("INFO",event,details),
  warn:(event,details)=>write("WARN",event,details),
  error:(event,details)=>write("ERROR",event,details),
  close(){
   if(closed)return Promise.resolve();
   closed=true;
   return new Promise(resolve=>stream.end(resolve));
  }
 };
}

module.exports={createFileLogger};
