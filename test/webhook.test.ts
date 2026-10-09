import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import dns from 'node:dns/promises';
import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { Webhook } from 'standardwebhooks';
import { CallbackError, callbackUrl, isPublicAddress, postSigned, validateSecret } from '../src/webhook.js';

const secret = `whsec_${Buffer.alloc(32, 17).toString('base64')}`;
const previousSecret = `whsec_${Buffer.alloc(32, 31).toString('base64')}`;
const target = 'https://callback.example:8443/events?source=mcp';
const reason = (expected: string) => (error: unknown) =>
  error instanceof CallbackError && error.reason === expected;

function publicDns(t: TestContext, records = [{ address: '8.8.8.8', family: 4 }]) {
  return t.mock.method(dns, 'lookup', async () => records);
}

function fakeHttps(t: TestContext, status = 200, responseChunks: Buffer[] = [Buffer.from('ok')], stall = false) {
  let captured: { options: https.RequestOptions; body: string } | undefined;
  let destroyed = false;
  const requestMock = t.mock.method(https, 'request',
    (options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
      const request = new EventEmitter() as ClientRequest;
      request.destroy = (() => { destroyed = true; return request; }) as ClientRequest['destroy'];
      request.end = ((body: string) => {
        captured = { options, body };
        if (!stall) queueMicrotask(() => {
          const incoming = Readable.from(responseChunks) as IncomingMessage;
          incoming.statusCode = status;
          callback(incoming);
        });
        return request;
      }) as ClientRequest['end'];
      return request;
    });
  return { requestMock, get captured() { return captured; }, get destroyed() { return destroyed; } };
}

test('accepts only canonical whsec_ base64 with 24 to 64 bytes', () => {
  for (const length of [24, 25, 32, 63, 64]) {
    const bytes = Buffer.alloc(length, 231);
    assert.deepEqual(validateSecret(`whsec_${bytes.toString('base64')}`), bytes);
  }
  const invalid = [
    '', secret.slice(6), `other_${secret.slice(6)}`, `${secret}\n`,
    `whsec_${Buffer.alloc(23).toString('base64')}`, `whsec_${Buffer.alloc(65).toString('base64')}`,
    secret.replace(/=$/, ''), 'whsec_' + '-'.repeat(44),
    // Non-zero padding bits decode to the same bytes but are not canonical base64.
    `whsec_${Buffer.alloc(25).toString('base64').slice(0, -3)}B==`,
  ];
  for (const value of invalid) assert.throws(() => validateSecret(value), reason('invalid_secret'));
});

test('requires HTTPS and excludes credentials and any fragment', () => {
  assert.equal(callbackUrl(target).href, target);
  for (const value of [
    'http://example.com', 'ftp://example.com', 'not a url',
    'https://user:pass@example.com', 'https://@example.com',
    'https://example.com/#secret', 'https://example.com/#', ' https://example.com',
  ]) assert.throws(() => callbackUrl(value), reason('invalid_url'));
  assert.equal(callbackUrl('https://example.com/%23encoded').pathname, '/%23encoded');
});

test('blocks private, reserved, metadata and nonpublic IPv4/IPv6, including mapped IPv4', () => {
  for (const address of [
    '0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '192.168.1.1', '100.100.100.200', '192.0.0.1', '192.0.2.1', '192.88.99.1',
    '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '168.63.129.16', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', 'fe80::1%eth0',
    '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1',
    '2001:db8::1', '3fff::1', '100::1', '2001::1', '2001:20::1', '4000::1',
  ]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicAddress(address), true, address);
  }
  for (const value of ['https://127.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://[::ffff:127.0.0.1]/']) {
    assert.throws(() => callbackUrl(value), reason('blocked_address'));
  }
});

test('signs exact JSON bytes with standard headers and both rotation secrets', async t => {
  const lookup = publicDns(t);
  const transport = fakeHttps(t, 202, [Buffer.from('accepted')]);
  const payload = { type: 'notifications/events', text: '中文', nested: { value: 7 } };
  assert.deepEqual(await postSigned(target, secret, 'sub-1', 'evt-1', payload, previousSecret),
    { status: 202, body: 'accepted' });
  const captured = transport.captured!;
  assert.equal(captured.body, JSON.stringify(payload));
  const headers = captured.options.headers as Record<string, string>;
  assert.equal(headers['webhook-id'], 'evt-1');
  assert.equal(headers['X-MCP-Subscription-Id'], 'sub-1');
  assert.equal(headers['content-length'], Buffer.byteLength(captured.body));
  assert.equal(headers['content-type'], 'application/json');
  assert.match(headers['webhook-timestamp']!, /^\d+$/);
  assert.equal(headers['webhook-signature']!.split(' ').length, 2);
  assert.deepEqual(new Webhook(secret).verify(captured.body, headers), payload);
  assert.deepEqual(new Webhook(previousSecret).verify(captured.body, headers), payload);
  assert.equal(lookup.mock.callCount(), 1);
});

