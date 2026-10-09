import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { type ProbeStore, ProbeError, hash } from './store.js';
import { postSigned, validateSecret, callbackUrl, CallbackError } from './webhook.js';

export const eventArgs = z.object({queue:z.enum(['p0','tasks'])}).strict();
export const subscribeParams = z.object({
  name:z.literal('task.available'), arguments:eventArgs,
  delivery:z.object({mode:z.literal('webhook'),url:z.string().max(4096),secret:z.string().max(128)}).strict(),
  cursor:z.null().optional(), ttlMs:z.number().int().positive().nullable().optional(),
});
export const unsubscribeParams = subscribeParams.omit({ttlMs:true,cursor:true}).extend({
  delivery:z.object({mode:z.literal('webhook'),url:z.string().max(4096)}).strict(),
});
export const subscriptionResult = z.object({id:z.string(),refreshBefore:z.string().datetime(),cursor:z.null(),truncated:z.literal(false)});
export function eventCatalog(queue:'p0'|'tasks') {
  return {events:[{name:'task.available',
    description:queue==='p0'?'A harmless P0 probe is ready. Read get_task.':'A Codex Dots Bridge task is ready or resumed. Read the current task before claiming.',
    delivery:['webhook'], inputSchema:z.toJSONSchema(z.object({queue:z.literal(queue)}).strict()),
    payloadSchema:{type:'object',properties:{task_id:{type:'string'},queue:{const:queue}},required:['task_id','queue'],additionalProperties:false},
  }]};
}
export const catalog=eventCatalog('p0');
type EventStore = Pick<ProbeStore,'now'|'sweep'|'subscriptions'|'saveSubscription'|'unsubscribe'|'pending'|'isDeliveryPending'|'deliveryResult'>;
type Sender = typeof postSigned;
export class ProbeEvents {
  private busy=false;
  private subscriptionChange: Promise<unknown> = Promise.resolve();
  constructor(readonly store: EventStore, private readonly send: Sender = postSigned, readonly queue:'p0'|'tasks'='p0') {}
  private id(url:string) { return `sub_${hash(JSON.stringify([this.queue==='p0'?'p0-worker':'codex-dots-worker',url,'task.available',{queue:this.queue}])).slice(0,40)}`; }
  // Serialize refresh/unsubscribe with callback verification to prevent resurrection races.
  private serialized<T>(operation:()=>Promise<T>):Promise<T> {
    const next=this.subscriptionChange.then(operation,operation);
    this.subscriptionChange=next.catch(()=>undefined); return next;
  }
  subscribe(input:z.infer<typeof subscribeParams>) {
    return this.serialized(async()=>{
      const params=subscribeParams.parse(input);
      if(params.arguments.queue!==this.queue) throw new ProbeError('invalid_queue');
      validateSecret(params.delivery.secret);
      const url=callbackUrl(params.delivery.url).href;
      const id=this.id(url), now=this.store.now();
      const previous=this.store.subscriptions().find(s=>s.id===id);
      const cached=previous?.active && previous.verified_until>now && previous.secret===params.delivery.secret;
      if (!cached) {
        const challenge=randomUUID();
        const response=await this.send(url,params.delivery.secret,id,`verification_${randomUUID()}`,{type:'verification',challenge});
        let returned:unknown;
        try { returned=(JSON.parse(response.body) as {challenge?:unknown}).challenge; } catch { /* categorized below */ }
        const a=Buffer.from(challenge), b=Buffer.from(typeof returned==='string'?returned:'');
        if (response.status<200 || response.status>=300 || a.length!==b.length || !timingSafeEqual(a,b)) {
          throw new CallbackError('challenge_failed');
        }
      }
      const expires=this.store.now()+Math.min(86_400_000,Math.max(60_000,params.ttlMs??86_400_000));
      const rotated=previous?.secret!==params.delivery.secret && previous?.active;
      this.store.saveSubscription({id,url,secret:params.delivery.secret,expires_at:expires,active:true,
        generation:(previous?.generation??0)+1,
        verified_until:cached?previous.verified_until:this.store.now()+300_000,
        previous_secret:rotated?previous.secret:previous?.previous_secret,
        rotation_until:rotated?this.store.now()+300_000:previous?.rotation_until});
      return subscriptionResult.parse({id,refreshBefore:new Date(expires).toISOString(),cursor:null,truncated:false});
    });
  }
  unsubscribe(input:z.infer<typeof unsubscribeParams>) {
    return this.serialized(async()=>{
      const p=unsubscribeParams.parse(input);
      if(p.arguments.queue!==this.queue) throw new ProbeError('invalid_queue');
      this.store.unsubscribe(this.id(callbackUrl(p.delivery.url).href)); return {};
    });
  }
  async pump() {
    if (this.busy) return;
    this.busy=true;
    try {
      this.store.sweep();
      for (const item of this.store.pending()) {
        // The batch is a snapshot; unsubscribe may have stopped later items during a prior await.
        if(!this.store.isDeliveryPending(item.id)) continue;
        const sub=this.store.subscriptions().find(s=>s.id===item.subscription_id);
        if (!sub || !sub.active || sub.expires_at<=this.store.now()) { this.store.deliveryResult(item,410); continue; }
        try {
          const response=await this.send(sub.url,sub.secret,sub.id,item.event_id,JSON.parse(item.payload),
            (sub.rotation_until??0)>this.store.now()?sub.previous_secret:undefined);
          // A refresh or stop/re-subscribe may complete while this request is in flight.
          // Its response belongs to the old generation; retry pending work with current credentials.
          if(this.store.subscriptions().find(s=>s.id===sub.id)?.generation!==sub.generation) continue;
          this.store.deliveryResult(item,response.status);
          if (response.status===410) this.store.unsubscribe(sub.id,sub.generation);
        } catch {
          if(this.store.subscriptions().find(s=>s.id===sub.id)?.generation===sub.generation) this.store.deliveryResult(item,0);
        }
      }
    } finally { this.busy=false; }
  }
  async settled() { await this.subscriptionChange; while(this.busy) await new Promise(r=>setTimeout(r,25)); }
}
