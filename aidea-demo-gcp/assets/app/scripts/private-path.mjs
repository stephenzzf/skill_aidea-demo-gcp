import { realpath } from 'node:fs/promises';
import { dirname, basename, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const appRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
export async function privateFilePath(path, creating = false) {
  if (!isAbsolute(path)) throw new Error('私有环境文件必须使用绝对路径');
  const canonical = creating ? resolve(await realpath(dirname(path)), basename(path)) : await realpath(path);
  const fromApp = relative(appRoot, canonical);
  if (!fromApp.startsWith(`..${sep}`)) throw new Error('私有环境文件必须位于应用目录之外，避免进入构建上下文');
  return canonical;
}
