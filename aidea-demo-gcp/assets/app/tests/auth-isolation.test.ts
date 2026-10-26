import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {authorized,issueCookie,hashCode} from '../server/auth.ts';

test('independent demo cookies coexist on one hostname without accepting another demo token',()=>{
 const access={codeHash:hashCode('local-test-only'),expiresAt:Date.now()+60000,cookieSecret:randomBytes(32).toString('hex'),secure:false};
 const first=issueCookie('first-demo',access).split(';')[0],second=issueCookie('second-demo',access).split(';')[0];
 assert.notEqual(first.split('=')[0],second.split('=')[0]);
 assert(authorized(`${first}; ${second}`,'first-demo',access));
 assert(authorized(`${first}; ${second}`,'second-demo',access));
 assert(!authorized(second,'first-demo',access));
 assert(!authorized(first,'first-demo',{...access,cookieSecret:randomBytes(32).toString('hex')}));
 assert(!authorized(first,'first-demo',access,access.expiresAt));
});
