import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {parseSpec,parseScenario} from '../assets/app/shared/spec.ts';
import {seedScenario} from './seed-data.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fixture=async name=>JSON.parse(await readFile(resolve(root,`references/examples/v4/${name}-spec.json`),'utf8'));
const run=(...args)=>execFileSync(process.execPath,['--experimental-strip-types',resolve(root,'scripts/generate.mjs'),...args],{encoding:'utf8'});
test('two different V4 domains are seeded deterministically and generated without application source changes',async t=>{
 const temp=await mkdtemp(resolve(tmpdir(),'me-v4-'));t.after(()=>rm(temp,{recursive:true,force:true}));let pages=[];
 for(const name of ['service','subscription']){
  const raw=await fixture(name),spec=parseSpec(raw),data=seedScenario(spec,{seed:7,count:3});assert.equal(spec.presentation.workspaceLayout,'split');assert.deepEqual(data,seedScenario(spec,{seed:7,count:3}));assert.notDeepEqual(data,seedScenario(spec,{seed:8,count:3}));parseScenario(data,spec.workspace,spec);
  const specPath=resolve(temp,name+'-spec.json'),dataPath=resolve(temp,name+'-data.json');await writeFile(specPath,JSON.stringify(raw));await writeFile(dataPath,JSON.stringify(data));const out=resolve(temp,name);
  run('--spec',specPath,'--data',dataPath,'--out',out);const manifest=JSON.parse(await readFile(resolve(out,'generation-manifest.json'),'utf8'));assert.deepEqual(manifest.supportedSpecVersions,[1,2,3,4]);assert.equal(manifest.generatedApplicationCodeLines,0);assert(manifest.templateFeatures.includes('assistant-ui'));
  for(const record of manifest.templateFiles){assert.equal(createHash('sha256').update(await readFile(resolve(out,record.path))).digest('hex'),record.sha256);}
  const generated=JSON.parse(await readFile(resolve(out,'demo-spec.json'),'utf8'));assert.equal(generated.presentation.workspaceLayout,'split');assert.deepEqual(generated.pages,spec.pages);pages.push(spec.pages.map(page=>page.title));
  const before=await readFile(resolve(out,'demo-spec.json'),'utf8');manifest.supportedSpecVersions=[1,2,3];manifest.templateCapabilityVersion=3;await writeFile(resolve(out,'generation-manifest.json'),JSON.stringify(manifest));
  const rejected=spawnSync(process.execPath,['--experimental-strip-types',resolve(root,'scripts/generate.mjs'),'--spec',specPath,'--data',dataPath,'--out',out,'--update']);assert.notEqual(rejected.status,0);assert.equal(await readFile(resolve(out,'demo-spec.json'),'utf8'),before);
 }
 assert.notDeepEqual(pages[0],pages[1]);
});
test('V4 rejects unsupported capability, locale, extra fields and customer-data fabrication',async()=>{
 for(const mutation of [spec=>{spec.capabilities[0].version=2},spec=>{spec.capabilities[0].kind='arbitrary-code'},spec=>{spec.presentation.extra=true},spec=>{spec.presentation.shellLocale='en'},spec=>{spec.capabilities[0].dataset='missing'}]){const spec=await fixture('service');mutation(spec);assert.throws(()=>parseSpec(spec));}
 const spec=parseSpec(await fixture('service'));spec.workspace.datasets[0].origin='customer';assert.throws(()=>seedScenario(spec),/synthetic/);
});

