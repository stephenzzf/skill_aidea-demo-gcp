#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {refreshValidation,validationBasis} from './validation.mjs';
import {readdir} from 'node:fs/promises';
import {checkPlan,hash} from './check-plan.mjs';
const skill=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const flags={};for(let i=2;i<process.argv.length;i++){
 const key=process.argv[i];
 if(['--reuse-checks','--fresh'].includes(key))flags[key.slice(2)]=true;
 else if(['--spec','--data','--out','--app','--report','--tests','--reuse'].includes(key)&&process.argv[i+1]&&!process.argv[i+1].startsWith('--'))flags[key.slice(2)]=process.argv[++i];
 else throw new Error('参数无效；支持--app/--spec/--data/--out/--report/--tests/--reuse，以及--reuse-checks或--fresh');
}
if(flags.app&&flags.reuse)throw new Error('--reuse仅用于新目录生成，不能覆盖已有应用源码');
if(flags.fresh&&flags['reuse-checks'])throw new Error('--fresh与--reuse-checks不能同时使用');
if(!flags.report||!(flags.app||flags.out&&flags.spec&&flags.data)||flags.app&&(flags.out||flags.spec||flags.data))throw new Error('生成与已有应用检查参数不能混用');
const app=resolve(flags.app??flags.out),reportPath=resolve(flags.report),started=Date.now();
await mkdir(dirname(reportPath),{recursive:true});
let previous;try{previous=JSON.parse(await readFile(reportPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const {history:previousHistory=[],...previousAttempt}=previous??{};
const report={version:2,environment:JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,mode:process.env.NODE_ENV,tz:process.env.TZ,options:process.env.NODE_OPTIONS}),testSelection:flags.tests??'default',startedAt:new Date(started).toISOString(),app,steps:[],status:'running',history:previous?[...previousHistory,previousAttempt]:[],realModelCalls:null,modelValidation:'默认模板仅使用本地ADK测试模型；流水线不计量自定义测试的Provider调用，未测量值不写0。',tokens:{status:'unknown',note:'此脚本不推断Codex或Provider Token；有独立实际用量时另行关联。'}};
const save=async()=>writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
async function step(name,command,args,cwd){
 const begin=Date.now();let output='';
 const exitCode=await new Promise((done,reject)=>{const child=spawn(command,args,{cwd,env:process.env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',data=>{output+=data});child.stderr.on('data',data=>{output+=data});child.once('error',reject);child.once('close',code=>done(code??1));});
 const log=resolve(dirname(reportPath),`${reportPath.split('/').at(-1)}.${started}.${name}.log`);await writeFile(log,output);
 report.steps.push({name,command:[command,...args],seconds:(Date.now()-begin)/1000,exitCode,log,logSha256:hash(output)});await save();
 if(exitCode!==0)throw new Error(`${name}失败，保留日志：${log}`);
 console.log(JSON.stringify({stage:name,seconds:(Date.now()-begin)/1000,exitCode}));
}
try{
 if(!flags.app)await step('generate',process.execPath,['--experimental-strip-types',resolve(skill,'scripts/generate.mjs'),'--spec',resolve(flags.spec),'--data',resolve(flags.data),'--out',app,...(flags.reuse?['--reuse',resolve(flags.reuse)]:[])],skill);
 const manifest=JSON.parse(await readFile(resolve(app,'generation-manifest.json'),'utf8'));if(!['aidea-demo-gcp','me-demo-generator'].includes(manifest.generator))throw new Error('不是本Skill生成的应用');
 report.demoId=manifest.demoId;report.basisBefore=await validationBasis(app);
 const lockHash=createHash('sha256').update(await readFile(resolve(app,'package-lock.json'))).digest('hex');
 const marker=resolve(app,'node_modules/.me-demo-lock');let installed=false;try{installed=(await readFile(marker,'utf8'))===lockHash&&Boolean(await stat(resolve(app,'node_modules/typescript/bin/tsc')));}catch{}
 if(!installed){await step('install','npm',['ci','--ignore-scripts','--no-audit','--no-fund','--fetch-timeout=30000','--fetch-retries=0'],app);await writeFile(marker,lockHash);}
 else report.steps.push({name:'install',reused:true,reason:'same lockfile digest and existing TypeScript runtime'});
 const artifact=async()=>{
  const root=resolve(app,'dist/client');try{await stat(resolve(root,'index.html'));}catch{return undefined;}
  const list=[];async function visit(path,prefix=''){for(const entry of await readdir(path,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isDirectory())await visit(resolve(path,entry.name),name+'/');else if(entry.isFile())list.push([name,hash(await readFile(resolve(path,entry.name)))]);else return undefined;}}await visit(root);return hash(JSON.stringify(list.sort()));
 };
 let logsValid=Boolean(previous);
 if(previous)for(const name of ['typecheck','tests','build']){const old=previous.steps?.find(step=>step.name===name);try{if(!old?.logSha256||hash(await readFile(old.log))!==old.logSha256)logsValid=false;}catch{logsValid=false;}}
 const plan=checkPlan({previous,basis:report.basisBefore,environment:report.environment,app,selection:report.testSelection,logsValid,buildValid:previous?.buildDigest&&previous.buildDigest===await artifact(),fresh:!flags['reuse-checks']});report.checkPlan=plan;
 function reuse(name){const old=previous.steps.find(step=>step.name===name);report.steps.push({...old,reused:true,seconds:0,reason:plan.mode==='client-only'?'client-only change; corresponding backend/data or type evidence unchanged':'identical source/configuration, environment and recorded evidence',reusedFrom:previous.startedAt});}
 if(plan.typecheck)await step('typecheck','npm',['run','typecheck'],app);else reuse('typecheck');
 if(plan.tests){
  if(flags.tests){const names=flags.tests.split(',');if(names.some(name=>!/^[-a-zA-Z0-9_.]+\.test\.ts$/.test(name)))throw new Error('测试只能指定tests内明确文件名');await step('tests',process.execPath,['--experimental-strip-types','--test',...names.map(name=>`tests/${name}`)],app);}
  else await step('tests','npm',['test'],app);
 }else reuse('tests');
 if(plan.build)await step('build',process.execPath,[resolve(app,'node_modules/vite/bin/vite.js'),'build'],app);else reuse('build');
 report.buildDigest=await artifact();
 const basis=await validationBasis(app);if(basis.digest!==report.basisBefore.digest)throw new Error('验证期间源码或配置变化，请冻结后重新验收');
 report.validation=await refreshValidation(app);report.status='automated-complete';report.manual='pending';report.finishedAt=new Date().toISOString();report.seconds=(Date.now()-started)/1000;await save();
 console.log(JSON.stringify({status:report.status,manual:report.manual,seconds:report.seconds,report:reportPath}));
}catch(error){report.status='failed';report.error=error.message;report.finishedAt=new Date().toISOString();report.seconds=(Date.now()-started)/1000;await save();console.error(error.message);process.exitCode=1;}
