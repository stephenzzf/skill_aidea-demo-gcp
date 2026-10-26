#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpec, parseScenario } from '../assets/app/shared/spec.ts';

/** Deterministic, relation-aware synthetic records. This does not infer customer facts. */
export function seedScenario(spec, {seed=2006, count=6, date='2026-01-01', currencies=['EUR','GBP','SGD']}={}) {
  if(!spec.workspace || !spec.workspace.datasets.every(d=>d.origin==='synthetic')) throw new Error('仅为明确synthetic的数据集生成样例，不填充客户授权数据');
  if(!Number.isSafeInteger(count)||count<1||!Number.isSafeInteger(seed)||!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date).toISOString().slice(0,10)!==date)throw new Error('seed/count/date无效');
  if(!currencies.length||currencies.some(code=>!/^[A-Z]{3}$/.test(code)))throw new Error('currency必须为显式ISO样式三字母代码');
  let number=seed>>>0; const random=()=>{number=(1664525*number+1013904223)>>>0;return number/4294967296};
  const datasets=[];const waiting=[...spec.workspace.datasets];
  while(waiting.length){
    const index=waiting.findIndex(schema=>(schema.relations??[]).every(relation=>datasets.some(d=>d.id===relation.dataset)));
    if(index<0)throw new Error('样例数据存在循环关联；请提供明确rows，不自动猜测');
    const schema=waiting.splice(index,1)[0];const capability=spec.capabilities?.find(cap=>cap.kind==='partitioned-analysis'&&cap.dataset===schema.id);
    const workItems=spec.capabilities?.find(cap=>cap.kind==='work-items'&&cap.dataset===schema.id);
    const mapping=spec.capabilities?.find(cap=>cap.kind==='mapping-review'&&cap.dataset===schema.id);
    const rows=Array.from({length:count},(_,i)=>{
      const row=Object.fromEntries(schema.fields.map(field=>[field.id,field.type==='number'?Math.round((10+random()*90)*100)/100:field.type==='boolean'?false:field.type==='date'?new Date(Date.parse(date)+86400000*i).toISOString().slice(0,10):`${field.label}样例${i+1}`]));
      row[schema.key]=`${schema.id}-${i+1}`;
      for(const relation of schema.relations??[]){const target=datasets.find(d=>d.id===relation.dataset).rows;row[relation.field]=target[i%target.length][relation.target];}
      for(const metric of spec.workspace.metrics.filter(metric=>metric.dataset===schema.id)){for(const filter of metric.filters??[])if(filter.op==='eq'&&(!filter.dataset||filter.dataset===schema.id)&&schema.fields.some(field=>field.id===filter.field))row[filter.field]=filter.value;}
      if(workItems)Object.assign(row,workItems.defaults);
      if(spec.workspace.workflow?.dataset===schema.id){row[spec.workspace.workflow.statusField]=workItems?.defaults[spec.workspace.workflow.statusField]??spec.workspace.stages[0].id;if(spec.workspace.workflow.staleField)row[spec.workspace.workflow.staleField]=false;}
      if(capability)row[capability.currencyField]=currencies[i%currencies.length];
      if(mapping&&i===0){const field=schema.fields.find(field=>field.id===mapping.targetField);if(!field.required)row[mapping.targetField]=null;}
      return row;
    });datasets.push({id:schema.id,rows});
  }
  return parseScenario({version:2,synthetic:true,instruction:`固定种子${seed}的合成演示数据，不代表客户真实业务。引用确定性分析，区分观察与建议；模拟动作不证明经营提升。`,topics:[],workspace:{datasets}},spec.workspace,spec);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);const flags={};for(let i=0;i<args.length;i+=2){if(!['--spec','--out','--seed','--count','--date','--currencies'].includes(args[i])||!args[i+1])throw new Error('用法：seed-data.mjs --spec /abs/spec.json --out /abs/scenario.json [--seed 2006 --count 6 --date 2026-01-01 --currencies EUR,GBP,SGD]');flags[args[i].slice(2)]=args[i+1];}
 const spec=parseSpec(JSON.parse(await readFile(flags.spec,'utf8')));const result=seedScenario(spec,{...(flags.seed?{seed:Number(flags.seed)}:{}),...(flags.count?{count:Number(flags.count)}:{}),...(flags.date?{date:flags.date}:{}),...(flags.currencies?{currencies:flags.currencies.split(',')}:{} )});
 await writeFile(flags.out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({synthetic:true,datasets:result.workspace.datasets.length,records:result.workspace.datasets.reduce((n,d)=>n+d.rows.length,0)}));
}
