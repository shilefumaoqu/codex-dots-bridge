import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { xingduIcons } from '../src/xingdu-icons.js';

test('MCP icon decodes to the finalized PNG and declares its actual dimensions', () => {
  const [icon] = xingduIcons();
  assert.ok(icon);
  assert.equal(icon.mimeType, 'image/png');
  assert.ok(!('theme' in icon));
  const bytes = Buffer.from(icon.src.split(',')[1]!, 'base64');
  assert.deepEqual(bytes, readFileSync(new URL('../docs/素材/星渡/星渡-应用-128.png', import.meta.url)));
  assert.deepEqual([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  assert.equal(bytes.readUInt32BE(16), 128);
  assert.equal(bytes.readUInt32BE(20), 128);
  assert.deepEqual(icon.sizes, ['128x128']);
});

test('tool registrations receive separate icon metadata arrays', () => {
  const first = xingduIcons();
  first[0]!.sizes[0] = 'changed';
  first[0]!.src = 'changed';
  assert.deepEqual(xingduIcons()[0]!.sizes, ['128x128']);
  assert.ok(xingduIcons()[0]!.src.startsWith('data:image/png;base64,'));
});
