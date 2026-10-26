#!/usr/bin/env node
import { randomBytes, createHash } from 'node:crypto';
import { open, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { privateFilePath } from './private-path.mjs';

const path = process.argv[2];
const rest = process.argv.slice(3);
const mode = rest.length === 0 ? 'simulated' : rest.length === 2 && rest[0] === '--mode' ? rest[1] : undefined;
if (!path || !isAbsolute(path) || !path.endsWith('.env') || !['simulated', 'vertex', 'test'].includes(mode ?? '')) {
  console.error('用法：npm run access -- /绝对路径/私有目录/demo.env [--mode simulated|vertex|test]；默认simulated，test仅内部验证；文件不得已存在');
  process.exit(1);
}
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
await privateFilePath(path, true);
const code = randomBytes(18).toString('base64url');
const expiresAt = new Date(Date.now() + 86400000).toISOString();
const handle = await open(path, 'wx', 0o600);
try {
  await handle.writeFile([
    `DEMO_MODEL_MODE=${mode}`,
    `DEMO_ACCESS_CODE_HASH=${createHash('sha256').update(code).digest('hex')}`,
    `DEMO_COOKIE_SECRET=${randomBytes(32).toString('base64url')}`,
    `DEMO_ACCESS_EXPIRES_AT=${expiresAt}`,
    // The raw code is private operator material; the server never reads it.
    `DEMO_OPERATOR_ACCESS_CODE=${code}`,
    '',
  ].join('\n'));
} finally { await handle.close(); }
console.log(`访问配置已写入私有文件；有效期至 ${expiresAt}。从文件读取 DEMO_OPERATOR_ACCESS_CODE 分享给演示对象，不将该文件加入 Git。`);
