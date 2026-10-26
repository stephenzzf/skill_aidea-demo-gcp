import { formatMetricValue } from "../shared/metric-format.ts";
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { LogLevel, setLogLevel } from '@google/adk';
import { parseRuntimeConfig } from '../server/config.ts';
import { createApp } from '../server/app.ts';
import { hashCode } from '../server/auth.ts';
import { parseSpec, parseScenario } from '../shared/spec.ts';
import type { StreamEvent } from '../shared/contracts.ts';

setLogLevel(LogLevel.ERROR);
const spec = parseSpec(JSON.parse(await readFile('demo-spec.json','utf8')));
const scenario = parseScenario(JSON.parse(await readFile('scenario.json','utf8')),spec.workspace,spec);
const actionPage = spec.pages?.find(page=>page.components.includes('workflow')&&page.components.includes('assistant'));
const page = spec.pages?.find(page=>page.id!==actionPage?.id&&page.components.includes('assistant')&&page.metrics.length)
  ?? spec.pages?.find(page=>page.components.includes('assistant')&&page.metrics.length);
const code = randomBytes(12).toString('hex');
const env = {DEMO_MODEL_MODE:'simulated', DEMO_ACCESS_CODE_HASH:hashCode(code), DEMO_COOKIE_SECRET:randomBytes(32).toString('hex'), DEMO_ACCESS_EXPIRES_AT:new Date(Date.now()+60000).toISOString(), GOOGLE_CLOUD_PROJECT:'', GOOGLE_CLOUD_LOCATION:'', GOOGLE_APPLICATION_CREDENTIALS:'/nonexistent-me-demo-credentials.json'};
const events = (text:string):StreamEvent[] => text.split('\n\n').filter(part=>part.startsWith('data: ')).map(part=>JSON.parse(part.slice(6)));

