#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {parseSpec} from '../assets/app/shared/spec.ts';
import {readReuse} from './reuse.mjs';
import {CAPABILITY_REGISTRY} from '../assets/app/shared/capabilities.ts';
const args=process.argv.slice(2);
if(args.length&&!(args.length===2&&['--spec','--app'].includes(args[0])))throw new Error('用法：inspect.mjs [--spec /spec.json | --app /existing/app]');
const app=args[0]==='--app'?resolve(args[1]):undefined;
const specPath=app?resolve(app,'demo-spec.json'):args[0]==='--spec'?resolve(args[1]):undefined;
const spec=specPath?parseSpec(JSON.parse(await readFile(specPath,'utf8'))):undefined;
let manifest;if(app)try{manifest=JSON.parse(await readFile(resolve(app,'generation-manifest.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
let reuse,reuseError;if(app)try{await readFile(resolve(app,'extension-manifest.json'));reuse=(await readReuse(app)).manifest;}catch(error){if(error.code!=='ENOENT')reuseError=error.message;}
const hash=data=>createHash('sha256').update(data).digest('hex');
const output={templateVersion:4,templateFeatures:['assistant-ui','extension-api-v1','chat-state-v1','adk-native-v1','chat-ui-v2','chat-ui-v3','chat-process-v1','split-workspace-v1','execution-modes-v1'],supportedVersions:[1,2,3,4],capabilities:CAPABILITY_REGISTRY.map(({kind,summary})=>({kind,summary})),
 ...(spec?{demo:{id:spec.id,confirmed:spec.confirmed,version:spec.version,execution:spec.execution??{mode:"legacy-env"},workspaceLayout:spec.presentation?.workspaceLayout??'tabs',domains:spec.pages?.map(({id,title})=>({id,title})),bindings:spec.capabilities?.map(({id,kind,pages})=>({id,kind,pages})),coverageCounts:Object.fromEntries(['verified','simulated','unverified','planned'].map(status=>[status,spec.design?.coverage.filter(claim=>claim.status===status).length??0]))},configurationDigest:hash(JSON.stringify(spec)),inputs:{spec:specPath,...(app?{scenario:resolve(app,'scenario.json')}: {})},extension:reuse?{id:reuse.id,apiVersion:reuse.apiVersion,files:reuse.files?.length,reuseReady:true}:manifest?.extension??{reuseReady:false,note:reuseError??'未声明扩展包；不搜索整仓或自动复制旧核心源码'},existingTemplate:manifest?{features:manifest.templateFeatures,capabilityVersion:manifest.templateCapabilityVersion}:undefined}:{}),
 next:reuse?'新目录生成时使用--reuse当前app；复核对应业务数据与主张。':'优先使用已声明能力；明确缺口才读取extensions.md。',
 reads:['references/fast-generation.md（执行入口）'],rules:['不重复读取整个方案/schema/上游文档','配置摘要不代替业务确认或验收','模板API无关时不读核心源码','已有确认配置只作必要修改','Token和费用按实际计量，不估算节省比例']};
console.log(JSON.stringify(output,null,2));
