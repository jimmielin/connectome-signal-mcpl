/**
 * Local message log + contact book.
 *
 * Signal keeps no server-side history a client can page back through, so the
 * server records every message it relays — in and out — to an append-only
 * JSONL file. That log backs `fetch_history`, `channels/open` history, quote
 * and reaction targeting, and edit/delete lookups. It is also the durable
 * record for anything signal-cli received that the host could not take.
 *
 * Channel ids are `signal:dm:<peer>`, where <peer> is the sender's ACI (UUID)
 * when known, else their phone number.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SignalPeer } from './envelope.js';

export interface LoggedEntry {
  dir: 'in' | 'out';
  kind: 'message' | 'edit' | 'delete' | 'reaction';
  channelId: string;
  /** Signal sent-timestamp of this entry — the message id on the wire. */
  ts: number;
  /** Peer ACI/number for inbound, 'self' for outbound. */
  authorId: string;
  authorName: string;
  text?: string;
  /** edit / delete / reaction: the message acted on. */
  targetTs?: number;
  emoji?: string;
  remove?: boolean;
  quoteTs?: number;
  attachments?: Array<{ contentType?: string; filename?: string; size?: number }>;
  /** Wall-clock time this entry was recorded. */
  at: string;
}

export interface Contact {
  /** Channel id this contact's DM maps to. */
  channelId: string;
  uuid?: string;
  number?: string;
  /** Profile name last seen on an envelope. */
  profileName?: string;
  /** Operator-configured display name (SIGNAL_CONTACT_NAMES). */
  alias?: string;
  firstSeen: string;
  lastSeen: string;
}

/** A message as shown to the agent: edits applied, deletes and reactions folded in. */
export interface MessageView {
  ts: number;
  dir: 'in' | 'out';
  authorId: string;
  authorName: string;
  text: string;
  edited: boolean;
  deleted: boolean;
  quoteTs?: number;
  attachments?: LoggedEntry['attachments'];
  reactions: Array<{ emoji: string; by: string }>;
  at: string;
}

const CHANNEL_PREFIX = 'signal:dm:';
/** Entries kept in memory; the file itself is never truncated. */
const MEMORY_CAP = 5000;

export function dmChannelId(peer: SignalPeer): string | null {
  const key = peer.uuid ?? peer.number;
  return key ? `${CHANNEL_PREFIX}${key}` : null;
}

export function parseDmChannelId(id: string): string | null {
  return id.startsWith(CHANNEL_PREFIX) && id.length > CHANNEL_PREFIX.length ? id.slice(CHANNEL_PREFIX.length) : null;
}

export function displayName(c: Contact): string {
  return c.alias ?? c.profileName ?? c.number ?? c.uuid ?? c.channelId;
}

export class Store {
  private readonly logPath: string;
  private readonly contactsPath: string;
  private entries: LoggedEntry[] = [];
  private contacts = new Map<string, Contact>();

  constructor(dir: string, private readonly log: (...a: unknown[]) => void) {
    mkdirSync(dir, { recursive: true });
    this.logPath = join(dir, 'messages.jsonl');
    this.contactsPath = join(dir, 'contacts.json');
    this.load();
  }

