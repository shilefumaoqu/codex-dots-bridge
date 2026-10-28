import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';

export interface TraySubscription {
  state:'valid'|'expiring'|'expired'|'missing'|'unknown';
  active_count:number|null;
  id:string|null;
  expires_at:string|null;
}
export const unknownTraySubscription=():TraySubscription=>({state:'unknown',active_count:null,id:null,expires_at:null});
const expiringMs=2*60*60*1000;
function timestamp(value:unknown):number|null {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))return null;
  const parsed=Date.parse(value);
  if(!Number.isFinite(parsed))return null;
  const canonical=value.replace(/(?:\.(\d{1,3}))?Z$/,(_match,fraction:string|undefined)=>'.'+(fraction??'').padEnd(3,'0')+'Z');
  return new Date(parsed).toISOString()===canonical?parsed:null;
}

/** Pure projection of the current authenticated status, with no store access or maintenance. */
export function projectTraySubscription(subscriptions:unknown,count:unknown,now:number):TraySubscription {
  if(!Number.isFinite(now)||!Array.isArray(subscriptions)||!Number.isSafeInteger(count)||Number(count)<0)return unknownTraySubscription();
  const rows:Array<{id:string|null;active:boolean;expires:number}>=[];
  for(const value of subscriptions) {
    if(!value||typeof value!=='object'||Array.isArray(value))return unknownTraySubscription();
    const row=value as Record<string,unknown>,expires=timestamp(row.expires_at);
    if(typeof row.active!=='boolean'||expires===null||typeof row.id!=='string'||!/^sub_[a-f0-9]{40}$/.test(row.id))return unknownTraySubscription();
    rows.push({id:row.id,active:row.active,expires});
  }
  // Count consistency is checked against the service snapshot. An active row can
  // expire while that response is in flight; the current clock still wins below.
  if(rows.filter(row=>row.active).length!==count)return unknownTraySubscription();
  const active=rows.filter(row=>row.active&&row.expires>now).sort((a,b)=>a.expires-b.expires);
  const selected=active[0];
  if(selected)return {state:selected.expires-now<=expiringMs?'expiring':'valid',active_count:active.length,id:selected.id,expires_at:new Date(selected.expires).toISOString()};
  // Without a live route, the most recent expiry bounds the latest known lease.
  // A newer stopped lease must not be hidden by an older expired record.
  const latest=rows.sort((a,b)=>b.expires-a.expires)[0];
  return latest&&latest.expires<=now?{state:'expired',active_count:0,id:latest.id,expires_at:new Date(latest.expires).toISOString()}:{state:'missing',active_count:0,id:null,expires_at:null};
}

/** Shared with the tray: full path, slash separators, Windows lower case, no
 * trailing slash except a drive root, LF, then lower-case instance UUID. Windows
 * extended drive/UNC paths share their ordinary spelling; device/other objects
 * are unsupported. Keep this normalization aligned with StatusClient.DataBinding.
 * The caller must reject reparse points before binding an actual directory. */
export function trayDataBinding(dir:string,instanceId:string,platform:NodeJS.Platform=process.platform):string {
  let source=dir;
  if(platform==='win32') {
    source=source.replace(/\\/g,'/');
    if(source.startsWith('//./'))throw new Error('unsupported_data_path');
    if(source.startsWith('//?/')) {
      if(/^\/\/\?\/UNC\/[^/]+\/[^/]+(?:\/|$)/i.test(source))source='//'+source.slice(8);
      else if(/^\/\/\?\/[a-z]:\//i.test(source))source=source.slice(4);
      else throw new Error('unsupported_data_path');
    }
  }
  let path=(platform==='win32'?win32:posix).resolve(source).replace(/\\/g,'/');
  if(platform==='win32')path=path.toLowerCase();
  if(!/^[a-z]:\/$/i.test(path)&&path!=='/')path=path.replace(/\/+$/,'');
  return createHash('sha256').update(path+'\n'+instanceId.toLowerCase(),'utf8').digest('hex');
}
