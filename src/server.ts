/**
 * Signal MCPL server.
 *
 * Inbound: signal-cli `receive` → allowlist → message log → host. A DM is
 * delivered as `push/event` carrying `origin.mcplChannelId`, the
 * surface-agnostic contract the Agent Framework uses to register the DM and
 * route the agent's prose reply back (framework.ts derivePushEventChannel).
 * If the host has opened the channel, messages go via `channels/incoming`
 * instead, as discord-mcpl does.
 *
 * Outbound: `channels/publish` (the agent's prose) and the tools in tools.ts
 * → signal-cli `send`, with markdown converted to Signal text styles.
 *
 * Policy follows MCPL 0.5 (§5.3, §5.4, §6.7) via the vendored mcpl05.ts:
 * nothing is delivered until the host's `featureSets/update` Request grants
 * it, and until then signal-cli is not even subscribed, so the Signal service
 * keeps holding messages rather than handing them to a server with nowhere to
 * put them.
 *
 * Scope (v0.1): 1:1 conversations only. Group traffic is ignored.
 */
import { McplConnection, method } from '@animalabs/mcpl-core';
import type {
  ChannelDescriptor, ChannelsOpenParams, ChannelsPublishParams, ContentBlock,
  IncomingChannelMessage, JsonRpcId, McplInitializeParams, PushEventParams,
} from '@animalabs/mcpl-core';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { SignalMcplConfig } from './config.js';
import { parseReceive, type InboundEvent, type SignalAttachmentInfo, type SignalPeer } from './envelope.js';
import { markdownToSignal, toTextStyleArgs } from './markdown.js';
import {
  EMPTY_GRANT, buildReceipt, capabilityGranted, deriveFeatureSetState, narrowGrant, parsePolicy,
} from './mcpl05.js';
import type {
  CapabilityPath, FeatureSetMap, FeatureSetWireEntry, Grant,
  McplInitializeResult05, McplServerCapabilities05,
} from './mcpl05.js';
import type { SignalRpc } from './signal-rpc.js';
import { Store, displayName, parseDmChannelId, type Contact } from './store.js';
import { formatAgentDateTime, resolveAgentTimeZone } from './timezone.js';
import { toolDefinitions } from './tools.js';

const VERSION = '0.1.0';
const FS_MESSAGING = 'signal.messaging';
const FS_CHANNELS = 'signal.channels';
const AGENT_TIME_ZONE = resolveAgentTimeZone();

const TYPING_REFRESH_MS = 10_000; // Signal shows an indicator for 15s
const TYPING_MAX_MS = 3 * 60_000;
const PENDING_CAP = 500;
const HISTORY_MAX = 200;
/** Image types the inference API accepts inline. */
const INLINE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|ya?ml|xml|html?|css|js|mjs|ts|py|rb|go|rs|java|c|h|cpp|sh|toml|ini|cfg|sql|diff|patch)$/i;

// Two feature sets so a host that withholds the optional channel lifecycle /
// presence capabilities degrades to "DMs in, replies out" instead of the
// whole surface failing closed (§6.4 derives availability from `uses`).
const featureSetDecls: FeatureSetMap = {
  [FS_MESSAGING]: {
    description: 'Relay 1:1 Signal messages to the agent and deliver its replies',
    uses: ['tools', 'pushEvents', 'channels.register', 'channels.publish'],
    rollback: false,
  },
  [FS_CHANNELS]: {
    description: 'Open-channel delivery, typing indicators, and acknowledgment reactions',
    uses: ['channels.lifecycle', 'channels.incoming', 'channels.acknowledge', 'channels.typing'],
    rollback: false,
  },
};
const featureSetsWire: FeatureSetWireEntry[] = Object.entries(featureSetDecls)
  .map(([name, decl]) => ({ name, ...decl }));