test('finalization binds real files, rejects stale evidence and packages portable evidence without secrets',async t=>{
 const temp=await mkdtemp(resolve(tmpdir(),'me-v4-final-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const spec=await fixture('service'),data=seedScenario(parseSpec(spec)),specPath=resolve(temp,'spec.json'),dataPath=resolve(temp,'data.json'),app=resolve(temp,'app');
 await writeFile(specPath,JSON.stringify(spec));await writeFile(dataPath,JSON.stringify(data));run('--spec',specPath,'--data',dataPath,'--out',app);
 const validation=JSON.parse(await readFile(resolve(app,'validation-record.json'),'utf8'));const reportPath=resolve(temp,'pipeline.json'),log=resolve(temp,'check.log'),manual=resolve(temp,'manual.json');
 await writeFile(log,'Unit fixture for packaging guards, no application tests claimed.');
 await writeFile(reportPath,JSON.stringify({app,status:'automated-complete',steps:[{name:'unit-fixture',exitCode:0,log}],validation:{basisDigest:validation.basis.digest}}));
 await writeFile(resolve(app,'.env.private'),'DO_NOT_PACKAGE');
 const finalize=(...args)=>spawnSync(process.execPath,[resolve(root,'scripts/finalize.mjs'),'--app',app,'--report',reportPath,...args],{encoding:'utf8'});
 await writeFile(manual,JSON.stringify({basisDigest:validation.basis.digest,cases:[{id:'missing-file',status:'verified',evidence:'missing.png'}]}));
 assert.notEqual(finalize('--manual',manual,'--out',resolve(temp,'missing.zip')).status,0);
 assert.notEqual(finalize('--out',resolve(app,'inside.zip')).status,0);
 await writeFile(resolve(temp,'manual.md'),'Explicit local packaging fixture.');
 await writeFile(manual,JSON.stringify({basisDigest:validation.basis.digest,cases:[{id:'fixture',status:'simulated',evidence:'manual.md'}]}));
 const archive=resolve(temp,'app.zip'),packed=finalize('--manual',manual,'--out',archive);assert.equal(packed.status,0,packed.stderr);
 const listing=execFileSync('python3',['-c',"import zipfile,json,sys;z=zipfile.ZipFile(sys.argv[1]);n=z.namelist();assert not any('/.env' in x for x in n);r=json.loads(z.read('app/validation-record.json'));assert all(x['evidence'] in [p.removeprefix('app/') for p in n] for x in r['entries']);print(len(n))",archive],{encoding:'utf8'});assert(Number(listing)>0);
 const parsed=JSON.parse(await readFile(resolve(app,'demo-spec.json'),'utf8'));parsed.title+=' changed';await writeFile(resolve(app,'demo-spec.json'),JSON.stringify(parsed));
 assert.notEqual(finalize('--out',resolve(temp,'stale.zip')).status,0);
 assert.equal(JSON.parse(await readFile(resolve(app,'validation-record.json'),'utf8')).status,'needs-revalidation');
});


test('V4 layout preserves legacy default, validates split and blocks config update on old runtime', async t=>{
 const raw=await fixture('service');delete raw.presentation.workspaceLayout;assert.equal(parseSpec(raw).presentation.workspaceLayout,undefined);
 for(const layout of ['tabs','split']){raw.presentation.workspaceLayout=layout;assert.equal(parseSpec(raw).presentation.workspaceLayout,layout);}
 raw.presentation.workspaceLayout='floating';assert.throws(()=>parseSpec(raw),/workspaceLayout/);
 raw.presentation.workspaceLayout='split';const spec=parseSpec(raw),data=seedScenario(spec);
 const temp=await mkdtemp(resolve(tmpdir(),'me-split-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const specPath=resolve(temp,'spec.json'),dataPath=resolve(temp,'data.json'),out=resolve(temp,'app');
 await writeFile(specPath,JSON.stringify(raw));await writeFile(dataPath,JSON.stringify(data));run('--spec',specPath,'--data',dataPath,'--out',out);
 assert.equal(JSON.parse(await readFile(resolve(out,'demo-spec.json'),'utf8')).presentation.workspaceLayout,'split');
 const manifestPath=resolve(out,'generation-manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
 assert(manifest.templateFeatures.includes('split-workspace-v1'));
 const before=await readFile(resolve(out,'demo-spec.json'),'utf8');manifest.templateFeatures=manifest.templateFeatures.filter(x=>x!=='split-workspace-v1');await writeFile(manifestPath,JSON.stringify(manifest));
 const update=spawnSync(process.execPath,['--experimental-strip-types',resolve(root,'scripts/generate.mjs'),'--spec',specPath,'--data',dataPath,'--out',out,'--update'],{encoding:'utf8'});
 assert.notEqual(update.status,0);assert.match(update.stderr,/不支持split/);assert.equal(await readFile(resolve(out,'demo-spec.json'),'utf8'),before);
});

test('explicit execution validates four capability combinations and blocks older runtime updates', async t => {
 const raw=await fixture('service');
 for(const model of ['simulated','vertex'])for(const data of ['local','bigquery']){raw.execution={model,data};assert.deepEqual(parseSpec(raw).execution,{model,data});}
 for(const invalid of [{model:'test',data:'local'},{model:'vertex',data:'unknown'},{model:'simulated',data:'local',secret:'x'}]){raw.execution=invalid;assert.throws(()=>parseSpec(raw));}
 delete raw.execution;assert.equal(parseSpec(raw).execution,undefined);
 raw.execution={model:'simulated',data:'local'};
 const temp=await mkdtemp(resolve(tmpdir(),'me-execution-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const specPath=resolve(temp,'spec.json'),dataPath=resolve(temp,'data.json'),out=resolve(temp,'app');
 await writeFile(specPath,JSON.stringify(raw));await writeFile(dataPath,JSON.stringify(seedScenario(parseSpec(raw))));run('--spec',specPath,'--data',dataPath,'--out',out);
 const path=resolve(out,'generation-manifest.json'),manifest=JSON.parse(await readFile(path,'utf8'));assert(manifest.templateFeatures.includes('execution-modes-v1'));
 manifest.templateFeatures=manifest.templateFeatures.filter(x=>x!=='execution-modes-v1');await writeFile(path,JSON.stringify(manifest));
 const response=spawnSync(process.execPath,['--experimental-strip-types',resolve(root,'scripts/generate.mjs'),'--spec',specPath,'--data',dataPath,'--out',out,'--update'],{encoding:'utf8'});
 assert.notEqual(response.status,0);assert.match(response.stderr,/execution/);
});
