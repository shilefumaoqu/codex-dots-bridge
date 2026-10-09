import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { controlSchemas, toolResult, type ControlName } from './mcp.js';
import { readConfig, readToken } from './runtime.js';
import { ProbeError } from './store.js';

export async function localCall(dir:string,name:ControlName|'evidence',args:unknown) {
  const config=readConfig(dir);
  if(!config.endpoint) throw new ProbeError('service_not_started');
  const response=await fetch(new URL(`control/${name}`,config.endpoint),{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(25_000),
    headers:{'content-type':'application/json',authorization:`Bearer ${readToken(dir,'caller')}`},
    body:JSON.stringify(args),
  });
  if(!response.ok) {
    const error=await response.json() as {error?:string};
    throw new ProbeError(error.error??'local_service_failed');
  }
  return response.json();
}
export function startCaller(dir:string) {
  return serveStdio(()=>{
    const server=new McpServer({name:'codex-dots-bridge-p0',version:'0.1.0-p0.1'},
      {instructions:'P0 protocol probe only: submit echo or clarify with a stable idempotency_key, then keep the returned task_id. When clarify waits, show its question and answer via dots_message. Read and display the actual result before dots_ack_result. Never interpret event receipt or claim as completion. No general business tasks yet.'});
    for(const name of Object.keys(controlSchemas) as ControlName[]) {
      server.registerTool(name,{description:`P0 only: ${name}. Fixed harmless probes; not general task execution.`,
        inputSchema:controlSchemas[name],annotations:{readOnlyHint:['dots_get','dots_list','dots_status'].includes(name),destructiveHint:false,idempotentHint:true,openWorldHint:false}},async (args:unknown)=>{
        try {return toolResult(await localCall(dir,name,args));}
        catch(e) {return toolResult({error:e instanceof ProbeError?e.code:'bridge_unavailable'},true);}
      });
    }
    return server;
  },{onerror:()=>{process.stderr.write('P0 MCP transport error\n');}});
}
