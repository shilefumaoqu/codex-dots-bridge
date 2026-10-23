// Read only the Tunnel's health snapshot. No MCP calls or raw response fields
// are forwarded: startup evidence is not proof of continued worker reachability.
export type TunnelConnection = 'starting'|'ready'|'auth_required'|'failed'|'unknown';
export type TunnelConnectionReason = 'startup_pending'|'startup_ready'|'auth_required'|'startup_failed'|'startup_timeout'|'component_failed'|'health_conflict'|'health_unavailable'|'health_unsupported'|'startup_unconfirmed'|'not_configured';
export interface TunnelConnectionDiagnostic {
  tunnel_connection:TunnelConnection;
  tunnel_connection_reason:TunnelConnectionReason;
  tunnel_checked_at:string;
}
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const snapshot=(state:TunnelConnection,reason:TunnelConnectionReason):TunnelConnectionDiagnostic=>({tunnel_connection:state,tunnel_connection_reason:reason,tunnel_checked_at:new Date().toISOString()});

async function healthJson(url:URL,signal:AbortSignal):Promise<{unsupported?:boolean;value?:unknown}> {
  const response=await fetch(url,{method:'GET',signal,redirect:'error'});
  if(!response.ok){await response.body?.cancel();return {unsupported:response.status===404||response.status===405};}
  // Bound health payloads as well as elapsed time. Never retain arbitrary bodies.
  const reader=response.body?.getReader();if(!reader)return {};
  const chunks:Uint8Array[]=[];let length=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>256*1024){await reader.cancel();return {};}chunks.push(value);}
    return {value:JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown};
  }catch{return {};}
  finally{reader.releaseLock();}
}

export async function tunnelHealthSnapshot(base:URL) {
  const signal=AbortSignal.timeout(1500);
  const ready=async()=>{
    try{const response=await fetch(new URL('readyz',base),{method:'GET',signal,redirect:'error'});await response.body?.cancel();return response.ok?'ready' as const:'not_ready' as const;}
    catch{return 'unreachable' as const;}
  };
  const health=async()=>{
    try {
      const result=await healthJson(new URL('health?details=true',base),signal);
      // Older clients may expose the component endpoint only. Do not mask an
      // invalid full snapshot with a second, possibly contradictory snapshot.
      if(result.unsupported)return {component:true,...await healthJson(new URL('health/mcp',base),signal)};
      return {component:false,...result};
    }catch{return {component:false};}
  };
  const [tunnel_health,observed]=await Promise.all([ready(),health()]);
  const full=object('value' in observed?observed.value:undefined);
  const result=(state:TunnelConnection,reason:TunnelConnectionReason)=>({tunnel_health,...snapshot(state,reason)});
  if(full.schema_version!==1)return result('unknown','health_unsupported');
  const mcp=observed.component?(full.component==='mcp'?full:{}):object(object(full.components).mcp);
  const details=object(mcp.details),probe=object(details.startup_probe).state;
  if(details.channel!=='main'||details.transport!=='http-streamable')return result('unknown','startup_unconfirmed');
  if(probe==='failed')return result('failed','startup_failed');
  if(probe==='timed_out')return result('failed','startup_timeout');
  if(!observed.component) {
    const components=object(full.components);
    if(['oauth','harpoon'].some(name=>object(components[name]).state==='failed'))return result('failed','component_failed');
  }
  if(probe==='auth_required')return result('auth_required','auth_required');
  if(tunnel_health==='unreachable')return result('unknown','health_unavailable');
  if(!observed.component&&(typeof full.ready!=='boolean'||full.ready!==(tunnel_health==='ready')))return result('unknown','health_conflict');
  if(probe==='pending')return tunnel_health==='ready'?result('unknown','health_conflict'):result('starting','startup_pending');
  if(probe==='succeeded'&&tunnel_health==='ready')return result('ready','startup_ready');
  return result('unknown',probe==='succeeded'?'health_conflict':'startup_unconfirmed');
}
