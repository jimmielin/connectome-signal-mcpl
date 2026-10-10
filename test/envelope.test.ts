import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReceive } from '../src/envelope.js';

const U = '11111111-1111-4111-8111-111111111111';
const base = { source: '+15551234567', sourceNumber: '+15551234567', sourceUuid: U, sourceName: 'H', sourceDevice: 1, timestamp: 50 };

test('plain (non-subscription) receive shape', () => {
  const ev = parseReceive({ envelope: { ...base, dataMessage: { timestamp: 50, message: 'yo' } }, account: '+1' });
  assert.equal(ev.kind, 'message');
  if (ev.kind !== 'message') return;
  assert.equal(ev.text, 'yo');
  assert.deepEqual(ev.from, { uuid: U, number: '+15551234567', name: 'H' });
});

test('reaction', () => {
  const ev = parseReceive({ subscription: 0, result: { envelope: { ...base, dataMessage: { timestamp: 60, reaction: {
    emoji: '👍', targetAuthorUuid: 'bot', targetSentTimestamp: 40, isRemove: false } } } } });
  assert.deepEqual(ev.kind === 'reaction' && [ev.emoji, ev.targetTimestamp, ev.remove], ['👍', 40, false]);
});

test('remote delete', () => {
  const ev = parseReceive({ envelope: { ...base, dataMessage: { timestamp: 70, remoteDelete: { timestamp: 40 } } } });
  assert.deepEqual(ev.kind === 'delete' && ev.targetTimestamp, 40);
});

test('quote', () => {
  const ev = parseReceive({ envelope: { ...base, dataMessage: { timestamp: 80, message: 'yes', quote: { id: 40, authorNumber: '+1', text: 'q?' } } } });
  assert.deepEqual(ev.kind === 'message' && ev.quote, { timestamp: 40, authorUuid: undefined, authorNumber: '+1', text: 'q?' });
});

test('receipts, sync, and content-free data messages are not messages', () => {
  assert.equal(parseReceive({ envelope: { ...base, receiptMessage: { isRead: true, timestamps: [1, 2] } } }).kind, 'receipt');
  assert.equal(parseReceive({ envelope: { ...base, syncMessage: { sentMessage: {} } } }).kind, 'sync');
  assert.equal(parseReceive({ envelope: { ...base, dataMessage: { timestamp: 9, expiresInSeconds: 0 } } }).kind, 'other');
  assert.equal(parseReceive(null).kind, 'other');
  assert.equal(parseReceive({ nope: 1 }).kind, 'other');
});

test('hidden phone number: uuid only', () => {
  const ev = parseReceive({ envelope: { sourceUuid: U, sourceName: 'H', timestamp: 5, dataMessage: { timestamp: 5, message: 'x' } } });
  assert.deepEqual(ev.kind === 'message' && ev.from, { uuid: U, number: undefined, name: 'H' });
});
