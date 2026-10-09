import dns from 'node:dns/promises';
import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { isIP, type LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Webhook } from 'standardwebhooks';

export class CallbackError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'CallbackError';
  }
}

export function validateSecret(secret: string): Buffer {
  if (typeof secret !== 'string' || !secret.startsWith('whsec_')) {
    throw new CallbackError('invalid_secret');
  }
  const encoded = secret.slice(6);
  if (encoded.length < 32 || encoded.length > 88 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new CallbackError('invalid_secret');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 24 || bytes.length > 64 || bytes.toString('base64') !== encoded) {
    throw new CallbackError('invalid_secret');
  }
  return bytes;
}

/** Conservative public-unicast allowlist, including special-use and cloud metadata exclusions. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 0 || address.includes('%')) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.range() !== 'unicast') return false;
  if (parsed.kind() === 'ipv4') return address !== '168.63.129.16'; // Azure platform/metadata endpoint.
  // Only current global-unicast space. Mapped, translated and tunnel ranges are not allowed.
  return parsed.match(ipaddr.parseCIDR('2000::/3')) &&
    !parsed.match(ipaddr.parseCIDR('3fff::/20')); // RFC 9637 documentation space.
}

export function callbackUrl(value: string): URL {
  let url: URL;
  try {
    if (typeof value !== 'string' || value.trim() !== value || value.includes('#')) throw new Error();
    url = new URL(value);
  } catch {
    throw new CallbackError('invalid_url');
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
      /^https:\/\/[^/?#]*@/i.test(value)) {
    throw new CallbackError('invalid_url');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname) && !isPublicAddress(hostname)) throw new CallbackError('blocked_address');
  return url;
}

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;

/** Fresh DNS validation and a fresh TLS connection for every attempt; no redirects or proxy configuration. */
export async function postSigned(
  urlValue: string, secret: string, subscriptionId: string, eventId: string,
  payload: unknown, previousSecret?: string,
): Promise<{ status: number; body: string }> {
  validateSecret(secret);
  if (previousSecret !== undefined) validateSecret(previousSecret);
  const url = callbackUrl(urlValue);
  if (![subscriptionId, eventId].every(id => typeof id === 'string' && /^[\x21-\x7e]{1,256}$/.test(id))) {
    throw new CallbackError('invalid_id');
  }
  let body: string;
  try {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) throw new Error();
    body = serialized;
  } catch {
    throw new CallbackError('invalid_payload');
  }
  const bytes = Buffer.byteLength(body);
  if (bytes > MAX_REQUEST_BYTES) throw new CallbackError('request_too_large');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  return new Promise((resolve, reject) => {
    let settled = false;
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error instanceof CallbackError ? error : new CallbackError('network_error'));
      response?.destroy();
      request?.destroy();
    };
    // An overall deadline covers DNS, handshake, upload and slow response streams.
    const timer = setTimeout(() => fail(new CallbackError('timeout')), TIMEOUT_MS);
    void (async () => {
      let addresses: { address: string; family: number }[];
      try {
        addresses = isIP(hostname)
          ? [{ address: hostname, family: isIP(hostname) }]
          : await dns.lookup(hostname, { all: true, verbatim: true });
      } catch {
        throw new CallbackError('dns_error');
      }
      if (settled) return;
      if (addresses.length === 0 || addresses.some(record =>
        !isPublicAddress(record.address) || record.family !== isIP(record.address))) {
        throw new CallbackError('blocked_address');
      }
      const address = addresses[0]!;
      // The actual socket lookup never consults DNS again, preventing rebinding after validation.
      const lookup: LookupFunction = (_host, options, callback) => {
        if (options.all) callback(null, [{ address: address.address, family: address.family }]);
        else callback(null, address.address, address.family);
      };
      const timestamp = new Date();
      const signatures = [new Webhook(secret).sign(eventId, timestamp, body)];
      if (previousSecret !== undefined) signatures.push(new Webhook(previousSecret).sign(eventId, timestamp, body));
      request = https.request({
        protocol: 'https:', hostname, port: url.port || 443,
        path: `${url.pathname}${url.search}`, method: 'POST',
        agent: false, lookup, family: address.family,
        servername: isIP(hostname) ? '' : hostname, rejectUnauthorized: true,
        headers: {
          'host': url.host,
          'content-type': 'application/json',
          'content-length': bytes,
          'webhook-id': eventId,
          'X-MCP-Subscription-Id': subscriptionId,
          'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
          'webhook-signature': signatures.join(' '),
        },
      }, incoming => {
        response = incoming;
        incoming.on('error', fail);
        const status = incoming.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          fail(new CallbackError('redirect'));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        incoming.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) fail(new CallbackError('response_too_large'));
          else chunks.push(chunk);
        });
        incoming.on('aborted', () => fail(new CallbackError('response_aborted')));
        incoming.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status, body: Buffer.concat(chunks).toString('utf8') });
        });
      });
      request.on('error', fail);
      request.end(body);
    })().catch(fail);
  });
}
