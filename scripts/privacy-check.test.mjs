import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectContent } from './privacy-check.mjs';

test('privacy guard reports categories and locations without returning matched values',()=>{
  const privateKey=['-----BEGIN','PRIVATE KEY-----'].join(' ');
  const home=['','Users','sample-owner','private','config.json'].join('/');
  const result=inspectContent('sample.txt',`${privateKey}\n${home}`);
  assert.deepEqual(result.map(x=>x.rule),['private-key','personal-home-path']);
  assert.equal(JSON.stringify(result).includes('sample-owner'),false);
});
test('guard rejects runtime credential paths but permits documentation and variable names',()=>{
  assert.equal(inspectContent('private/.env.production','').length,1);
  assert.equal(inspectContent('.env.example','DEMO_COOKIE_SECRET=<generated-privately>').length,0);
  assert.equal(inspectContent('README.md','Read DEMO_ACCESS_CODE_HASH from server-side configuration.').length,0);
});
