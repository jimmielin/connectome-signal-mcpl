/**
 * Normalize signal-cli `receive` notifications into a small set of events.
 *
 * signal-cli emits two shapes (CHANGELOG 0.11.x): the plain
 * `{envelope, account}` used by automatic receiving, and the subscription
 * shape `{subscription, result: {envelope, account}}` used after an explicit
 * `subscribeReceive`. Both land here. Everything is defensive — the envelope
 * is a wire object from another process, and a field this build doesn't know
 * must degrade to `other`, never throw.
 */

export interface SignalPeer {
  uuid?: string;
  number?: string;
  /** Profile name as the sender's client shares it. */
  name?: string;
}

export interface SignalAttachmentInfo {
  id?: string;
  contentType?: string;
  filename?: string;
  size?: number;
  caption?: string;
  isVoiceNote?: boolean;
}

export interface SignalQuote {
  timestamp: number;
  authorUuid?: string;
  authorNumber?: string;
  text?: string;
}

export type InboundEvent =
  | {
      kind: 'message';
      account?: string;
      from: SignalPeer;
      timestamp: number;
      text: string;
      attachments: SignalAttachmentInfo[];
      quote?: SignalQuote;
      groupId?: string;
      sticker?: boolean;
      viewOnce?: boolean;
    }
  | {
      kind: 'edit';
      account?: string;
      from: SignalPeer;
      /** Timestamp of the edit itself — the edited message's new id. */
      timestamp: number;
      targetTimestamp: number;
      text: string;
      attachments: SignalAttachmentInfo[];
      groupId?: string;
    }
  | { kind: 'delete'; account?: string; from: SignalPeer; timestamp: number; targetTimestamp: number; groupId?: string }
  | {
      kind: 'reaction';
      account?: string;
      from: SignalPeer;
      timestamp: number;
      emoji: string;
      remove: boolean;
      targetTimestamp: number;
      targetAuthorUuid?: string;
      targetAuthorNumber?: string;
      groupId?: string;
    }
  | { kind: 'typing'; account?: string; from: SignalPeer; started: boolean; groupId?: string }
  | { kind: 'receipt'; account?: string; from: SignalPeer; type: 'delivery' | 'read' | 'viewed' | 'unknown'; timestamps: number[] }
  | { kind: 'sync'; account?: string }
  | { kind: 'other'; account?: string; reason: string };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function attachments(v: unknown): SignalAttachmentInfo[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).map((a) => ({
    id: str(a.id),
    contentType: str(a.contentType),
    filename: str(a.filename),
    size: num(a.size),
    caption: str(a.caption),
    ...(a.isVoiceNote === true ? { isVoiceNote: true } : {}),
  }));
}

function groupIdOf(dm: Obj): string | undefined {
  const gi = isObj(dm.groupInfo) ? dm.groupInfo : undefined;
  return gi ? str(gi.groupId) : undefined;
}

export function parseReceive(params: unknown): InboundEvent {
  if (!isObj(params)) return { kind: 'other', reason: 'params not an object' };
  const body = isObj(params.result) ? params.result : params;
  const account = str(body.account);
  const env = body.envelope;
  if (!isObj(env)) return { kind: 'other', account, reason: 'no envelope' };

  const from: SignalPeer = {
    uuid: str(env.sourceUuid),
    number: str(env.sourceNumber) ?? (str(env.source)?.startsWith('+') ? str(env.source) : undefined),
    name: str(env.sourceName),
  };
  const envTs = num(env.timestamp) ?? 0;

  if (isObj(env.syncMessage)) return { kind: 'sync', account };

  if (isObj(env.editMessage)) {
    const em = env.editMessage;
    const dm = isObj(em.dataMessage) ? em.dataMessage : {};
    const target = num(em.targetSentTimestamp);
    if (target === undefined) return { kind: 'other', account, reason: 'edit without targetSentTimestamp' };
    return {
      kind: 'edit',
      account,
      from,
      timestamp: num(dm.timestamp) ?? envTs,
      targetTimestamp: target,
      text: typeof dm.message === 'string' ? dm.message : '',
      attachments: attachments(dm.attachments),
      groupId: groupIdOf(dm),
    };
  }

  if (isObj(env.dataMessage)) {
    const dm = env.dataMessage;
    const ts = num(dm.timestamp) ?? envTs;
    const groupId = groupIdOf(dm);
    if (isObj(dm.remoteDelete)) {
      const target = num(dm.remoteDelete.timestamp);
      if (target === undefined) return { kind: 'other', account, reason: 'remoteDelete without timestamp' };
      return { kind: 'delete', account, from, timestamp: ts, targetTimestamp: target, groupId };
    }
    if (isObj(dm.reaction)) {
      const r = dm.reaction;
      const target = num(r.targetSentTimestamp);
      const emoji = str(r.emoji);
      if (target === undefined || !emoji) return { kind: 'other', account, reason: 'malformed reaction' };
      return {
        kind: 'reaction',
        account,
        from,
        timestamp: ts,
        emoji,
        remove: r.isRemove === true,
        targetTimestamp: target,
        targetAuthorUuid: str(r.targetAuthorUuid),
        targetAuthorNumber: str(r.targetAuthorNumber),
        groupId,
      };
    }
    const q = isObj(dm.quote) ? dm.quote : undefined;
    const quoteTs = q ? num(q.id) : undefined;
    const text = typeof dm.message === 'string' ? dm.message : '';
    const atts = attachments(dm.attachments);
    const sticker = isObj(dm.sticker);
    if (!text && atts.length === 0 && !sticker) {
      // Profile-key updates, expiration-timer changes, group updates, …
      return { kind: 'other', account, reason: 'data message without content' };
    }
    return {
      kind: 'message',
      account,
      from,
      timestamp: ts,
      text,
      attachments: atts,
      ...(q && quoteTs !== undefined
        ? { quote: { timestamp: quoteTs, authorUuid: str(q.authorUuid), authorNumber: str(q.authorNumber), text: str(q.text) } }
        : {}),
      groupId,
      ...(sticker ? { sticker: true } : {}),
      ...(dm.viewOnce === true ? { viewOnce: true } : {}),
    };
  }

  if (isObj(env.typingMessage)) {
    const t = env.typingMessage;
    return { kind: 'typing', account, from, started: t.action === 'STARTED', groupId: str(t.groupId) };
  }

  if (isObj(env.receiptMessage)) {
    const r = env.receiptMessage;
    const type = r.isRead === true ? 'read' : r.isViewed === true ? 'viewed' : r.isDelivery === true ? 'delivery' : 'unknown';
    const timestamps = Array.isArray(r.timestamps) ? r.timestamps.filter((t): t is number => typeof t === 'number') : [];
    return { kind: 'receipt', account, from, type, timestamps };
  }

  return { kind: 'other', account, reason: 'unhandled envelope type' };
}