test('pins validated address while keeping Host and SNI and disables connection reuse', async t => {
  const dnsMock = publicDns(t, [{ address: '2606:4700:4700::1111', family: 6 }]);
  const transport = fakeHttps(t);
  await postSigned(target, secret, 'sub-1', 'evt-1', {});
  const options = transport.captured!.options;
  assert.equal(options.hostname, 'callback.example');
  assert.equal(options.servername, 'callback.example');
  assert.equal((options.headers as Record<string, string>).host, 'callback.example:8443');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent, false);
  assert.equal(options.family, 6);
  assert.equal(options.path, '/events?source=mcp');
  // Simulate a changed DNS result after validation. Socket lookup must use the pinned public address.
  dnsMock.mock.mockImplementation(async () => [{ address: '127.0.0.1', family: 4 }]);
  await new Promise<void>((resolve, reject) => {
    options.lookup!('callback.example', {}, (error, address, family) => {
      if (error) return reject(error);
      assert.equal(address, '2606:4700:4700::1111');
      assert.equal(family, 6);
      resolve();
    });
  });
  assert.equal(dnsMock.mock.callCount(), 1);
});

test('re-resolves on every attempt and rejects any nonpublic answer in mixed DNS', async t => {
  const lookup = publicDns(t);
  const transport = fakeHttps(t);
  await postSigned(target, secret, 'sub-1', 'evt-1', {});
  lookup.mock.mockImplementation(async () => [
    { address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 },
  ]);
  await assert.rejects(postSigned(target, secret, 'sub-1', 'evt-1', {}), reason('blocked_address'));
  assert.equal(lookup.mock.callCount(), 2);
  assert.equal(transport.requestMock.mock.callCount(), 1);
});

test('rejects DNS IPv6 private answers, empty answers, mismatched family and resolver errors', async t => {
  const lookup = publicDns(t);
  const transport = fakeHttps(t);
  for (const records of [
    [{ address: 'fc00::1', family: 6 }], [{ address: '::ffff:10.0.0.1', family: 6 }],
    [], [{ address: '8.8.8.8', family: 6 }],
  ]) {
    lookup.mock.mockImplementation(async () => records);
    await assert.rejects(postSigned(target, secret, 'sub-1', 'evt-1', {}), reason('blocked_address'));
  }
  lookup.mock.mockImplementation(async () => { throw new Error('ENOTFOUND'); });
  await assert.rejects(postSigned(target, secret, 'sub-1', 'evt-1', {}), reason('dns_error'));
  assert.equal(transport.requestMock.mock.callCount(), 0);
});

test('does not follow a redirect', async t => {
  publicDns(t);
  const transport = fakeHttps(t, 302);
  await assert.rejects(postSigned(target, secret, 'sub-1', 'evt-1', {}), reason('redirect'));
  assert.equal(transport.requestMock.mock.callCount(), 1);
  assert.equal(transport.destroyed, true);
});

test('deadline stops a stalled response/connection after 10 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  publicDns(t);
  const transport = fakeHttps(t, 200, [], true);
  const pending = postSigned(target, secret, 'sub-1', 'evt-1', {});
  const rejected = assert.rejects(pending, reason('timeout'));
  await setImmediate();
  assert.equal(transport.requestMock.mock.callCount(), 1);
  t.mock.timers.tick(10_000);
  await rejected;
  assert.equal(transport.destroyed, true);
});

test('deadline also covers DNS and cannot send after a late DNS answer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveDns!: (records: { address: string; family: number }[]) => void;
  t.mock.method(dns, 'lookup', () => new Promise(resolve => { resolveDns = resolve; }));
  const transport = fakeHttps(t);
  const rejected = assert.rejects(postSigned(target, secret, 'sub-1', 'evt-1', {}), reason('timeout'));
  t.mock.timers.tick(10_000);
  await rejected;
  resolveDns([{ address: '8.8.8.8', family: 4 }]);
  await setImmediate();
  assert.equal(transport.requestMock.mock.callCount(), 0);
});

test('enforces request byte limit before DNS or transport, including UTF-8', async t => {
  const lookup = publicDns(t);
  const transport = fakeHttps(t);
  await assert.rejects(postSigned(target, secret, 'sub-1', 'evt-1', '中'.repeat(90_000)), reason('request_too_large'));
  await assert.rejects(postSigned(target, 'bad-secret', 'sub-1', 'evt-1', {}), reason('invalid_secret'));
  await assert.rejects(postSigned(target, secret, 'sub-1', 'evt-1', {}, ''), reason('invalid_secret'));
  await assert.rejects(postSigned(target, secret, 'sub-1', 'evt-1\r\nInjected: true', {}), reason('invalid_id'));
  await assert.rejects(postSigned(target, secret, 'sub-1', 'evt-1', undefined), reason('invalid_payload'));
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(transport.requestMock.mock.callCount(), 0);
});

test('permits an exact 64KiB response and rejects excess across chunks', async t => {
  publicDns(t);
  let transport = fakeHttps(t, 200, [Buffer.alloc(64 * 1024, 97)]);
  assert.equal((await postSigned(target, secret, 'sub-1', 'evt-1', {})).body.length, 64 * 1024);
  transport.requestMock.mock.restore();
  transport = fakeHttps(t, 200, [Buffer.alloc(64 * 1024), Buffer.alloc(1)]);
  await assert.rejects(postSigned(target, secret, 'sub-1', 'evt-1', {}), reason('response_too_large'));
  assert.equal(transport.destroyed, true);
});
