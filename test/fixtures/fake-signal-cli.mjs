#!/usr/bin/env node
// Minimal stand-in for `signal-cli -a ACCOUNT jsonRpc --receive-mode=manual`.
// Records every request to $FAKE_SIGNAL_LOG and, on subscribeReceive, emits
// the envelopes in $FAKE_SIGNAL_INBOX as subscription notifications.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const account = process.argv[process.argv.indexOf('-a') + 1];
let nextTs = 2_000_000;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  appendFileSync(process.env.FAKE_SIGNAL_LOG, JSON.stringify({ method: req.method, params: req.params ?? null }) + '\n');
  switch (req.method) {
    case 'subscribeReceive': {
      out({ jsonrpc: '2.0', id: req.id, result: 0 });
      const inbox = JSON.parse(readFileSync(process.env.FAKE_SIGNAL_INBOX, 'utf8'));
      for (const envelope of inbox) out({ jsonrpc: '2.0', method: 'receive', params: { subscription: 0, result: { envelope, account } } });
      return;
    }
    case 'send': {
      const fail = req.params.message === 'FAIL_IDENTITY';
      out({ jsonrpc: '2.0', id: req.id, result: { timestamp: nextTs++, results: [{ recipientAddress: { uuid: req.params.recipient[0] }, type: fail ? 'IDENTITY_FAILURE' : 'SUCCESS' }] } });
      return;
    }
    case 'getAttachment':
      out({ jsonrpc: '2.0', id: req.id, result: { data: Buffer.from('fake-png-bytes').toString('base64') } });
      return;
    default:
      out({ jsonrpc: '2.0', id: req.id, result: {} });
  }
});
