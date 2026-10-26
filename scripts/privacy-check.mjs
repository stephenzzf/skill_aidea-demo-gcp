#!/usr/bin/env node
import { readdir, readFile, lstat } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set(['.git', 'node_modules', 'dist', 'evidence', 'coverage', '__pycache__']);
const forbidden = /(?:^|\/)(?:\.env(?:\..*)?|application_default_credentials\.json|credentials\.json|id_rsa|id_ed25519|runtime\.pid|\.DS_Store)$|\.(?:pem|key|log|zip|tgz)$/i;

export function inspectContent(path, text) {
  const findings = [];
  if (forbidden.test(path) && !path.endsWith('/.env.example') && path !== '.env.example') findings.push({path, rule:'private-or-runtime-file'});
  for (const [index, line] of text.split('\n').entries()) {
    const rules = [
      ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/],
      ['personal-home-path', /\/(?:Users|home)\/[a-zA-Z0-9_.-]+\//],
      ['provider-token', /\b(?:AIza[\w-]{30,}|gh[pousr]_[\w]{30,}|github_pat_[\w]{30,}|AKIA[A-Z0-9]{16})\b/],
      ['credential-url', /https?:\/\/[^\s/@]+:[^\s/@]+@/],
    ];
    for (const [rule, regex] of rules) if (regex.test(line)) findings.push({path, line:index+1, rule});
  }
  return findings;
}

async function candidates(dir, found = []) {
  for (const entry of await readdir(dir, {withFileTypes:true})) {
    if (excluded.has(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`不发布符号链接：${relative(root,path)}`);
    if (entry.isDirectory()) await candidates(path, found);
    else if (entry.isFile()) found.push(relative(root,path));
  }
  return found;
}

async function main() {
  if (process.argv.slice(2).some(arg=>arg!=='--staged')) throw new Error('用法：node scripts/privacy-check.mjs [--staged]');
  const staged = process.argv.includes('--staged');
  const files = staged
    ? execFileSync('git',['diff','--cached','--name-only','--diff-filter=ACMRT','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean)
    : await candidates(root);
  const findings = [];
  for (const path of files) {
    const blob = staged ? execFileSync('git',['show',`:${path}`],{cwd:root,maxBuffer:10*1024*1024}) : await readFile(resolve(root,path));
    if (staged && path.split('/').some(part=>excluded.has(part))) findings.push({path,rule:'excluded-runtime-tree'});
    if (staged && (await lstat(resolve(root,path))).isSymbolicLink()) findings.push({path,rule:'symlink'});
    findings.push(...inspectContent(path,blob.toString('utf8')));
  }
  console.log(JSON.stringify({files:files.length,findings,status:findings.length?'failed':'passed',scope:staged?'exact-staged-blobs':'working-copy-excluding-runtime-trees'},null,2));
  if (findings.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{console.error(error.message);process.exitCode=1;});
