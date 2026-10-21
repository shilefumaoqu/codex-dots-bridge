import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type net from 'node:net';
import { observeDesktopContextState } from '../src/desktop-echo-ipc.js';

const encode = (value: object) => {
  const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
  header.writeUInt32LE(body.length); return Buffer.concat([header, body]);
};
export class OwnerSocket extends EventEmitter {
  destroyed = false; closed = false; frames: any[] = [];
  constructor(private responder: (message: any, socket: OwnerSocket) => void, connected = true) {
    super(); if (connected) queueMicrotask(() => this.emit('connect'));
  }
  write(bytes: Buffer) {
    const message = JSON.parse(bytes.subarray(4).toString('utf8')); this.frames.push(message);
    queueMicrotask(() => { if (!this.destroyed) this.responder(message, this); }); return true;
  }
  receive(...messages: object[]) { this.emit('data', Buffer.concat(messages.map(encode))); }
  destroy() {
    if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => { this.closed = true; this.emit('close'); }); }
    return this;
  }
}
export const idleOwnerState = (id: string) => ({ id, resumeState: 'resumed', threadRuntimeStatus: { type: 'idle' }, turnHistory: { kind: 'legacy' }, turns: [] });
export function ownerFixture(options: {
  state?: (threadId: string) => any;
  stopAt?: 'connect' | 'initialize' | 'discovery' | 'snapshot';
  noOwner?: boolean; source?: string; updateAfterSnapshot?: boolean;
  discoveryError?: string; disconnectAtSnapshot?: boolean;
} = {}) {
  const threadId = randomUUID(), controller = new AbortController(); let connections = 0;
  const socket = new OwnerSocket((message, s) => {
    const reply = (result?: object) => s.receive({ type: 'response', requestId: message.requestId, resultType: 'success', handledByClientId: 'owner', result });
    if (message.method === 'initialize' && options.stopAt !== 'initialize') reply({ clientId: 'follower' });
    else if (message.method === 'thread-owner-discovery' && options.stopAt !== 'discovery') {
      if (options.noOwner || options.discoveryError) s.receive({ type: 'response', requestId: message.requestId, resultType: 'error', error: options.discoveryError ?? 'no-client-found' });
      else reply();
    } else if (message.method === 'thread-stream-following-changed' && message.params.following && options.stopAt !== 'snapshot') {
      if (options.disconnectAtSnapshot) { s.destroy(); return; }
      const event = { type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: options.source ?? 'owner', targetClientIds: ['follower'], params: { conversationId: threadId, hostId: 'local', change: { type: 'snapshot', conversationState: options.state?.(threadId) ?? idleOwnerState(threadId) } } };
      s.receive(event, ...(options.updateAfterSnapshot ? [{ ...event, params: { ...event.params, change: { type: 'update' } } }] : []));
    }
  }, options.stopAt !== 'connect');
  const testing = { connect: () => { connections++; return socket as unknown as net.Socket; } };
  const input = (deadlineMs = 1000) => ({ threadId, signal: controller.signal, deadline: Date.now() + deadlineMs });
  return { threadId, controller, socket, testing, input, connections: () => connections, run: (deadlineMs = 1000) => observeDesktopContextState(input(deadlineMs), testing) };
}