test('formal no-cloud simulation uses real Runner, same analysis as dashboard, new filters and state after actions', {skip:!page||!actionPage||spec.execution?.data==='bigquery'}, async t=>{
  const runtime = parseRuntimeConfig({project:'',location:'',model:''},env,{model:'simulated',data:'local'});
  assert.equal(runtime.mode,'simulated');assert.equal(runtime.project,'');
  const server=createApp({...spec,execution:{model:'simulated',data:'local'}},scenario,runtime).listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));t.after(()=>{server.closeAllConnections();server.close()});
  const address=server.address();assert(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const post=(path:string,input:unknown,cookie='')=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify(input)});
  const login=await post('/api/access',{code});const cookie=login.headers.get('set-cookie')!.split(';')[0];
  const publicConfig=await(await fetch(base+'/api/config',{headers:{cookie}})).json();assert.equal(publicConfig.mode,'simulated');assert.deepEqual(publicConfig.execution,{model:'simulated',data:'local'});
  let state={revision:0,events:[]} as {revision:number;events:unknown[]};
  const context={domainId:page!.id,query:{},state};
  const read=async(domainId:string,query:Record<string,unknown>,message='请分析当前经营指标')=>{
    const response=await post('/api/chat',{message,history:[],context:{domainId,query,state}},cookie);assert.equal(response.status,200);const stream=events(await response.text());assert.equal(stream.at(-1)?.type,'done');return stream.filter((e):e is Extract<StreamEvent,{type:'text'}>=>e.type==='text').map(e=>e.text).join('');
  };
  const analysis=await(await post('/api/analysis',context,cookie)).json();
  const answer=await read(page!.id,{});assert.match(answer,/本轮分析工具/);
  for(const metric of analysis.metrics){assert(answer.includes(metric.label));for(const row of metric.partitions??[metric])if(row.value!==null)assert(answer.includes(formatMetricValue(row.value,row.unit)));}
  const metricDataset=spec.workspace!.metrics.find(m=>page!.metrics.includes(m.id))!.dataset;
  const dataset=spec.workspace!.datasets.find(d=>d.id===metricDataset)!;
  const field=dataset.fields.find(f=>f.type==='string'&&f.id!==dataset.key)!;
  const row=scenario.workspace!.datasets.find(d=>d.id===dataset.id)!.rows![0];
  const filter={dataset:dataset.id,filters:[{dataset:dataset.id,field:field.id,op:'eq',value:row[field.id]}]};
  const filtered=await(await post('/api/analysis',{domainId:page!.id,query:filter,state},cookie)).json();
  assert(filtered.metrics.length>0);
  const filteredAnswer=await read(page!.id,filter);for(const m of filtered.metrics)for(const p of m.partitions??[m])if(p.value!==null)assert(filteredAnswer.includes(formatMetricValue(p.value,p.unit)));
  const selected=await post('/api/chat',{message:'请查看当前记录详情',history:[],context:{...context,selectedRecord:{dataset:dataset.id,id:String(row[dataset.key]),scope:'current'}}},cookie);const selectedText=events(await selected.text()).filter((e):e is Extract<StreamEvent,{type:'text'}>=>e.type==='text').map(e=>e.text).join('');assert(selectedText.includes(String(row[dataset.key])),selectedText);
  const unknown=await read(page!.id,{},'请预测明天的彩票号码');assert.match(unknown,/模拟|未配置|覆盖/);
  const workflow=spec.workspace!.workflow!;const records=scenario.workspace!.datasets.find(d=>d.id===workflow.dataset)!.rows!;
  const candidate=records.find(r=>workflow.transitions.some(a=>a.from.includes(String(r[workflow.statusField]))&&actionPage!.actions.includes(a.id)))!;assert(candidate);
  const transition=workflow.transitions.find(a=>a.from.includes(String(candidate[workflow.statusField]))&&actionPage!.actions.includes(a.id))!;
  const input=Object.fromEntries((transition.inputFields??[]).map(f=>[f.id,f.type==='boolean'?false:f.type==='number'?1:'本地模拟验证依据']));
  const action=await post('/api/actions',{requestId:randomBytes(12).toString('hex'),domainId:actionPage!.id,recordId:String(candidate[spec.workspace!.datasets.find(d=>d.id===workflow.dataset)!.key]),actionId:transition.id,role:transition.role,expectedRevision:0,state,input},cookie);assert.equal(action.status,200,await action.clone().text());const result=await action.json();assert(result.receipt.simulated);state=result.state;
  const after=await read(actionPage!.id,{});
  const currentAnalysis=await(await post('/api/analysis',{domainId:actionPage!.id,query:{},state},cookie)).json();
  for(const m of currentAnalysis.metrics)for(const p of m.partitions??[m])if(p.value!==null)assert(after.includes(formatMetricValue(p.value,p.unit)));
  const recordReply=await post('/api/chat',{message:'当前记录详情',history:[],context:{domainId:actionPage!.id,query:{},state,selectedRecord:{dataset:workflow.dataset,id:String(candidate[spec.workspace!.datasets.find(d=>d.id===workflow.dataset)!.key]),scope:'current'}}},cookie);
  const recordEvents=events(await recordReply.text());
  const recordText=recordEvents.filter((e):e is Extract<StreamEvent,{type:'text'}>=>e.type==='text').map(e=>e.text).join('');
  assert(recordText.includes(`${workflow.statusField}：${JSON.stringify(transition.to)}`),recordText);
  // The action is a validated demo event. No provider credentials/project were supplied.
});

test('BigQuery profile does not expose local financial analysis; browser-only governance is explicitly scoped', {skip:!page||!actionPage||page.id===actionPage.id}, async t=>{
 const runtime=parseRuntimeConfig({project:'',location:'',model:''},env);
 const cloud={...spec,execution:{model:'simulated' as const,data:'bigquery' as const}};
 const extension={id:'bq-fixture',dataBackend:'bigquery' as const,localWorkspaceDomains:[actionPage!.id],parseContext:(data:unknown)=>data as Record<string,unknown>};
 const server=createApp(cloud,scenario,runtime,undefined,extension).listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));t.after(()=>{server.closeAllConnections();server.close()});
 const address=server.address();assert(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
 const post=(path:string,body:unknown,cookie='')=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify(body)});
 const login=await post('/api/access',{code});const cookie=login.headers.get('set-cookie')!.split(';')[0];const state={revision:0,events:[]};
 assert.equal((await post('/api/analysis',{domainId:page!.id,query:{},state},cookie)).status,409);
 const local=await post('/api/analysis',{domainId:actionPage!.id,query:{},state},cookie);assert.equal(local.status,200);assert.equal((await local.json()).dataBackend,'local');
 const missing=await post('/api/chat',{message:'分析当前指标',history:[],context:{domainId:page!.id,query:{},state}},cookie);assert.equal(missing.status,400);assert.match(await missing.text(),/BigQuery/);
});
