/**
 * End to end over real stdio: a fake host (this test) ↔ signal-mcpl ↔ a fake
 * signal-cli (fixtures/fake-signal-cli.mjs) speaking signal-cli's JSON-RPC.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McplConnection } from '@animalabs/mcpl-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const ALL_CAPS = [
  'tools', 'pushEvents', 'channels.register', 'channels.lifecycle', 'channels.publish',
  'channels.incoming', 'channels.acknowledge', 'channels.typing',
];

const env = (source: string, ts: number, body: Record<string, unknown>) => ({
  source: U1, sourceUuid: source, sourceName: source === U1 ? 'Haipeng Lin' : 'Stranger', sourceDevice: 1, timestamp: ts, ...body,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

test('signal-mcpl relays DMs to the host and replies back', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-mcpl-'));
  const inbox = join(dir, 'inbox.json');
  const cliLog = join(dir, 'cli.jsonl');
  writeFileSync(inbox, JSON.stringify([
    env(U1, 1000, { dataMessage: { timestamp: 1000, message: 'hi **there**' } }),
    env(U2, 1001, { dataMessage: { timestamp: 1001, message: 'spam' } }),
    env(U1, 1002, { dataMessage: { timestamp: 1002, message: 'group hi', groupInfo: { groupId: 'g==', type: 'DELIVER' } } }),
    env(U1, 1003, { editMessage: { targetSentTimestamp: 1000, dataMessage: { timestamp: 1003, message: 'hi there' } } }),
    env(U1, 1004, { dataMessage: { timestamp: 1004, message: 'look', attachments: [{ id: 'att1', contentType: 'image/png', filename: 'cat.png', size: 14 }] } }),
    env(U1, 1005, { typingMessage: { action: 'STARTED', timestamp: 1005 } }),
    env(U1, 1006, { dataMessage: { timestamp: 1006, reaction: { emoji: '👍', targetAuthorUuid: U1, targetSentTimestamp: 1004, isRemove: false } } }),
  ]));

  const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'src/index.ts'), '--stdio'], {
    cwd: root,
    env: {
      ...process.env,
      SIGNAL_ACCOUNT: '+15550000000',
      SIGNAL_ALLOWED_SENDERS: U1,
      SIGNAL_CONTACT_NAMES: `${U1}=Haipeng`,
      SIGNAL_CLI_BIN: join(here, 'fixtures/fake-signal-cli.mjs'),
      SIGNAL_STATE_DIR: join(dir, 'state'),
      AGENT_TIMEZONE: 'UTC',
      FAKE_SIGNAL_INBOX: inbox,
      FAKE_SIGNAL_LOG: cliLog,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  t.after(() => { child.kill(); });

  const host = McplConnection.fromStreams(child.stdout, child.stdin);
  const pushes: Array<Record<string, any>> = [];
  const notifications: Array<{ method: string; params: any }> = [];
  const registers: any[] = [];
  void (async () => {
    try {
      for (;;) {
        const msg = await host.nextMessage();
        if (msg.type === 'request') {
          const { id, method, params } = msg.request as { id: string | number; method: string; params: any };
          if (method === 'push/event') { pushes.push(params); host.sendResponse(id, { accepted: true }); }
          else if (method === 'channels/register') { registers.push(params); host.sendResponse(id, {}); }
          else host.sendResponse(id, {});
        } else {
          notifications.push(msg.notification as { method: string; params: any });
        }
      }
    } catch { /* closed */ }
  })();
  const cliCalls = () => existsSync(cliLog)
    ? readFileSync(cliLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { method: string; params: any })
    : [];
  const call = (name: string, args: Record<string, unknown> = {}) =>
    host.sendRequest('tools/call', { name, arguments: args }) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

  try {
    const init = await host.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { experimental: { mcpl: { version: '0.5' } } },
      clientInfo: { name: 'test-host', version: '0' },
    }) as any;
    assert.equal(init.capabilities.experimental.mcpl.channels.publish, true);
    host.sendNotification('notifications/initialized', {});

    // No policy yet ⇒ not subscribed, nothing delivered.
    await sleep(400);
    assert.equal(cliCalls().some((c) => c.method === 'subscribeReceive'), false, 'subscribed before policy');
    assert.equal(pushes.length, 0);

    const receipt = await host.sendRequest('featureSets/update', { effectiveCapabilities: ALL_CAPS, enabled: ['signal.*'] }) as any;
    assert.equal(receipt.mode, 'full');

    await until(() => pushes.length >= 4 || undefined, '4 push events');
    await sleep(200);
    assert.equal(pushes.length, 4, 'stranger, group, and typing must not be delivered');
    const [first, edit, image, reactionEv] = pushes;
    assert.equal(first.payload.content[0].text, '[Signal DM] Haipeng: hi **there**');
    assert.equal(first.origin.mcplChannelId, `signal:dm:${U1}`);
    assert.equal(first.origin.isDM, true);
    assert.ok(first.tags.includes('chat:addressed'));
    assert.match(edit.payload.content[0].text, /Haipeng edited a message \(was: "hi \*\*there\*\*"\)\] Haipeng: hi there/);
    // Non-message events must not carry chat:dm — the host expands it to
    // chat:addressed (MCPL §16.3), which would wake the agent.
    for (const ev of [edit, reactionEv]) {
      assert.ok(!ev.tags.includes('chat:dm') && !ev.tags.includes('chat:addressed'), `${ev.origin.kind} tagged addressed`);
    }
    assert.ok(edit.tags.includes('chat:edited'));
    assert.ok(reactionEv.tags.includes('chat:reaction'));
    assert.match(reactionEv.payload.content[0].text, /Haipeng reacted 👍 to their message: "look"/);
    assert.ok(first.tags.includes('chat:dm'));
    assert.equal(image.payload.content[1].type, 'image');
    assert.equal(Buffer.from(image.payload.content[1].data, 'base64').toString(), 'fake-png-bytes');
    assert.ok(notifications.some((n) => n.method === 'channels/changed' && n.params.added[0].id === `signal:dm:${U1}`));
    assert.ok(!stderr.includes('spam'), 'non-allowlisted content must never be logged');

    // Agent prose → Signal, with markdown converted to styles.
    host.sendNotification('channels/typing', { channelId: `signal:dm:${U1}`, op: 'start' });
    const pub = await host.sendRequest('channels/publish', {
      conversationId: 'c1', channelId: `signal:dm:${U1}`, content: [{ type: 'text', text: '**Hello** back' }],
    }) as any;
    assert.equal(pub.delivered, true);
    const send = cliCalls().find((c) => c.method === 'send')!;
    assert.deepEqual(send.params.recipient, [U1]);
    assert.equal(send.params.message, 'Hello back');
    assert.deepEqual(send.params.textStyle, ['0:5:BOLD']);
    assert.ok(cliCalls().some((c) => c.method === 'sendTyping'));
    const receipts = cliCalls().filter((c) => c.method === 'sendReceipt').map((c) => c.params.targetTimestamp).sort();
    assert.deepEqual(receipts, [1000, 1004], 'read receipts once the agent engages');

    // Tools.
    const react = await call('react', { emoji: '❤️' });
    assert.ok(!react.isError, react.content[0].text);
    const reaction = cliCalls().find((c) => c.method === 'sendReaction')!;
    assert.equal(reaction.params.targetTimestamp, 1004);
    assert.equal(reaction.params.targetAuthor, U1);

    const quote = await call('send_message', { text: 'about that', reply_to: '1000' });
    assert.ok(!quote.isError, quote.content[0].text);
    const quoteSend = cliCalls().filter((c) => c.method === 'send').at(-1)!;
    assert.equal(quoteSend.params.quoteTimestamp, 1000);
    assert.equal(quoteSend.params.quoteAuthor, U1);

    const history = await call('fetch_history');
    const h = history.content[0].text;
    assert.match(h, /\(id 1000\) Haipeng: hi there \(edited\)/);
    assert.match(h, /\(id 1004\) Haipeng: look \[attachments: cat\.png\] \{👍 Haipeng, ❤️ you\}/);
    assert.match(h, /you: \*\*Hello\*\* back/);
    assert.ok(!h.includes('spam'));

    const stranger = await call('send_message', { text: 'x', to: 'Bob' });
    assert.equal(stranger.isError, true);

    const own = await call('edit_message', { message_id: '1000', text: 'nope' });
    assert.equal(own.isError, true, 'cannot edit their message');

    await assert.rejects(
      host.sendRequest('channels/publish', { conversationId: 'c1', channelId: `signal:dm:${U1}`, content: [{ type: 'text', text: 'FAIL_IDENTITY' }] }),
      /safety number changed/,
    );
    await assert.rejects(
      host.sendRequest('channels/publish', { conversationId: 'c1', channelId: `signal:dm:${U2}`, content: [{ type: 'text', text: 'hi' }] }),
      /Unknown Signal channel/,
    );
  } catch (e) {
    console.error('--- signal-mcpl stderr ---\n' + stderr);
    throw e;
  } finally {
    host.close();
  }
});
