import {createHash} from 'node:crypto';
export const hash=value=>createHash('sha256').update(value).digest('hex');
export function changedPaths(before,after){
 const all=record=>new Map([...(record?.sources??[]),...(record?.configs??[])].map(item=>[item.path,item.sha256]));
 const a=all(before),b=all(after);
 return [...new Set([...a.keys(),...b.keys()])].filter(path=>a.get(path)!==b.get(path));
}
/** Reuse only corresponding, successful local evidence with the same toolchain/test selection. */
export function checkPlan({previous,basis,environment,app,selection,logsValid,buildValid,fresh=false}){
 const compatible=!fresh&&previous?.version===2&&previous.app===app&&previous.status==='automated-complete'&&previous.environment===environment&&previous.testSelection===selection&&logsValid;
 if(!compatible)return {typecheck:true,tests:true,build:true,mode:'full'};
 const changed=changedPaths(previous.basisBefore,basis);
 if(!changed.length)return {typecheck:false,tests:false,build:!buildValid,mode:'same-inputs'};
 if(changed.every(path=>path.startsWith('client/')))return {typecheck:changed.some(path=>!path.endsWith('.css')),tests:changed.some(path=>!path.endsWith('.css')),build:true,mode:'client-only',manual:'需验证UI与请求合同；仅样式变化可复用类型与测试证据，客户端逻辑变化重跑检查'};
 return {typecheck:true,tests:true,build:true,mode:'full'};
}
