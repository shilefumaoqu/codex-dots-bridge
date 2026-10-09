import Fastify from 'fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ProbeStore, ProbeError } from './store.js';
import { ProbeEvents } from './events.js';
import { workerHandler, controlCall, controlSchemas, type ControlName } from './mcp.js';

const equal=(actual:string|undefined,expected:string)=>{
  const a=Buffer.from(actual??''),b=Buffer.from(expected);
  return a.length===b.length && timingSafeEqual(a,b);
};
export function createService(store:ProbeStore,events:ProbeEvents,tokens:{caller:string;worker:string}) {
  const app=Fastify({logger:false,bodyLimit:262144});
  const mcp=workerHandler(store,events);
  const handle=toNodeHandler(mcp,{maxRequestBodySize:262144});
  app.addHook('onRequest',async(request,reply)=>{
    const host=request.headers.host??'';
    if(!/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host) || request.headers.origin!==undefined) {
      return reply.code(403).send({error:'local_client_required'});
    }
    // Authenticate the router's matched route, not the raw URL (which may include a query).
    const route=request.routeOptions.url;
    if(route==='/mcp/dot') {
      const header=request.headers['x-codex-dots-worker-token'];
      if(!equal(typeof header==='string'?header:undefined,tokens.worker)) return reply.code(401).send({error:'unauthorized_worker'});
    } else if(route==='/control/:name') {
      if(!equal(request.headers.authorization,`Bearer ${tokens.caller}`)) return reply.code(401).send({error:'unauthorized_caller'});
    }
  });
  app.setErrorHandler((error,_request,reply)=>{
    const validation=error instanceof z.ZodError;
    const code=validation?'invalid_parameters':error instanceof ProbeError?error.code:'request_failed';
    const status=validation?400:error instanceof ProbeError?409:(error as {statusCode?:number}).statusCode??500;
    reply.code(status).send({error:code});
  });
  app.get('/health',async()=>({phase:'P0',service:'codex-dots-bridge',production_ready:false}));
  app.all('/mcp/dot',async(request,reply)=>{
    const body=request.body as {method?:unknown}|undefined;
    const method=typeof body?.method==='string' && /^(server\/discover|tools\/(list|call)|events\/(list|subscribe|unsubscribe))$/.test(body.method)?body.method:'other';
    store.audit('worker_protocol_request',null,{method});
    reply.hijack();
    await handle(request.raw,reply.raw,request.body);
  });
  app.post<{Params:{name:string}}>('/control/:name',async request=>{
    const name=request.params.name;
    if(name==='evidence') {z.object({}).strict().parse(request.body);return store.evidence();}
    if(!Object.hasOwn(controlSchemas,name)) throw new ProbeError('unknown_operation');
    return controlCall(store,name as ControlName,request.body);
  });
  let timer:NodeJS.Timeout|undefined;
  return {
    app,
    async start(port=0) {
      const address=await app.listen({host:'127.0.0.1',port});
      timer=setInterval(()=>{void events.pump().catch(()=>store.audit('event_pump_error'));},1000);
      timer.unref(); return address+'/';
    },
    async close() {
      if(timer) clearInterval(timer);
      await app.close(); await mcp.close(); await events.settled();
    },
  };
}
