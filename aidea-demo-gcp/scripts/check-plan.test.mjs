import test from 'node:test';
import assert from 'node:assert/strict';
import {checkPlan} from './check-plan.mjs';
const original={digest:'a',sources:[{path:'client/App.tsx',sha256:'a'},{path:'client/styles.css',sha256:'a'},{path:'server/app.ts',sha256:'a'},{path:'tests/domain-api.test.ts',sha256:'a'}],configs:[{path:'scenario.json',sha256:'a'}]};
const previous={version:2,app:'/app',status:'automated-complete',environment:'node-a',testSelection:'default',basisBefore:original};
const input={previous,basis:original,environment:'node-a',app:'/app',selection:'default',logsValid:true,buildValid:true};
test('reuse requires the same source, successful evidence, environment and test selection',()=>{
 assert.deepEqual(checkPlan(input),{typecheck:false,tests:false,build:false,mode:'same-inputs'});
 for(const override of [{logsValid:false},{fresh:true},{environment:'node-b'},{selection:'subset'},{previous:{...previous,status:'failed'}},{previous:{...previous,version:1}},{app:'/other'}])assert.equal(checkPlan({...input,...override}).mode,'full');
 assert.equal(checkPlan({...input,buildValid:false}).build,true);
});
test('client-only changes require UI verification; backend, contracts, tests and data always invalidate tests',()=>{
 const change=path=>({...original,sources:original.sources.map(item=>item.path===path?{...item,sha256:'b'}:item)});
 assert.equal(checkPlan({...input,basis:change('client/App.tsx')}).tests,true);
 assert.equal(checkPlan({...input,basis:change('client/styles.css')}).typecheck,false);
 assert.equal(checkPlan({...input,basis:change('client/styles.css')}).tests,false);
 for(const path of ['server/app.ts','tests/domain-api.test.ts'])assert.equal(checkPlan({...input,basis:change(path)}).tests,true);
 assert.equal(checkPlan({...input,basis:{...original,configs:[{path:'scenario.json',sha256:'b'}]}}).tests,true);
 assert.equal(checkPlan({...input,basis:{...original,sources:[...original.sources,{path:'shared/contracts.ts',sha256:'new'}]}}).tests,true);
});
