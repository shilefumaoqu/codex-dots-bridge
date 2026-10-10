import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
/** Convert only local drive extended paths, never UNC/device namespaces. */
export function normalizeConversationPath(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) return fail('target_path_invalid');
  let candidate = value;
  if (candidate.startsWith('\\\\?\\')) {
    if (!/^\\\\\?\\[a-z]:[\\/]/i.test(candidate)) return fail('target_path_invalid');
    candidate = candidate.slice(4);
  }
  if (candidate.startsWith('\\\\') || candidate.startsWith('//') || /^\\[?.]\\/.test(candidate)) return fail('target_path_invalid');
  if (/^[a-z]:[\\/]/i.test(candidate)) {
    if (candidate.slice(2).includes(':') || candidate.split(/[\\/]/).some(part => part !== '.' && part !== '..' && /[ .]$/.test(part))) return fail('target_path_invalid');
    return path.win32.normalize(candidate);
  }
  if (process.platform !== 'win32' && path.posix.isAbsolute(candidate)) return path.posix.normalize(candidate);
  return fail('target_path_invalid');
}
const api = (value: string) => /^[a-z]:\\/i.test(value) ? path.win32 : path.posix;
function noRedirect(pathname: string) {
  const paths = api(pathname);
  for (let cursor = pathname;;) {
    try { if (lstatSync(cursor).isSymbolicLink()) fail('target_path_invalid'); }
    catch (error) { if ((error as {code?: string}).code === 'target_path_invalid') throw error; fail('log_unavailable'); }
    const parent = paths.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function inside(root: string, candidate: string) {
  const paths = api(root), rel = paths.relative(root, candidate);
  return !!rel && !paths.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + paths.sep);
}
/** Exact snapshot path only. No directory walking, DB lookup, or alternate target. */
export function resolveConversationPath(candidate: string, codexHome?: string): string {
  const normalized = normalizeConversationPath(candidate);
  const home = codexHome !== undefined ? normalizeConversationPath(codexHome) : undefined;
  if (home) {
    const paths = api(home);
    if (!inside(paths.join(home, 'sessions'), normalized) && !inside(paths.join(home, 'archived_sessions'), normalized)) fail('target_path_invalid');
    noRedirect(home);
  }
  noRedirect(normalized);
  let actual: string;
  try {
    const stat = lstatSync(normalized); if (!stat.isFile()) fail('log_unavailable');
    actual = normalizeConversationPath(realpathSync(normalized));
  } catch (error) { if ((error as {code?: string}).code === 'target_path_invalid') throw error; return fail('log_unavailable'); }
  if (!samePath(normalized, actual)) fail('target_path_invalid');
  if (home) {
    let actualHome: string; try { actualHome = normalizeConversationPath(realpathSync(home)); } catch { return fail('target_path_invalid'); }
    if (!samePath(home, actualHome)) fail('target_path_invalid');
    const paths = api(actualHome);
    if (!inside(paths.join(actualHome, 'sessions'), actual) && !inside(paths.join(actualHome, 'archived_sessions'), actual)) fail('target_path_invalid');
  }
  return actual;
}
