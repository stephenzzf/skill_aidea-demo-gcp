import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { CapabilityBinding } from '../shared/capabilities.ts';
import type { ActionResult, AnalysisResult, DataRow, FieldDefinition, WorkspaceDefinition, WorkspaceState } from '../shared/workspace.ts';

interface Props { bindings:CapabilityBinding[]; pageId:string; definition:WorkspaceDefinition; result:AnalysisResult|null; state:WorkspaceState; resetKey:number; onState:(state:WorkspaceState)=>void }
const show = (value:unknown)=>value===null||value===undefined?'未关联':String(value);
const isLongText = (field:FieldDefinition) => field.type === 'string' && (
  /(?:^|_)(?:evidence|notes?|reason|description|summary|details|comments?)$/i.test(field.id) ||
  /^(?:content|body)$/i.test(field.id) || /依据|说明|备注|描述|原因|摘要|详情/.test(field.label)
);
export function CapabilityPanel(props:Props) {
  return <>{props.bindings.filter(binding=>binding.pages.includes(props.pageId)&&binding.kind!=='partitioned-analysis').map(binding=><CapabilityForm key={`${binding.id}:${props.resetKey}`} {...props} binding={binding}/>)}</>;
}
function CapabilityForm({binding,definition,result,state,pageId,onState}:Props & {binding:CapabilityBinding}) {
  const [input,setInput]=useState<Record<string,string|number|boolean>>({});
  const errorId=useId();
  const [recordId,setRecordId]=useState(''); const [notice,setNotice]=useState(''); const [error,setError]=useState('');
  const [busy,setBusy]=useState(false); const pending=useRef(false); const generation=useRef(0);
  useEffect(()=>()=>{generation.current++},[]);
  if(binding.kind==='partitioned-analysis') return null;
  const schema=definition.datasets.find(dataset=>dataset.id===binding.dataset)!;
  const rows=result?.datasets.find(dataset=>dataset.id===binding.dataset)?.rows??[];
  const review=binding.kind==='mapping-review';
  const candidates=review ? rows.filter(row=>binding.statusField ? row[binding.statusField]!==binding.resolvedStatus : row[binding.targetField]===null||row[binding.targetField]===undefined||row[binding.targetField]==='') : [];
  const selected=candidates.find(row=>String(row[schema.key])===recordId)??candidates[0];
  const fields:FieldDefinition[]=review ? [{id:'target',label:'关联目标',type:'string',required:true},{id:'evidence',label:'核实依据',type:'string',required:true}] : binding.inputFields.map(id=>schema.fields.find(field=>field.id===id)!);
  async function submit(event:FormEvent) {
    event.preventDefault(); if(pending.current||binding.kind==='partitioned-analysis')return;
    const missing=fields.find(field=>field.required&&(input[field.id]===undefined||input[field.id]===''));
    if(missing){setError(`请填写${missing.label}`);return;}
    if(review&&!selected)return;
    const currentGeneration=generation.current;pending.current=true;setBusy(true);setError('');setNotice('');
    try {
      const response=await fetch('/api/actions',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({state,expectedRevision:state.revision,requestId:crypto.randomUUID(),recordId:review?String(selected![schema.key]):`NEW-${crypto.randomUUID()}`,actionId:`${review?'review':'create'}-${binding.id}`,role:binding.role,domainId:pageId,input})});
      const body=await response.json();
      if(!response.ok)throw Object.assign(new Error(body.error??'操作未通过校验，输入已保留'),{known:true});
      const value=body as ActionResult;
      if(!value.receipt?.simulated||value.state.revision!==state.revision+1)throw new Error('回执格式无效');
      if(currentGeneration!==generation.current)return;
      onState(value.state);setNotice(`${value.receipt.label}：已记录模拟回执。未写真实业务系统。`);setInput({});
    } catch(cause) {
      if(currentGeneration!==generation.current)return;
      setError(cause instanceof Error&&'known' in cause?cause.message:'结果未知，未自动重试。输入已保留；本演示无持久化回执，刷新不能保证恢复。');
    } finally {if(currentGeneration===generation.current){pending.current=false;setBusy(false);}}
  }
  function options(field:FieldDefinition):DataRow[]|undefined {
    const target=review&&field.id==='target'?binding.targetDataset:schema.relations?.find(relation=>relation.field===field.id)?.dataset;
    return target?result?.datasets.find(dataset=>dataset.id===target)?.rows:undefined;
  }
  return <section className="mw-card mw-capability-card" aria-label={binding.label}>
    <h3>{binding.label}</h3><p className="mw-capability-description">模拟角色：{definition.roles.find(role=>role.id===binding.role)?.label??binding.role}。仅改变本次演示状态。</p>
    {notice&&<p className="mw-capability-notice" role="status">{notice}</p>}{error&&<p id={errorId} className="mw-capability-error" role="alert">{error}</p>}
    {review&&!candidates.length?<p className="mw-capability-empty">当前筛选没有待核实映射。</p>:<form onSubmit={submit} className="mw-capability-form" aria-busy={busy} aria-describedby={error?errorId:undefined}>
      {review&&<label className="mw-capability-field mw-capability-field-wide"><span>复核对象</span><select aria-label="复核对象" value={selected?String(selected[schema.key]):''} disabled={busy} onChange={event=>setRecordId(event.target.value)}>{candidates.map(row=><option key={String(row[schema.key])} value={String(row[schema.key])}>{show(row[schema.key])}</option>)}</select></label>}
      {fields.map(field=>{const refs=options(field);const relation=schema.relations?.find(item=>item.field===(review&&field.id==='target'?binding.targetField:field.id));const valueType=review&&field.id==='target'?schema.fields.find(item=>item.id===binding.targetField)!.type:field.type;const target=review&&field.id==='target'?definition.datasets.find(dataset=>dataset.id===binding.targetDataset):definition.datasets.find(dataset=>dataset.id===relation?.dataset);const longText=!refs&&isLongText(field);return <label className={`mw-capability-field${longText?' mw-capability-field-wide':''}`} key={field.id}><span>{field.label}{field.required&&<span className="mw-capability-required" aria-hidden="true"> *</span>}</span>
        {refs&&target?<select aria-label={field.label} disabled={busy} value={String(input[field.id]??'')} required={field.required} onChange={event=>setInput(old=>({...old,[field.id]:event.target.value===''?'':valueType==='number'?Number(event.target.value):valueType==='boolean'?event.target.value==='true':event.target.value}))}><option value="">请选择</option>{refs.map(row=><option key={String(row[target.key])} value={String(row[relation?.target??target.key])}>{show(row[target.key])} · {show(Object.entries(row).find(([key])=>key!==target.key)?.[1])}</option>)}</select>
        :field.type==='boolean'?<select aria-label={field.label} disabled={busy} value={String(input[field.id]??'')} required={field.required} onChange={event=>setInput(old=>({...old,[field.id]:event.target.value==='true'}))}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>
        :longText?<textarea aria-label={field.label} rows={3} disabled={busy} required={field.required} value={String(input[field.id]??'')} onChange={event=>setInput(old=>({...old,[field.id]:event.target.value}))}/>
        :<input aria-label={field.label} type={field.type==='number'?'number':field.type==='date'?'date':'text'} disabled={busy} required={field.required} value={String(input[field.id]??'')} onChange={event=>setInput(old=>({...old,[field.id]:field.type==='number'&&event.target.value!==''?Number(event.target.value):event.target.value}))}/>}</label>})}
      <div className="mw-capability-actions"><button className="mw-button primary" disabled={busy||!result} type="submit">{busy?'正在记录…':review?'确认映射并留存依据':'建立模拟工作项'}</button></div>
    </form>}
  </section>;
}
