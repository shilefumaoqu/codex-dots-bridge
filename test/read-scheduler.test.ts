import assert from 'node:assert/strict';
import test from 'node:test';
import { ReadScheduler, historyReadScheduler } from '../src/read-scheduler.js';

test('shared reader admits two active and sixteen queued; rejected admission starts no source', async () => {
  const scheduler=new ReadScheduler(), controller=new AbortController();
  const releases:Array<()=>void>=[];let started=0;
  const work=Array.from({length:18},()=>scheduler.reserve().run(controller.signal,async()=>{
    started++;await new Promise<void>(resolve=>releases.push(resolve));
  }));
  await Promise.resolve();assert.equal(started,2);assert.deepEqual(scheduler.status,{active:2,queued:16,capacity:18});
  assert.throws(()=>scheduler.reserve(),error=>(error as {code:string}).code==='history_read_capacity');
  while(started<18){releases.splice(0).forEach(release=>release());await new Promise(resolve=>setImmediate(resolve));assert(scheduler.status.active<=2);}
  releases.splice(0).forEach(release=>release());await Promise.all(work);
  assert.deepEqual(scheduler.status,{active:0,queued:0,capacity:18});
});

test('aborted queued reads never start and failure/unused admission release capacity', async () => {
  const scheduler=new ReadScheduler(1,1),active=new AbortController(),queued=new AbortController();
  let release!:()=>void, queuedStarted=false;
  const first=scheduler.reserve().run(active.signal,()=>new Promise<void>(resolve=>release=resolve));
  const second=scheduler.reserve().run(queued.signal,async()=>{queuedStarted=true;});
  queued.abort();await assert.rejects(second,/read_cancelled/);assert.equal(queuedStarted,false);
  const reserved=scheduler.reserve();reserved.cancel();reserved.cancel();
  await Promise.resolve();release();await first;
  await assert.rejects(scheduler.reserve().run(active.signal,async()=>{throw Error('source failure');}),/source failure/);
  assert.equal(scheduler.status.active,0);assert.equal(scheduler.status.queued,0);
});

test('services sharing a database share admission and operation starts only after acquisition', async () => {
  const database={},scheduler=historyReadScheduler(database);assert.equal(scheduler,historyReadScheduler(database));
  assert.notEqual(scheduler,historyReadScheduler({}));
  const signal=new AbortController().signal;let now=0;const release:Array<()=>void>=[];
  const a=scheduler.reserve().run(signal,()=>new Promise<void>(resolve=>release.push(resolve)));
  const b=scheduler.reserve().run(signal,()=>new Promise<void>(resolve=>release.push(resolve)));
  const c=scheduler.reserve().run(signal,async()=>now+60000);
  await Promise.resolve();now=100000;release[0]!();
  assert.equal(await c,160000);release[1]!();await Promise.all([a,b]);
});
