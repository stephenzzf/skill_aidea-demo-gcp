#!/usr/bin/env node
import {readFile,writeFile,mkdir,lstat,copyFile} from 'node:fs/promises';
import {resolve,dirname,basename,relative,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {refreshValidation} from './validation.mjs';
const flags={};
for(let i=2;i<process.argv.length;i+=2){
 if(!['--app','--report','--out','--manual'].includes(process.argv[i])||!process.argv[i+1])throw new Error('用法：finalize.mjs --app /app --report /pipeline.json --out /archive.zip [--manual /manual-evidence.json]');
 flags[process.argv[i].slice(2)]=process.argv[i+1];
}
if(!flags.app||!flags.report||!flags.out)throw new Error('缺少app/report/out');
const app=resolve(flags.app),output=resolve(flags.out),reportPath=resolve(flags.report);
const outputRelative=relative(app,output);
if(!outputRelative.startsWith('..')&&!isAbsolute(outputRelative))throw new Error('打包输出必须在应用目录外');
try{await lstat(output);throw new Error('输出文件已存在，拒绝覆盖');}catch(error){if(error.code!=='ENOENT')throw error;}
const report=JSON.parse(await readFile(reportPath,'utf8'));
if(report.app!==app||report.status!=='automated-complete'||!report.steps.length||report.steps.some(step=>step.exitCode!==undefined&&step.exitCode!==0))throw new Error('只打包已通过的对应应用；失败记录不能标为成功');
const current=await refreshValidation(app);
if(current.basisDigest!==report.validation.basisDigest)throw new Error('源码或配置已变，拒绝使用过期验收结果打包');
let manual;
if(flags.manual){
 manual=JSON.parse(await readFile(resolve(flags.manual),'utf8'));
 if(manual.basisDigest!==current.basisDigest||!Array.isArray(manual.cases)||!manual.cases.length||new Set(manual.cases.map(item=>item.id)).size!==manual.cases.length||manual.cases.some(item=>!item.id||typeof item.evidence!=='string'||!['verified','simulated','unverified'].includes(item.status)))throw new Error('手工证据必须绑定本次basis并逐项声明状态');
}
const evidenceDir=resolve(app,'evidence');await mkdir(evidenceDir,{recursive:true});
const included=[];
async function collect(source,prefix){
 const path=resolve(source),info=await lstat(path);
 if(!info.isFile()||info.isSymbolicLink()||basename(path).startsWith('.env')||!/\.(json|log|md|txt|png|jpe?g|webp|pdf)$/i.test(path))throw new Error('证据必须是明确的普通文本或图像文件：'+path);
 const name=`evidence/${prefix}-${basename(path)}`;
 if(path!==resolve(app,name))await copyFile(path,resolve(app,name));
 included.push(name);return name;
}
const portable=structuredClone(report);
let index=0;
for(const attempt of [...(portable.history??[]),portable])for(const step of attempt.steps??[])if(step.log)step.log=await collect(step.log,`auto-${index++}`);
await writeFile(resolve(evidenceDir,'pipeline.json'),JSON.stringify(portable,null,2)+'\n');included.push('evidence/pipeline.json');
const manualEntries=[];
for(const item of manual?.cases??[]){
 const evidence=await collect(resolve(dirname(resolve(flags.manual)),item.evidence),`manual-${manualEntries.length}`);
 manualEntries.push({...item,evidence,basisDigest:current.basisDigest});
}
const recordPath=resolve(app,'validation-record.json'),record=JSON.parse(await readFile(recordPath,'utf8'));
record.entries=[{id:'automated-pipeline',status:'verified',basisDigest:current.basisDigest,evidence:'evidence/pipeline.json',scope:report.steps.filter(step=>step.exitCode===0).map(step=>step.name).join(', ')},...manualEntries];
record.status=manual&&manual.cases.every(item=>item.status!=='unverified')?'local-complete':'automated-complete-manual-pending';
await writeFile(recordPath,JSON.stringify(record,null,2)+'\n');
const manifestPath=resolve(app,'generation-manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
manifest.validation={status:record.status,basisDigest:current.basisDigest,stale:false,entries:record.entries.length};manifest.pipelineReport='evidence/pipeline.json';
await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
await writeFile(resolve(app,'VALIDATION.md'),`# 验证报告\n\n状态：${record.status}\n\n`+portable.steps.map(step=>`- ${step.name}: ${step.reused?'复用同锁依赖':`${step.exitCode===0?'通过':'失败'}，${step.seconds}s`}；${step.log??step.reason}`).join('\n')+`\n\n手工证据：${manualEntries.length?manualEntries.map(item=>`${item.id}: ${item.status} / ${item.evidence}`).join('；'):'待执行'}。\n\n默认模板测试使用本地ADK模型；流水线不计量Provider调用，不证明真实模型质量、生产接入、容器或云端部署。真实调用、Token与费用需独立证据，未测量时为unknown。\n`);
await mkdir(dirname(output),{recursive:true});
const code=`import pathlib,zipfile,sys,json\nr=pathlib.Path(sys.argv[1]);o=pathlib.Path(sys.argv[2]);allowed=set(json.loads(sys.argv[3]))\nwith zipfile.ZipFile(o,'x',zipfile.ZIP_DEFLATED) as z:\n for p in r.rglob('*'):\n  rel=p.relative_to(r)\n  if 'evidence' in rel.parts and str(rel) not in allowed:continue\n  if p.is_file() and not p.is_symlink() and not any(x in {'node_modules','dist','.git','__pycache__'} for x in rel.parts) and not p.name.startswith('.env') and p.name not in {'runtime.log','runtime.pid','.DS_Store'}:z.write(p,pathlib.Path(r.name)/rel)\nwith zipfile.ZipFile(o) as z:assert z.testzip() is None\n`;
const zipped=spawnSync('python3',['-c',code,app,output,JSON.stringify(included)],{encoding:'utf8'});
if(zipped.status!==0)throw new Error(zipped.stderr||'打包失败');
console.log(JSON.stringify({archive:output,status:record.status,manualCases:manualEntries.length}));
