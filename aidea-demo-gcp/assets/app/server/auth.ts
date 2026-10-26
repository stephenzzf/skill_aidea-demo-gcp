import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface AccessConfig {
  codeHash: string;
  expiresAt: number;
  cookieSecret: string;
  secure: boolean;
}
const cookieName = (demoId: string) => `me_demo_access_${createHash('sha256').update(demoId).digest('hex').slice(0,16)}`;
export const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');
function equal(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function version(access: AccessConfig) {
  return hashCode(`${access.codeHash}:${access.expiresAt}`);
}
export function validCode(code: string, access: AccessConfig, now = Date.now()): boolean {
  return now < access.expiresAt && equal(hashCode(code), access.codeHash);
}
export function issueCookie(demoId: string, access: AccessConfig, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ demoId, expiresAt: access.expiresAt, version: version(access) })).toString('base64url');
  const signature = createHmac('sha256', access.cookieSecret).update(payload).digest('base64url');
  return `${cookieName(demoId)}=${payload}.${signature}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor((access.expiresAt - now) / 1000))}${access.secure ? '; Secure' : ''}`;
}
export function authorized(cookie: string | undefined, demoId: string, access: AccessConfig, now = Date.now()): boolean {
  const name = cookieName(demoId);
  const token = cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!token || now >= access.expiresAt) return false;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return false;
  const expected = createHmac('sha256', access.cookieSecret).update(payload).digest('base64url');
  if (!equal(signature, expected)) return false;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!claims || typeof claims !== 'object') return false;
    const v = claims as Record<string, unknown>;
    return v.demoId === demoId && v.expiresAt === access.expiresAt && v.version === version(access);
  } catch { return false; }
}
