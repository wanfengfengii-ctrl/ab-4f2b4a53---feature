import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRange, ifRangeMatches } from '../src/range.js';

test('闭区间 bytes=start-end', () => {
  assert.deepEqual(resolveRange('bytes=0-9', 100), { kind: 'range', start: 0, end: 9 });
  assert.deepEqual(resolveRange('bytes=10-200', 100), { kind: 'range', start: 10, end: 99 });
  assert.deepEqual(resolveRange(' bytes = 5-10 ', 100), { kind: 'range', start: 5, end: 10 });
});

test('开放尾端 bytes=start-', () => {
  assert.deepEqual(resolveRange('bytes=90-', 100), { kind: 'range', start: 90, end: 99 });
  assert.deepEqual(resolveRange('bytes=0-', 100), { kind: 'range', start: 0, end: 99 });
  assert.equal(resolveRange('bytes=100-', 100).kind, 'unsatisfiable');
  assert.equal(resolveRange('bytes=500-', 100).kind, 'unsatisfiable');
});

test('后缀 bytes=-suffix', () => {
  assert.deepEqual(resolveRange('bytes=-20', 100), { kind: 'range', start: 80, end: 99 });
  // 后缀大于总长度：返回整个表示
  assert.deepEqual(resolveRange('bytes=-200', 100), { kind: 'range', start: 0, end: 99 });
  assert.equal(resolveRange('bytes=-0', 100).kind, 'unsatisfiable');
  assert.equal(resolveRange('bytes=-10', 0).kind, 'unsatisfiable');
});

test('无 Range 头', () => {
  assert.deepEqual(resolveRange(undefined, 100), { kind: 'none' });
  assert.equal(resolveRange('', 100).kind, 'ignore');
});

test('无法理解的 Range 被忽略（回退 200）', () => {
  assert.equal(resolveRange('items=0-9', 100).kind, 'ignore');
  assert.equal(resolveRange('bytes', 100).kind, 'ignore');
  assert.equal(resolveRange('bytes=', 100).kind, 'ignore');
  assert.equal(resolveRange('bytes=abc', 100).kind, 'ignore');
  assert.equal(resolveRange('bytes=0-9,10-19', 100).kind, 'ignore'); // 多区间不支持
  assert.equal(resolveRange('bytes=10-5', 100).kind, 'ignore');      // 倒挂：忽略
  assert.equal(resolveRange('bytes=-', 100).kind, 'ignore');
});

test('If-Range ETag 强比较', () => {
  const etag = '"abc123"';
  assert.equal(ifRangeMatches('"abc123"', etag, new Date()), true);
  assert.equal(ifRangeMatches('"other"', etag, new Date()), false);
  assert.equal(ifRangeMatches('W/"abc123"', etag, new Date()), false);
});

test('If-Range 日期比较', () => {
  const lm = new Date('2026-10-05T12:00:00Z');
  assert.equal(ifRangeMatches('Mon, 05 Oct 2026 12:00:00 GMT', '"x"', lm), true);
  assert.equal(ifRangeMatches('Mon, 05 Oct 2026 11:00:00 GMT', '"x"', lm), false);
  assert.equal(ifRangeMatches('not-a-date', '"x"', lm), false);
});
