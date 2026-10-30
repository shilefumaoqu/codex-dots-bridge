/** A shared admission budget for source reads. Queueing does not consume a read deadline. */
export class ReadCapacityError extends Error {
  readonly code = 'history_read_capacity';
  readonly accepted = false;
  constructor() { super('history_read_capacity'); }
}

export interface ReadReservation {
  run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T>;
  cancel(): void;
}

export class ReadScheduler {
  private admitted = 0;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(readonly maxActive = 2, readonly maxQueued = 16) {
    if (!Number.isSafeInteger(maxActive) || maxActive < 1 || !Number.isSafeInteger(maxQueued) || maxQueued < 0) throw new Error('invalid_read_budget');
  }

  get status() { return { active: this.active, queued: this.admitted - this.active, capacity: this.maxActive + this.maxQueued }; }

  reserve(): ReadReservation {
    if (this.admitted >= this.maxActive + this.maxQueued) throw new ReadCapacityError();
    this.admitted++;
    let used = false, released = false, cancelWaiting: (() => void) | undefined;
    const release = () => { if (!released) { released = true; this.admitted--; } };
    return {
      cancel: () => { if (!used) { used = true; release(); } else cancelWaiting?.(); },
      run: async <T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> => {
        if (used) throw new Error('read_reservation_used');
        used = true;
        let acquired = false;
        try {
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              const index = this.queue.indexOf(start);
              if (index >= 0) this.queue.splice(index, 1);
              signal.removeEventListener('abort', abort);
              cancelWaiting = undefined;
              reject(Object.assign(new Error('read_cancelled'), { code: 'read_cancelled' }));
            };
            const start = () => {
              signal.removeEventListener('abort', abort);
              cancelWaiting = undefined;
              if (signal.aborted) { abort(); return; }
              acquired = true; this.active++; resolve();
            };
            cancelWaiting = abort;
            if (signal.aborted) { abort(); return; }
            signal.addEventListener('abort', abort, { once: true });
            if (this.active < this.maxActive) start(); else this.queue.push(start);
          });
          if (signal.aborted) throw Object.assign(new Error('read_cancelled'), { code: 'read_cancelled' });
          return await operation();
        } finally {
          cancelWaiting = undefined;
          if (acquired) this.active--;
          release();
          while (this.active < this.maxActive && this.queue.length) this.queue.shift()!();
        }
      },
    };
  }
}

const schedulers = new WeakMap<object, ReadScheduler>();
/** Both full-history and context services pass the same Database object. */
export function historyReadScheduler(database: object): ReadScheduler {
  let scheduler = schedulers.get(database);
  if (!scheduler) { scheduler = new ReadScheduler(); schedulers.set(database, scheduler); }
  return scheduler;
}