type ServerCaps = McplServerCapabilities05 & { channels: Record<string, boolean> };
interface ReqMsg { id: JsonRpcId; method: string; params?: unknown }
interface NotifMsg { method: string; params?: unknown }
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type RelayEvent = Extract<InboundEvent, { kind: 'message' | 'edit' | 'delete' | 'reaction' }>;

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const fmtBytes = (n?: number) =>
  n === undefined ? '?' : n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`;
const snippet = (s: string | undefined, max = 80) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

export class SignalMcplServer {
  private conn: McplConnection | null = null;
  private mcplEnabled = false;
  private grant: Grant = EMPTY_GRANT;
  private policyReady = false;

  private subscribed = false;
  private subscribing = false;
  private pending: Array<{ ev: RelayEvent; contact: Contact }> = [];
  private readonly openChannels = new Set<string>();
  private readonly announced = new Set<string>();
  /** Inbound message timestamps not yet read-receipted, per channel. */
  private readonly unread = new Map<string, number[]>();
  private readonly typing = new Map<string, { timer: ReturnType<typeof setInterval>; until: number }>();
  private lastForwardedChannel: string | null = null;
  private inboundChain: Promise<void> = Promise.resolve();
  private outboundChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cfg: SignalMcplConfig,
    private readonly rpc: SignalRpc,
    private readonly store: Store,
    private readonly log: (...a: unknown[]) => void,
  ) {
    rpc.on('up', () => { this.subscribed = false; this.ensureSubscribed(); });
    rpc.on('down', () => { this.subscribed = false; });
    rpc.on('receive', (params: unknown) => {
      this.inboundChain = this.inboundChain
        .then(() => this.handleReceive(params))
        .catch((e) => this.log('inbound handling failed:', (e as Error).stack ?? e));
    });
    if (cfg.allowedSenders.size === 0) {
      this.log('WARNING: SIGNAL_ALLOWED_SENDERS is empty — every inbound message will be dropped (fail-closed).');
    }
  }

  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;
    await this.handleInitialize();
    try {
      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        if (msg.type === 'request') void this.handleRequest(msg.request as ReqMsg);
        else this.handleNotification(msg.notification as NotifMsg);
      }
    } catch (e) {
      if ((e as Error).name !== 'ConnectionClosedError') this.log('connection error:', e);
    }
    for (const channelId of [...this.typing.keys()]) this.stopTyping(channelId, false);
    this.conn = null;
  }

  // ── Handshake & policy ────────────────────────────────────────────────

  private async handleInitialize(): Promise<void> {
    const conn = this.conn!;
    const msg = await conn.nextMessage();
    if (msg.type !== 'request' || msg.request.method !== 'initialize') {
      this.log('expected initialize');
      conn.close();
      return;
    }
    const params = msg.request.params as McplInitializeParams | undefined;
    this.mcplEnabled = params?.capabilities?.experimental?.mcpl !== undefined;
    const serverCaps: ServerCaps = {
      version: '0.5',
      pushEvents: true,
      channels: { register: true, lifecycle: true, publish: true, incoming: true, acknowledge: true, typing: true },
      featureSets: featureSetsWire,
    };
    const result: McplInitializeResult05 = {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, ...(this.mcplEnabled ? { experimental: { mcpl: serverCaps } } : {}) },
      serverInfo: { name: 'signal-mcpl', version: VERSION },
    };
    conn.sendResponse(msg.request.id, result);
    this.log('initialize answered' + (this.mcplEnabled ? ' (MCPL; awaiting featureSets/update)' : ' (plain MCP; no inbound delivery)'));
  }

  private active(fs: string): boolean {
    return this.mcplEnabled && this.policyReady && deriveFeatureSetState(fs, featureSetDecls[fs], this.grant).active;
  }

  private granted(path: CapabilityPath): boolean {
    return this.mcplEnabled && this.policyReady && capabilityGranted(this.grant, path);
  }

  private onPolicyChanged(): void {
    if (!this.active(FS_MESSAGING)) {
      this.log(`${FS_MESSAGING} inactive; inbound messages are logged and held`);
      return;
    }
    void this.registerKnownChannels();
    this.ensureSubscribed();
    this.flushPending();
  }

  private handleFeatureSetsUpdateRequest(req: ReqMsg): void {
    const parsed = parsePolicy(req.params);
    if (!parsed.ok) {
      this.grant = EMPTY_GRANT;
      this.policyReady = false;
      this.log(`featureSets/update rejected: ${parsed.error}; grant cleared`);
      this.conn!.sendError(req.id, -32602, `Invalid featureSets/update: ${parsed.error}`);
      return;
    }
    this.grant = parsed.grant;
    this.policyReady = true;
    const receipt = buildReceipt(featureSetDecls, this.grant);
    this.log(`featureSets/update applied: mode=${receipt.mode}` +
      (receipt.unavailableFeatures.length ? ` unavailable=[${receipt.unavailableFeatures.map((u) => `${u.featureSet}: ${u.missingCapabilities.join('+')}`).join('; ')}]` : ''));
    this.conn!.sendResponse(req.id, receipt);
    this.onPolicyChanged();
  }

  private handleFeatureSetsUpdateNotification(notif: NotifMsg): void {
    const parsed = parsePolicy(notif.params);
    if (!parsed.ok) { this.log(`featureSets/update (notification) malformed: ${parsed.error}; ignored`); return; }
    // §6.7: a Notification can only narrow, and cannot establish ready state.
    this.grant = narrowGrant(this.grant, parsed.grant, parsed.hadEffectiveCapabilities);
    if (!this.policyReady) {
      this.log('WARNING: policy arrived only as a Notification; per MCPL §5.3 nothing is delivered until the host sends featureSets/update as a Request.');
    }
  }

  // ── Dispatch ──────────────────────────────────────────────────────────

  private async handleRequest(req: ReqMsg): Promise<void> {
    const conn = this.conn!;
    const params = (req.params ?? {}) as Record<string, unknown>;
    try {
      switch (req.method) {
        case 'tools/list':
          conn.sendResponse(req.id, { tools: toolDefinitions({ sendFile: this.cfg.sendFileRoots.length > 0 }) });
          return;
        case 'tools/call':
          conn.sendResponse(req.id, await this.callTool(String(params.name), (params.arguments ?? {}) as Record<string, unknown>));
          return;
        case method.FEATURE_SETS_UPDATE:
          this.handleFeatureSetsUpdateRequest(req);
          return;
        case method.CHANNELS_LIST:
          conn.sendResponse(req.id, { channels: this.store.listContacts().filter((c) => this.isAllowedContact(c)).map((c) => this.descriptor(c)) });
          return;
        case method.CHANNELS_OPEN:
          conn.sendResponse(req.id, this.openChannel(params as unknown as ChannelsOpenParams));
          return;
        case method.CHANNELS_CLOSE: {
          const channelId = String(params.channelId ?? '');
          const was = this.openChannels.delete(channelId);
          conn.sendResponse(req.id, { closed: was || this.store.getContact(channelId) !== undefined });
          return;
        }
        case method.CHANNELS_PUBLISH:
          conn.sendResponse(req.id, await this.publish(params as unknown as ChannelsPublishParams));
          return;
        case method.CHANNELS_ACKNOWLEDGE:
          conn.sendResponse(req.id, await this.acknowledge(params));
          return;
        case method.STATE_ROLLBACK:
          conn.sendResponse(req.id, { checkpoint: params.checkpoint, success: false, reason: 'signal-mcpl does not support rollback' });
          return;
        default:
          conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (e) {
      this.log(`request ${req.method} failed:`, (e as Error).message);
      conn.sendError(req.id, -32603, (e as Error).message);
    }
  }

  private handleNotification(notif: NotifMsg): void {
    const params = (notif.params ?? {}) as Record<string, unknown>;
    switch (notif.method) {
      case 'notifications/initialized':
        break;
      case method.FEATURE_SETS_UPDATE:
        this.handleFeatureSetsUpdateNotification(notif);
        break;
      case method.CHANNELS_PUBLISH:
        this.publish(params as unknown as ChannelsPublishParams)
          .catch((e) => this.log('publish (notification) failed:', (e as Error).message));
        break;
      case 'channels/typing':
      case 'notifications/typing': {
        const channelId = typeof params.channelId === 'string' ? params.channelId : '';
        if (!channelId) break;
        if (params.op === 'stop') this.stopTyping(channelId, true);
        else this.startTyping(channelId);
        break;
      }
      default:
        break; // channels/outgoing/* etc.: nothing to do for a non-streaming surface
    }
  }

  // ── Inbound ───────────────────────────────────────────────────────────

  private ensureSubscribed(): void {
    if (this.subscribed || this.subscribing || !this.rpc.isUp || !this.active(FS_MESSAGING)) return;
    this.subscribing = true;
    this.rpc.request('subscribeReceive')
      .then(() => {
        this.subscribed = true;
        this.rpc.markHealthy();
        this.log('subscribed to incoming Signal messages');
      })
      .catch((e) => this.log(`subscribeReceive failed: ${(e as Error).message}`))
      .finally(() => { this.subscribing = false; });
  }

  private isAllowed(peer: SignalPeer): boolean {
    return (!!peer.uuid && this.cfg.allowedSenders.has(peer.uuid)) ||
      (!!peer.number && this.cfg.allowedSenders.has(peer.number));
  }

  private isAllowedContact(c: Contact): boolean {
    return this.isAllowed({ uuid: c.uuid, number: c.number });
  }

  private aliasFor(peer: SignalPeer): string | undefined {
    return (peer.uuid && this.cfg.contactNames.get(peer.uuid)) ||
      (peer.number && this.cfg.contactNames.get(peer.number)) || undefined;
  }

  private async handleReceive(params: unknown): Promise<void> {
    const ev = parseReceive(params);
    if (ev.kind === 'typing' || ev.kind === 'receipt' || ev.kind === 'sync' || ev.kind === 'other') return;
    if (ev.groupId) {
      this.log(`ignoring group ${ev.kind} (groups are not supported yet)`);
      return;
    }
    if (!this.isAllowed(ev.from)) {
      // Ids only — never content from someone who isn't allowlisted.
      this.log(`dropped ${ev.kind} from non-allowlisted sender uuid=${ev.from.uuid ?? '-'} number=${ev.from.number ?? '-'}`);
      return;
    }
    const contact = this.store.upsertContact(ev.from, this.aliasFor(ev.from));
    if (!contact) return;
    const name = displayName(contact);
    const at = new Date().toISOString();
    const authorId = contact.uuid ?? contact.number ?? contact.channelId;

    switch (ev.kind) {
      case 'message':
        this.store.append({
          dir: 'in', kind: 'message', channelId: contact.channelId, ts: ev.timestamp, authorId, authorName: name,
          text: ev.text, at,
          ...(ev.quote ? { quoteTs: ev.quote.timestamp } : {}),
          ...(ev.attachments.length ? { attachments: ev.attachments.map(({ contentType, filename, size }) => ({ contentType, filename, size })) } : {}),
        });
        this.unread.set(contact.channelId, [...(this.unread.get(contact.channelId) ?? []), ev.timestamp]);
        break;
      case 'edit':
        this.store.append({ dir: 'in', kind: 'edit', channelId: contact.channelId, ts: ev.timestamp, targetTs: ev.targetTimestamp, authorId, authorName: name, text: ev.text, at });
        break;
      case 'delete':
        this.store.append({ dir: 'in', kind: 'delete', channelId: contact.channelId, ts: ev.timestamp, targetTs: ev.targetTimestamp, authorId, authorName: name, at });
        break;
      case 'reaction':
        this.store.append({ dir: 'in', kind: 'reaction', channelId: contact.channelId, ts: ev.timestamp, targetTs: ev.targetTimestamp, authorId, authorName: name, emoji: ev.emoji, remove: ev.remove, at });
        break;
    }

    if (!this.active(FS_MESSAGING) || !this.conn) {
      this.pending.push({ ev, contact });
      if (this.pending.length > PENDING_CAP) this.pending.splice(0, this.pending.length - PENDING_CAP);
      this.log(`held ${ev.kind} from ${name} until the host grants delivery (${this.pending.length} held)`);
      return;
    }
    await this.forward(ev, contact);
  }

  private flushPending(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0);
    this.log(`delivering ${batch.length} held event(s)`);
    for (const { ev, contact } of batch) {
      this.inboundChain = this.inboundChain
        .then(() => this.forward(ev, contact))
        .catch((e) => this.log('held event delivery failed:', (e as Error).message));
    }
  }

  private async forward(ev: RelayEvent, contact: Contact): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    const channelId = contact.channelId;
    const name = displayName(contact);
    this.announce(contact);

    const header = this.lastForwardedChannel !== channelId ? '[Signal DM] ' : '';
    this.lastForwardedChannel = channelId;
    // Only a real message carries `chat:dm`: SPEC §16.3 makes `chat:dm` imply
    // `chat:addressed`, so tagging reactions/edits/deletes with it would wake
    // the agent through any "addressed" policy. Those carry only their own
    // §16.2 tag (as discord-mcpl does) and stay ambient.
    const tags = ['chat:private', 'chat:from-human'];
    let content: ContentBlock[];

    switch (ev.kind) {
      case 'message': {
        let replyMarker = '';
        if (ev.quote) {
          const quoted = this.store.findMessage(channelId, ev.quote.timestamp);
          const mine = quoted?.dir === 'out' || ev.quote.authorNumber === this.cfg.account;
          if (mine) tags.push('chat:reply');
          replyMarker = `[replying to ${mine ? 'your message' : name}: "${snippet(ev.quote.text ?? quoted?.text)}"]\n`;
        }
        const extras: string[] = [];
        if (ev.sticker) extras.push('[sticker]');
        if (ev.viewOnce) extras.push('[view-once media]');
        const body = [ev.text, ...extras].filter(Boolean).join(' ');
        content = [text(`${header}${replyMarker}${name}: ${body}`), ...(await this.attachmentBlocks(ev.attachments, contact))];
        tags.push('chat:dm', 'chat:addressed');
        for (const a of ev.attachments) {
          const ct = (a.contentType ?? '').toLowerCase();
          tags.push(ct.startsWith('image/') ? 'chat:has-image' : ct.startsWith('audio/') ? 'chat:has-audio' : 'chat:has-file');
        }
        break;
      }
      case 'edit': {
        const prev = this.store.findMessage(channelId, ev.targetTimestamp);
        content = [text(`${header}[${name} edited a message${prev?.text ? ` (was: "${snippet(prev.text)}")` : ''}] ${name}: ${ev.text}`)];
        tags.push('chat:edited');
        break;
      }
      case 'delete': {
        const prev = this.store.findMessage(channelId, ev.targetTimestamp);
        content = [text(`${header}[${name} deleted a message${prev?.text ? `: "${snippet(prev.text)}"` : ''}]`)];
        tags.push('chat:deleted');
        break;
      }
      case 'reaction': {
        const target = this.store.findMessage(channelId, ev.targetTimestamp);
        const whose = target ? (target.dir === 'out' ? 'your message' : 'their message') : 'a message';
        const verb = ev.remove ? `removed their ${ev.emoji} reaction from` : `reacted ${ev.emoji} to`;
        content = [text(`${header}[${name} ${verb} ${whose}${target?.text ? `: "${snippet(target.text)}"` : ''}]`)];
        tags.push(ev.remove ? 'chat:reaction-remove' : 'chat:reaction');
        break;
      }
    }

    const messageId = String(ev.timestamp);
    const timestamp = new Date(ev.timestamp).toISOString();
    try {
      if (ev.kind === 'message' && this.openChannels.has(channelId) && this.granted('channels.incoming')) {
        const message: IncomingChannelMessage = {
          channelId, messageId, timestamp, content, tags,
          author: { id: contact.uuid ?? contact.number ?? channelId, name },
          metadata: { isDM: true, ...(ev.quote ? { replyTo: String(ev.quote.timestamp) } : {}) },
        };
        await conn.sendRequest(method.CHANNELS_INCOMING, { messages: [message] });
      } else {
        const push: PushEventParams = {
          featureSet: FS_MESSAGING,
          eventId: `signal_${ev.kind}_${ev.timestamp}_${Math.random().toString(36).slice(2, 8)}`,
          timestamp,
          origin: {
            source: 'signal',
            kind: ev.kind,
            mcplChannelId: channelId,
            isDM: true,
            authorId: contact.uuid ?? contact.number,
            authorName: name,
            messageId,
            ...(ev.kind !== 'message' ? { targetMessageId: String(ev.targetTimestamp) } : {}),
          },
          tags,
          payload: { content },
        };
        const r = await conn.sendRequest(method.PUSH_EVENT, push) as { accepted?: boolean; reason?: string } | null;
        if (r && r.accepted === false) this.log(`host did not accept ${ev.kind} ${messageId}: ${r.reason ?? 'no reason'}`);
      }
    } catch (e) {
      this.log(`delivering ${ev.kind} ${messageId} failed (kept in log): ${(e as Error).message}`);
    }
  }

  private async attachmentBlocks(atts: SignalAttachmentInfo[], contact: Contact): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = [];
    for (const a of atts) {
      const ct = (a.contentType ?? '').toLowerCase();
      const label = a.filename ?? ct ?? 'attachment';
      const caption = a.caption ? ` — "${a.caption}"` : '';
      const isText = ct.startsWith('text/') || (a.filename !== undefined && TEXT_EXT.test(a.filename));
      try {
        if (a.isVoiceNote || ct.startsWith('audio/')) {
          blocks.push(text(`[voice note / audio (${ct || 'audio'}, ${fmtBytes(a.size)}) — not transcribed]`));
        } else if (INLINE_IMAGE_TYPES.has(ct) && a.id && (a.size ?? 0) <= this.cfg.imageInlineMaxBytes) {
          const data = await this.fetchAttachment(a.id, contact);
          // The declared size is advisory (and sometimes absent); enforce the cap on what arrived.
          const actual = Math.floor((data.length * 3) / 4);
          if (actual > this.cfg.imageInlineMaxBytes) {
            blocks.push(text(`[image: ${label} (${fmtBytes(actual)})${caption} — too large to inline]`));
          } else {
            blocks.push({ type: 'image', data, mimeType: ct } as ContentBlock);
            blocks.push(text(`[image: ${label}${caption}]`));
          }
        } else if (isText && a.id && (a.size ?? 0) <= this.cfg.textInlineMaxBytes) {
          const body = Buffer.from(await this.fetchAttachment(a.id, contact), 'base64').toString('utf8');
          blocks.push(text(`[attachment: ${label} (${fmtBytes(a.size)})${caption}]\n${body}`));
        } else {
          blocks.push(text(`[attachment: ${label} (${ct || 'unknown type'}, ${fmtBytes(a.size)})${caption} — not inlined]`));
        }
      } catch (e) {
        blocks.push(text(`[attachment: ${label} (${fmtBytes(a.size)}) could not be fetched: ${(e as Error).message}]`));
      }
    }
    return blocks;
  }

  private async fetchAttachment(id: string, contact: Contact): Promise<string> {
    const r = await this.rpc.request<unknown>('getAttachment', { id, recipient: this.recipient(contact) });
    const data = typeof r === 'string' ? r : (r as { data?: unknown } | null)?.data;
    if (typeof data !== 'string') throw new Error('unexpected getAttachment result');
    return data;
  }

  // ── Channels ──────────────────────────────────────────────────────────

  private descriptor(c: Contact): ChannelDescriptor {
    const name = displayName(c);
    return {
      id: c.channelId,
      type: 'signal',
      label: `DM: ${name}`,
      direction: 'bidirectional',
      address: { peer: c.uuid ?? c.number },
      metadata: { channelType: 'dm', recipientName: name, recipientId: c.uuid ?? c.number },
      capabilities: {
        history: { maxMessages: HISTORY_MAX, supportsBeforeMessage: true },
        acknowledgment: { kind: 'reaction', supportsValue: true },
      },
    };
  }

  /** Tell the host about a DM the first time we relay from it this session. */
  private announce(c: Contact): void {
    if (this.announced.has(c.channelId) || !this.conn || !this.granted('channels.register')) return;
    this.announced.add(c.channelId);
    this.conn.sendNotification(method.CHANNELS_CHANGED, { added: [this.descriptor(c)] });
  }

  private async registerKnownChannels(): Promise<void> {
    const contacts = this.store.listContacts().filter((c) => this.isAllowedContact(c) && !this.announced.has(c.channelId));
    if (contacts.length === 0 || !this.conn || !this.granted('channels.register')) return;
    for (const c of contacts) this.announced.add(c.channelId);
    try {
      await this.conn.sendRequest(method.CHANNELS_REGISTER, { channels: contacts.map((c) => this.descriptor(c)) });
    } catch (e) {
      this.log(`channels/register failed: ${(e as Error).message}`);
    }
  }

  private openChannel(p: ChannelsOpenParams) {
    const contact = p.channelId ? this.store.getContact(p.channelId) : undefined;
    if (!contact || !this.isAllowedContact(contact)) throw new Error(`Unknown Signal channel: ${p.channelId ?? '(none)'}`);
    const result: { channel: ChannelDescriptor; history?: IncomingChannelMessage[]; historyTruncated?: boolean } = {
      channel: this.descriptor(contact),
    };
    const limit = Math.max(0, Math.floor(p.history?.limit ?? 0));
    if (limit > 0) {
      const before = p.history?.beforeMessageId ? Number(p.history.beforeMessageId) : undefined;
      const capped = Math.min(limit, HISTORY_MAX);
      result.history = this.store.history(contact.channelId, { limit: capped, beforeTs: Number.isFinite(before) ? before : undefined })
        .filter((m) => !m.deleted)
        .map((m) => ({
          channelId: contact.channelId,
          messageId: String(m.ts),
          author: { id: m.authorId, name: m.dir === 'out' ? 'you' : m.authorName },
          timestamp: new Date(m.ts).toISOString(),
          content: [text(`${m.dir === 'out' ? 'you' : m.authorName}: ${m.text}`)],
          metadata: { backscroll: true },
        }));
      result.historyTruncated = limit > capped;
    }
    this.openChannels.add(contact.channelId);
    return result;
  }

  private contactForChannel(channelId: string): Contact {
    const contact = this.store.getContact(channelId);
    if (!contact || !parseDmChannelId(channelId)) throw new Error(`Unknown Signal channel: ${channelId}`);
    if (!this.isAllowedContact(contact)) throw new Error(`Signal channel ${channelId} is not allowlisted`);
    return contact;
  }

  private async publish(p: ChannelsPublishParams): Promise<{ delivered: boolean; messageId?: string }> {
    const contact = this.contactForChannel(p.channelId);
    const body = (p.content ?? [])
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (!body) return { delivered: false };
    const ts = await this.send(contact, body);
    return { delivered: true, messageId: String(ts) };
  }

  private async acknowledge(p: Record<string, unknown>): Promise<{ acknowledged: boolean; representation?: string; reason?: string }> {
    try {
      const contact = this.contactForChannel(String(p.channelId ?? ''));
      const ts = Number(p.messageId);
      if (!Number.isFinite(ts)) return { acknowledged: false, reason: 'messageId is not a Signal timestamp' };
      const emoji = typeof p.value === 'string' && p.value.trim() ? p.value.trim() : '👀';
      await this.react(contact, ts, emoji, false);
      return { acknowledged: true, representation: emoji };
    } catch (e) {
      return { acknowledged: false, reason: (e as Error).message };
    }
  }

  // ── Outbound primitives ───────────────────────────────────────────────

  private recipient(c: Contact): string {
    return (c.uuid ?? c.number)!;
  }

  /** Serialize sends so prose segments arrive in order. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.outboundChain.then(fn, fn);
    this.outboundChain = next.catch(() => undefined);
    return next;
  }

  private send(contact: Contact, body: string, opts: { quoteTs?: number; editTs?: number; attachments?: string[] } = {}): Promise<number> {
    return this.serial(async () => {
      const styled = this.cfg.markdown ? markdownToSignal(body) : { text: body, styles: [] };
      const params: Record<string, unknown> = { recipient: [this.recipient(contact)], message: styled.text };
      if (styled.styles.length) params.textStyle = toTextStyleArgs(styled.styles);
      if (opts.attachments?.length) params.attachments = opts.attachments;
      if (opts.editTs !== undefined) params.editTimestamp = opts.editTs;
      if (opts.quoteTs !== undefined) {
        const quoted = this.store.findMessage(contact.channelId, opts.quoteTs);
        params.quoteTimestamp = opts.quoteTs;
        params.quoteAuthor = quoted?.dir === 'out' ? this.cfg.account : this.recipient(contact);
        if (quoted?.text) params.quoteMessage = quoted.text;
      }
      const r = await this.rpc.request<{ timestamp?: number; results?: Array<Record<string, unknown>> }>('send', params);
      this.checkSendResults(r?.results);
      this.rpc.markHealthy();
      const ts = typeof r?.timestamp === 'number' ? r.timestamp : Date.now();
      this.store.append({
        dir: 'out', kind: opts.editTs !== undefined ? 'edit' : 'message', channelId: contact.channelId, ts,
        ...(opts.editTs !== undefined ? { targetTs: opts.editTs } : {}),
        authorId: 'self', authorName: 'you', text: body, at: new Date().toISOString(),
        ...(opts.quoteTs !== undefined ? { quoteTs: opts.quoteTs } : {}),
        ...(opts.attachments?.length ? { attachments: opts.attachments.map((f) => ({ filename: f.split(sep).pop() })) } : {}),
      });
      this.lastForwardedChannel = contact.channelId;
      this.markRead(contact);
      this.stopTyping(contact.channelId, false);
      return ts;
    });
  }

  /** signal-cli reports per-recipient outcomes; a 1:1 send fails if its only result isn't SUCCESS. */
  private checkSendResults(results: Array<Record<string, unknown>> | undefined): void {
    if (!results?.length) return;
    const failed = results.filter((r) => typeof r.type === 'string' && r.type !== 'SUCCESS');
    if (failed.length < results.length) return;
    const types = [...new Set(failed.map((r) => String(r.type)))];
    const hint = types.includes('IDENTITY_FAILURE')
      ? ' — the recipient\'s safety number changed; verify it, then run `signal-cli -a <account> trust <recipient>` on the host'
      : types.includes('RATE_LIMIT_FAILURE') ? ' — rate limited by Signal; try again later' : '';
    throw new Error(`Signal send failed: ${types.join(', ')}${hint}`);
  }

  private async react(contact: Contact, ts: number, emoji: string, remove: boolean): Promise<void> {
    const target = this.store.findMessage(contact.channelId, ts);
    await this.serial(() => this.rpc.request('sendReaction', {
      recipient: [this.recipient(contact)],
      emoji,
      targetAuthor: target?.dir === 'out' ? this.cfg.account : this.recipient(contact),
      targetTimestamp: ts,
      ...(remove ? { remove: true } : {}),
    }));
    this.store.append({
      dir: 'out', kind: 'reaction', channelId: contact.channelId, ts: Date.now(), targetTs: ts,
      authorId: 'self', authorName: 'you', emoji, remove, at: new Date().toISOString(),
    });
    this.markRead(contact);
  }

  /** Read receipts go out when the agent engages (typing, reply, reaction) —
   *  "read" then means the agent actually took the conversation up, not
   *  merely that the host queued it. */
  private markRead(contact: Contact): void {
    const pendingTs = this.unread.get(contact.channelId);
    if (!pendingTs?.length) return;
    this.unread.delete(contact.channelId);
    if (!this.cfg.readReceipts) return;
    for (const ts of pendingTs) {
      this.rpc.request('sendReceipt', { recipient: this.recipient(contact), targetTimestamp: ts, type: 'read' })
        .catch((e) => this.log(`read receipt failed: ${(e as Error).message}`));
    }
  }

  private startTyping(channelId: string): void {
    if (!this.granted('channels.typing')) return;
    let contact: Contact;
    try { contact = this.contactForChannel(channelId); } catch { return; }
    this.markRead(contact);
    const until = Date.now() + TYPING_MAX_MS;
    const existing = this.typing.get(channelId);
    if (existing) { existing.until = until; return; }
    const ping = () => {
      const t = this.typing.get(channelId);
      if (t && Date.now() > t.until) { this.stopTyping(channelId, true); return; }
      this.rpc.request('sendTyping', { recipient: [this.recipient(contact)] }).catch(() => { /* cosmetic */ });
    };
    this.typing.set(channelId, { timer: setInterval(ping, TYPING_REFRESH_MS), until });
    ping();
  }

  private stopTyping(channelId: string, notify: boolean): void {
    const t = this.typing.get(channelId);
    if (!t) return;
    clearInterval(t.timer);
    this.typing.delete(channelId);
    if (!notify) return;
    const contact = this.store.getContact(channelId);
    if (contact) this.rpc.request('sendTyping', { recipient: [this.recipient(contact)], stop: true }).catch(() => { /* cosmetic */ });
  }

  // ── Tools ─────────────────────────────────────────────────────────────

  private result(t: string, isError = false): ToolResult {
    return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) };
  }

  private resolveTo(args: Record<string, unknown>): Contact {
    const ref = typeof args.to === 'string' ? args.to.trim() : '';
    const allowed = this.store.listContacts().filter((c) => this.isAllowedContact(c));
    if (!ref) {
      if (!allowed.length) throw new Error('No Signal conversations yet — one starts when an allowlisted contact messages the bot.');
      return allowed[0];
    }
    const c = this.store.resolveContact(ref);
    if (!c || !this.isAllowedContact(c)) {
      throw new Error(`No allowlisted Signal conversation matches "${ref}". Known: ${allowed.map(displayName).join(', ') || 'none'}`);
    }
    return c;
  }

  private messageTs(v: unknown, field: string): number {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${field} must be a message id from fetch_history`);
    return n;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (name) {
        case 'send_message': {
          const body = typeof args.text === 'string' ? args.text.trim() : '';
          if (!body) return this.result('send_message requires non-empty "text".', true);
          const c = this.resolveTo(args);
          const quoteTs = args.reply_to !== undefined && args.reply_to !== '' ? this.messageTs(args.reply_to, 'reply_to') : undefined;
          const ts = await this.send(c, body, { quoteTs });
          return this.result(`Sent to ${displayName(c)} (id ${ts}).`);
        }
        case 'react': {
          const emoji = typeof args.emoji === 'string' ? args.emoji.trim() : '';
          if (!emoji) return this.result('react requires an "emoji".', true);
          const c = this.resolveTo(args);
          const ts = args.message_id !== undefined && args.message_id !== ''
            ? this.messageTs(args.message_id, 'message_id')
            : this.store.lastMessage(c.channelId, 'in')?.ts;
          if (ts === undefined) return this.result(`No message from ${displayName(c)} to react to.`, true);
          await this.react(c, ts, emoji, args.remove === true);
          return this.result(`${args.remove === true ? 'Removed' : 'Reacted'} ${emoji} ${args.remove === true ? 'from' : 'to'} message ${ts}.`);
        }
        case 'edit_message': {
          const c = this.resolveTo(args);
          const ts = this.messageTs(args.message_id, 'message_id');
          const body = typeof args.text === 'string' ? args.text.trim() : '';
          if (!body) return this.result('edit_message requires non-empty "text".', true);
          const target = this.store.findMessage(c.channelId, ts);
          if (target && target.dir !== 'out') return this.result('You can only edit your own messages.', true);
          await this.send(c, body, { editTs: ts });
          return this.result(`Edited message ${ts}.`);
        }
        case 'delete_message': {
          const c = this.resolveTo(args);
          const ts = this.messageTs(args.message_id, 'message_id');
          const target = this.store.findMessage(c.channelId, ts);
          if (target && target.dir !== 'out') return this.result('You can only delete your own messages.', true);
          await this.serial(() => this.rpc.request('remoteDelete', { recipient: [this.recipient(c)], targetTimestamp: ts }));
          this.store.append({ dir: 'out', kind: 'delete', channelId: c.channelId, ts: Date.now(), targetTs: ts, authorId: 'self', authorName: 'you', at: new Date().toISOString() });
          return this.result(`Deleted message ${ts} for everyone.`);
        }
        case 'fetch_history': {
          const c = this.resolveTo(args);
          const limit = Math.min(HISTORY_MAX, Math.max(1, Math.floor(typeof args.limit === 'number' ? args.limit : 30)));
          const before = args.before !== undefined && args.before !== '' ? this.messageTs(args.before, 'before') : undefined;
          const msgs = this.store.history(c.channelId, { limit, beforeTs: before });
          if (!msgs.length) return this.result(`No logged messages with ${displayName(c)}${before ? ` before ${before}` : ''}.`);
          const lines = msgs.map((m) => {
            const who = m.dir === 'out' ? 'you' : m.authorName;
            const body = m.deleted ? '[deleted]' : m.text;
            const atts = m.attachments?.length ? ` [attachments: ${m.attachments.map((a) => a.filename ?? a.contentType ?? 'file').join(', ')}]` : '';
            const flags = `${m.edited ? ' (edited)' : ''}${m.quoteTs ? ` (replying to ${m.quoteTs})` : ''}`;
            const reacts = m.reactions.length ? ` {${m.reactions.map((r) => `${r.emoji} ${r.by}`).join(', ')}}` : '';
            return `[${formatAgentDateTime(m.ts, AGENT_TIME_ZONE)}] (id ${m.ts}) ${who}: ${body}${atts}${flags}${reacts}`;
          });
          return this.result(`Signal — ${displayName(c)} (${lines.length} message${lines.length === 1 ? '' : 's'}):\n${lines.join('\n')}`);
        }
        case 'list_conversations': {
          const list = this.store.listContacts().filter((c) => this.isAllowedContact(c));
          if (!list.length) return this.result('No Signal conversations yet.');
          return this.result(list.map((c) =>
            `${displayName(c)} — ${c.channelId} (last active ${formatAgentDateTime(Date.parse(c.lastSeen), AGENT_TIME_ZONE)})`).join('\n'));
        }
        case 'send_file': {
          if (!this.cfg.sendFileRoots.length) return this.result('send_file is not enabled on this host.', true);
          const path = this.resolveSendablePath(String(args.path ?? ''));
          const c = this.resolveTo(args);
          const caption = typeof args.caption === 'string' ? args.caption : '';
          const ts = await this.send(c, caption, { attachments: [path] });
          return this.result(`Sent ${path.split(sep).pop()} to ${displayName(c)} (id ${ts}).`);
        }
        default:
          return this.result(`Unknown tool: ${name}`, true);
      }
    } catch (e) {
      return this.result((e as Error).message, true);
    }
  }

  /** Resolve a send_file path and refuse anything outside the allowed roots
   *  (after symlink resolution, so a link can't smuggle out other files). */
  private resolveSendablePath(raw: string): string {
    if (!raw.trim()) throw new Error('send_file requires a "path".');
    const candidate = isAbsolute(raw) ? raw : resolve(this.cfg.sendFileRoots[0], raw);
    let real: string;
    try { real = realpathSync(candidate); } catch { throw new Error(`File not found: ${raw}`); }
    const inside = this.cfg.sendFileRoots.some((root) => {
      let r: string;
      try { r = realpathSync(root); } catch { return false; }
      return real === r || real.startsWith(r.endsWith(sep) ? r : r + sep);
    });
    if (!inside) throw new Error(`Refusing to send ${raw}: outside the allowed directories.`);
    if (!statSync(real).isFile()) throw new Error(`Not a regular file: ${raw}`);
    return real;
  }
}
