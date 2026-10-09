import { McpServer, createMcpHandler, ProtocolError, type ServerCapabilities } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ProbeStore, ProbeError } from './store.js';
import { ProbeEvents, catalog, subscribeParams, unsubscribeParams } from './events.js';
import { CallbackError } from './webhook.js';

const id = z.string().uuid();
const key = z.string().min(1).max(128);
const claim = {task_id:id,claim_token:z.string().min(32).max(128)};
const revision = z.number().int().positive();
const result = z.object({nonce:z.string().regex(/^[a-f0-9]{32}$/),color:z.enum(['blue','green']).optional()}).strict();
export function toolResult(value: unknown, error=false) {
  return {content:[{type:'text' as const,text:JSON.stringify(value)}],isError:error};
}
function safe<T>(fn:()=>T) {
  try { return toolResult(fn()); } catch(error) {
    return toolResult({error:error instanceof ProbeError?error.code:'internal_error'},true);
  }
}
export function workerServer(store:ProbeStore, events:ProbeEvents) {
  const capabilities:ServerCapabilities & {events:Record<string,never>}={tools:{},events:{}};
  const server=new McpServer({name:'codex-dots-bridge-p0-worker',version:'0.1.0-p0.1'},
    {capabilities,instructions:'P0 harmless protocol probe. On task.available, call list_tasks and get_task, then claim_task. Follow the task instruction. Keep claim_token private and checkpoint before complete_task. Clarification releases the slot; reclaim the SAME task with a fresh claim_key after its answer. Never send external messages or access external files for these probes.'});
  const annotations=(read:boolean)=>({readOnlyHint:read,destructiveHint:false,idempotentHint:true,openWorldHint:false});
  server.registerTool('list_tasks',{description:'List harmless P0 tasks and their current state.',inputSchema:z.object({}),annotations:annotations(true)},()=>safe(()=>store.list()));
  server.registerTool('get_task',{description:'Read the current revision and pending question or answer.',inputSchema:z.object({task_id:id}),annotations:annotations(true)},p=>safe(()=>store.get(p.task_id)));
  server.registerTool('claim_task',{description:'Claim the queue head. Reuse claim_key only when retrying the same claim; use a new key after clarification.',inputSchema:z.object({task_id:id,claim_key:key}),annotations:annotations(false)},p=>safe(()=>store.claim(p.task_id,p.claim_key)));
  server.registerTool('checkpoint_task',{description:'Confirm the current input revision and renew the execution lease.',inputSchema:z.object({...claim,input_revision:revision}),annotations:annotations(false)},p=>safe(()=>store.checkpoint(p.task_id,p.claim_token,p.input_revision)));
  server.registerTool('request_input',{description:'Ask the fixed P0 question (blue or green), save it and release the execution slot.',inputSchema:z.object(claim),annotations:annotations(false)},p=>safe(()=>store.requestInput(p.task_id,p.claim_token)));
  server.registerTool('complete_task',{description:'Persist the actual P0 result body, using a stable completion_key for retries.',inputSchema:z.object({...claim,input_revision:revision,completion_key:key,result}),annotations:annotations(false)},p=>safe(()=>store.complete(p.task_id,p.claim_token,p.input_revision,p.completion_key,p.result)));
  server.registerTool('fail_task',{description:'Report that the harmless probe could not be completed.',inputSchema:z.object(claim),annotations:annotations(false)},p=>safe(()=>store.fail(p.task_id,p.claim_token)));
  server.server.setRequestHandler('events/list',{params:z.object({cursor:z.null().optional()}).default({})},async()=>catalog);
  server.server.setRequestHandler('events/subscribe',{params:subscribeParams},async p=>{
    try { return await events.subscribe(p); } catch(e) {
      if(e instanceof CallbackError) throw new ProtocolError(-32015,'CallbackEndpointError',{reason:e.reason});
      if(e instanceof ProbeError) throw new ProtocolError(-32602,e.code);
      throw new ProtocolError(-32603,'subscription_failed');
    }
  });
  server.server.setRequestHandler('events/unsubscribe',{params:unsubscribeParams},async p=>events.unsubscribe(p));
  return server;
}
export function workerHandler(store:ProbeStore, events:ProbeEvents) {
  return createMcpHandler(()=>workerServer(store,events),{legacy:'reject',responseMode:'json',maxRequestBodySize:262144});
}
export const controlSchemas={
  dots_submit:z.object({case:z.enum(['echo','clarify']),idempotency_key:key}).strict(),
  dots_list:z.object({}).strict(),
  dots_get:z.object({task_id:id}).strict(),
  dots_message:z.object({task_id:id,question_id:id,answer:z.enum(['blue','green'])}).strict(),
  dots_ack_result:z.object({task_id:id,result_id:id}).strict(),
  dots_status:z.object({}).strict(),
};
export type ControlName=keyof typeof controlSchemas;
export function controlCall(store:ProbeStore,name:ControlName,args:unknown) {
  switch(name) {
    case 'dots_submit': {const p=controlSchemas[name].parse(args);return store.submit(p.case,p.idempotency_key);}
    case 'dots_list':controlSchemas[name].parse(args);return store.list();
    case 'dots_get': {
      const task=store.get(controlSchemas[name].parse(args).task_id);
      store.audit('caller_task_read',task.task_id,{status:task.status,result_id:task.result_id});
      return task;
    }
    case 'dots_message': {const p=controlSchemas[name].parse(args);return store.answer(p.task_id,p.question_id,p.answer);}
    case 'dots_ack_result': {const p=controlSchemas[name].parse(args);return store.ack(p.task_id,p.result_id);}
    case 'dots_status':controlSchemas[name].parse(args);return store.status();
  }
}
