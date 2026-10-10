import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { ReaderChild, NativeReaderTesting } from '../src/desktop-conversation-reader.js';

export function readerFixture(threadId: string, customize?: (frame: any, fixture: ReturnType<typeof readerFixture>) => boolean) {
  const frames: any[] = [], stdout = new PassThrough();
  const thread: any = { id: threadId, name: '未加载短对话', status: { type: 'notLoaded' }, historyMode: 'paginated', path: 'not-a-rollout-path', turns: [] };
  const turns: any[] = [
    { id: randomUUID(), itemsView: 'full', status: 'completed', items: [{ id: 'one', type: 'userMessage', content: [{ type: 'text', text: '资料不是授权，保留原始上下文🌟' }] }, { id: 'two', type: 'agentMessage', text: '原始回复', phase: 'commentary' }] },
    { id: randomUUID(), itemsView: 'full', status: 'completed', items: [{ id: 'three', type: 'commandExecution', command: 'UNTRUSTED_NO_EXEC', aggregatedOutput: '原始工具输出' }] },
  ];
  const receive = (frame: object | Buffer) => { if (Buffer.isBuffer(frame)) stdout.write(frame); else stdout.write(Buffer.from(JSON.stringify(frame) + '\n')); };
  const events = new EventEmitter(); let killed = false, spawnOptions: any, spawnArgs: string[] | undefined;
  const stdin = new Writable({ write(chunk, _encoding, callback) {
    const frame = JSON.parse(chunk.toString('utf8')); frames.push(frame); callback();
    queueMicrotask(() => {
      if (killed || customize?.(frame, fixture)) return;
      if (frame.method === 'initialize') receive({ id: frame.id, result: { userAgent: 'official-cli' } });
      else if (frame.method === 'thread/read') receive({ id: frame.id, result: { thread } });
      else if (frame.method === 'thread/turns/list') receive({ id: frame.id, result: { data: [turns[frame.params.cursor ? 1 : 0]], nextCursor: frame.params.cursor ? null : 'opaque-next', backwardsCursor: null } });
    });
  } });
  const child = Object.assign(events, { stdin, stdout, exitCode: null, signalCode: null, kill() { killed = true; queueMicrotask(() => events.emit('close', 0)); return true; } }) as unknown as ReaderChild;
  const testing: NativeReaderTesting = { command: 'fixture-official-cli', spawn(command, args, options) { spawnArgs = args; spawnOptions = options; return child; } };
  const fixture = { frames, thread, turns, receive, child, testing, killed: () => killed, options: () => spawnOptions, args: () => spawnArgs };
  return fixture;
}