  private load(): void {
    if (existsSync(this.logPath)) {
      const lines = readFileSync(this.logPath, 'utf8').split('\n');
      for (const line of lines.slice(-MEMORY_CAP)) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as LoggedEntry;
          if (typeof e.channelId === 'string' && typeof e.ts === 'number') this.entries.push(e);
        } catch { /* a torn last line from a crash — skip it */ }
      }
    }
    if (existsSync(this.contactsPath)) {
      try {
        const list = JSON.parse(readFileSync(this.contactsPath, 'utf8')) as Contact[];
        for (const c of list) if (c && typeof c.channelId === 'string') this.contacts.set(c.channelId, c);
      } catch (e) {
        this.log(`contacts file unreadable, starting empty: ${(e as Error).message}`);
      }
    }
  }

  append(entry: LoggedEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MEMORY_CAP) this.entries.splice(0, this.entries.length - MEMORY_CAP);
    try {
      appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
    } catch (e) {
      this.log(`message log write failed: ${(e as Error).message}`);
    }
  }

  /** Record a sighting of a peer; returns the (possibly new) contact. */
  upsertContact(peer: SignalPeer, alias?: string): Contact | null {
    const channelId = dmChannelId(peer);
    if (!channelId) return null;
    const now = new Date().toISOString();
    const prev = this.contacts.get(channelId);
    const next: Contact = {
      channelId,
      uuid: peer.uuid ?? prev?.uuid,
      number: peer.number ?? prev?.number,
      profileName: peer.name ?? prev?.profileName,
      alias: alias ?? prev?.alias,
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
    };
    this.contacts.set(channelId, next);
    this.saveContacts();
    return next;
  }

  getContact(channelId: string): Contact | undefined {
    return this.contacts.get(channelId);
  }

  listContacts(): Contact[] {
    return [...this.contacts.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  /** Resolve a free-form reference — channel id, uuid, number, or name — to a contact. */
  resolveContact(ref: string): Contact | undefined {
    const r = ref.trim();
    if (!r) return undefined;
    const direct = this.contacts.get(r) ?? this.contacts.get(`${CHANNEL_PREFIX}${r}`);
    if (direct) return direct;
    const lower = r.replace(/^@/, '').toLowerCase();
    return this.listContacts().find((c) =>
      c.uuid === r || c.number === r ||
      c.alias?.toLowerCase() === lower || c.profileName?.toLowerCase() === lower ||
      displayName(c).toLowerCase() === lower || `dm: ${displayName(c).toLowerCase()}` === lower);
  }

  private saveContacts(): void {
    try {
      const tmp = this.contactsPath + '.tmp';
      writeFileSync(tmp, JSON.stringify([...this.contacts.values()], null, 2));
      renameSync(tmp, this.contactsPath);
    } catch (e) {
      this.log(`contacts write failed: ${(e as Error).message}`);
    }
  }

  /** The raw message entry with this timestamp in a channel (any direction). */
  findMessage(channelId: string, ts: number): LoggedEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.channelId === channelId && e.kind === 'message' && e.ts === ts) return e;
    }
    return undefined;
  }

  lastMessage(channelId: string, dir?: 'in' | 'out'): LoggedEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.channelId === channelId && e.kind === 'message' && (!dir || e.dir === dir)) return e;
    }
    return undefined;
  }

  /** Messages in a channel, oldest first, with edits/deletes/reactions applied. */
  history(channelId: string, opts: { limit: number; beforeTs?: number }): MessageView[] {
    const views = new Map<number, MessageView>();
    const order: number[] = [];
    for (const e of this.entries) {
      if (e.channelId !== channelId) continue;
      if (e.kind === 'message') {
        if (!views.has(e.ts)) order.push(e.ts);
        views.set(e.ts, {
          ts: e.ts, dir: e.dir, authorId: e.authorId, authorName: e.authorName,
          text: e.text ?? '', edited: false, deleted: false,
          ...(e.quoteTs !== undefined ? { quoteTs: e.quoteTs } : {}),
          ...(e.attachments?.length ? { attachments: e.attachments } : {}),
          reactions: [], at: e.at,
        });
        continue;
      }
      const target = e.targetTs !== undefined ? views.get(e.targetTs) : undefined;
      if (!target) continue;
      if (e.kind === 'edit') { target.text = e.text ?? ''; target.edited = true; }
      else if (e.kind === 'delete') { target.deleted = true; target.text = ''; }
      else if (e.kind === 'reaction' && e.emoji) {
        target.reactions = target.reactions.filter((r) => r.by !== e.authorName);
        if (!e.remove) target.reactions.push({ emoji: e.emoji, by: e.authorName });
      }
    }
    let list = order.map((ts) => views.get(ts)!);
    if (opts.beforeTs !== undefined) list = list.filter((m) => m.ts < opts.beforeTs!);
    return list.slice(-Math.max(0, opts.limit));
  }
}
