/**
 * Environment configuration. Everything is read once at startup.
 *
 *   SIGNAL_ACCOUNT          Required. The bot's registered number (or ACI).
 *   SIGNAL_ALLOWED_SENDERS  Comma-separated numbers and/or ACIs (UUIDs) whose
 *                           DMs are relayed. Fail-closed: empty ⇒ nothing is
 *                           relayed (dropped senders are logged by id, never
 *                           by content, so the first message reveals the id
 *                           to allowlist when a sender hides their number).
 *   SIGNAL_CONTACT_NAMES    Optional display names, `id=Name,id=Name`.
 *   SIGNAL_CLI_BIN          signal-cli executable (default `signal-cli`).
 *   SIGNAL_CLI_CONFIG       signal-cli data dir (its --config).
 *   SIGNAL_CLI_SOCKET       Connect to `signal-cli daemon --socket PATH`
 *                           instead of spawning a child.
 *   SIGNAL_STATE_DIR        Message log + contacts (default ./signal-state).
 *   SIGNAL_MARKDOWN         `off` sends agent text verbatim (default on).
 *   SIGNAL_READ_RECEIPTS    `off` disables read receipts (default on).
 *   SIGNAL_SEND_FILE_ROOTS  Colon-separated directories `send_file` may read
 *                           from. Unset ⇒ the tool is not offered.
 *   SIGNAL_IMAGE_INLINE_MAX_BYTES  Largest inbound image inlined (3.5 MB).
 *   SIGNAL_TEXT_INLINE_MAX_BYTES   Largest inbound text file inlined (64 KB).
 */
import { resolve } from 'node:path';

export interface SignalMcplConfig {
  account: string;
  allowedSenders: Set<string>;
  contactNames: Map<string, string>;
  cliBin: string;
  cliConfigDir?: string;
  cliSocket?: string;
  stateDir: string;
  markdown: boolean;
  readReceipts: boolean;
  sendFileRoots: string[];
  imageInlineMaxBytes: number;
  textInlineMaxBytes: number;
}

const list = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const flag = (v: string | undefined, dflt: boolean): boolean => {
  if (v === undefined || v.trim() === '') return dflt;
  return !/^(0|off|false|no)$/i.test(v.trim());
};

const bytes = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SignalMcplConfig {
  const account = env.SIGNAL_ACCOUNT?.trim();
  if (!account) throw new Error('SIGNAL_ACCOUNT is required (the bot\'s registered Signal number)');
  const contactNames = new Map<string, string>();
  for (const pair of list(env.SIGNAL_CONTACT_NAMES)) {
    const eq = pair.indexOf('=');
    if (eq > 0) contactNames.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return {
    account,
    allowedSenders: new Set(list(env.SIGNAL_ALLOWED_SENDERS)),
    contactNames,
    cliBin: env.SIGNAL_CLI_BIN?.trim() || 'signal-cli',
    cliConfigDir: env.SIGNAL_CLI_CONFIG?.trim() || undefined,
    cliSocket: env.SIGNAL_CLI_SOCKET?.trim() || undefined,
    stateDir: resolve(env.SIGNAL_STATE_DIR?.trim() || './signal-state'),
    markdown: flag(env.SIGNAL_MARKDOWN, true),
    readReceipts: flag(env.SIGNAL_READ_RECEIPTS, true),
    sendFileRoots: (env.SIGNAL_SEND_FILE_ROOTS ?? '').split(':').map((s) => s.trim()).filter(Boolean).map((p) => resolve(p)),
    imageInlineMaxBytes: bytes(env.SIGNAL_IMAGE_INLINE_MAX_BYTES, 3_500_000),
    textInlineMaxBytes: bytes(env.SIGNAL_TEXT_INLINE_MAX_BYTES, 64 * 1024),
  };
}
