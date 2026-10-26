#!/usr/bin/env node
import {readFile,writeFile,lstat,realpath,mkdir,copyFile} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const template=resolve(dirname(fileURLToPath(import.meta.url)),'../assets/app');
const hash=data=>createHash('sha256').update(data).digest('hex');
const allowed=path=>['client/demo-extension.tsx','server/demo-extension.ts'].includes(path)||/^(?:client|server|shared)\/extensions\/[A-Za-z0-9_./-]+\.(?:ts|tsx|css)$/.test(path)||/^tests\/extension[-A-Za-z0-9_.]*\.test\.ts$/.test(path);
async function safeFile(root,path){
 if(typeof path!=='string'||!allowed(path)||path.split('/').some(part=>part==='..'||part===''||part==='.'))throw new Error(`不支持的扩展路径：${path}`);
 if(!['client/demo-extension.tsx','server/demo-extension.ts'].includes(path)){try{await lstat(resolve(template,path));throw new Error(`不能覆盖通用模板文件：${path}`);}catch(error){if(error.code!=='ENOENT')throw error;}}
 const full=resolve(root,path),resolved=await realpath(full),base=await realpath(root),rel=relative(base,resolved);
 if(rel.startsWith('..')||isAbsolute(rel)||resolved!==resolve(base,path)||!(await lstat(full)).isFile())throw new Error(`扩展文件必须为目录内普通文件：${path}`);
 return full;
}
export async function readReuse(source){
 const root=resolve(source),raw=JSON.parse(await readFile(resolve(root,'extension-manifest.json'),'utf8'));
 if(Object.keys(raw).some(key=>!['version','apiVersion','id','dependencyDigest','files'].includes(key))||raw.version!==1||raw.apiVersion!==1||!/^[-a-zA-Z0-9_]+$/.test(raw.id)||!Array.isArray(raw.files)||!raw.files.length)throw new Error('扩展清单格式或API版本不支持');
 if(hash(await readFile(resolve(root,'package-lock.json')))!==raw.dependencyDigest)throw new Error('扩展依赖锁与清单不一致，请重新核实后打包');
 const paths=raw.files.map(file=>file.path);if(new Set(paths).size!==paths.length||!['client/demo-extension.tsx','server/demo-extension.ts'].every(path=>paths.includes(path)))throw new Error('扩展须包含且仅声明一次两个固定入口');
 for(const file of raw.files){if(Object.keys(file).some(key=>!['path','sha256'].includes(key)))throw new Error('扩展文件清单含未知字段');const full=await safeFile(root,file.path);if(hash(await readFile(full))!==file.sha256)throw new Error(`扩展源码已变，请重新核实清单：${file.path}`);}
 return {root,manifest:raw,digest:hash(JSON.stringify(raw))};
}
export async function applyReuse(reuse,target){
 if(hash(await readFile(resolve(target,'package-lock.json')))!==reuse.manifest.dependencyDigest)throw new Error('目标模板与扩展依赖锁不一致；不自动修改依赖或覆盖客户源码');
 for(const file of reuse.manifest.files){const destination=resolve(target,file.path);await mkdir(dirname(destination),{recursive:true});await copyFile(await safeFile(reuse.root,file.path),destination);}
 await writeFile(resolve(target,'extension-manifest.json'),JSON.stringify(reuse.manifest,null,2)+'\n');
 return {id:reuse.manifest.id,apiVersion:1,digest:reuse.digest,files:reuse.manifest.files};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const flags={};for(let i=2;i<process.argv.length;i+=2){if(!['--app','--id','--files'].includes(process.argv[i])||!process.argv[i+1])throw new Error('用法：reuse.mjs --app /app --id extension-id --files client/demo-extension.tsx,server/demo-extension.ts,...');flags[process.argv[i].slice(2)]=process.argv[i+1];}
 if(!flags.app||!flags.id||!flags.files)throw new Error('缺少app/id/files');
 const root=resolve(flags.app),paths=flags.files.split(',');const files=[];
 for(const path of paths)files.push({path,sha256:hash(await readFile(await safeFile(root,path)))});
 if(!/^[-a-zA-Z0-9_]+$/.test(flags.id)||new Set(paths).size!==paths.length||!['client/demo-extension.tsx','server/demo-extension.ts'].every(path=>paths.includes(path)))throw new Error('id或两个固定入口清单无效，未写文件');
 const manifest={version:1,apiVersion:1,id:flags.id,dependencyDigest:hash(await readFile(resolve(root,'package-lock.json'))),files};
 const out=resolve(root,'extension-manifest.json');await writeFile(out,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 try{await readReuse(root);}catch(error){throw new Error(`扩展清单已保留供修正：${error.message}`);}
 console.log(JSON.stringify({manifest:out,id:manifest.id,files:files.length,note:'只记录源码，不代表验收通过；将此目录传给生成器--reuse。'}));
}
