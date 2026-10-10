#!/usr/bin/env node
/**
 * signal-mcpl — Signal messenger MCPL server for Connectome.
 *
 * Usage: signal-mcpl --stdio
 *
 * Configuration is environment-only; see config.ts for the full list. The
 * minimum is SIGNAL_ACCOUNT (the bot's registered number) and
 * SIGNAL_ALLOWED_SENDERS (who may talk to it).
 */
import { McplConnection } from '@animalabs/mcpl-core';
import { loadConfig } from './config.js';
import { SignalMcplServer } from './server.js';
import { SignalRpc } from './signal-rpc.js';
import { Store } from './store.js';

function log(...a: unknown[]): void {
  console.error('[signal-mcpl]', ...a);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--stdio')) {
    console.error('Usage: signal-mcpl --stdio');
    process.exit(1);
  }
  const cfg = loadConfig();
  log(`starting: account=${cfg.account.replace(/\d(?=\d{4})/g, '•')} allowlisted=${cfg.allowedSenders.size} ` +
    `transport=${cfg.cliSocket ? `socket ${cfg.cliSocket}` : `spawn ${cfg.cliBin}`} state=${cfg.stateDir}`);

  const store = new Store(cfg.stateDir, log);
  const rpc = new SignalRpc({
    bin: cfg.cliBin,
    account: cfg.account,
    dataDir: cfg.cliConfigDir,
    socketPath: cfg.cliSocket,
    log,
  });
  const server = new SignalMcplServer(cfg, rpc, store, log);
  rpc.start();

  const shutdown = () => { rpc.stop(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await server.serve(McplConnection.fromStreams(process.stdin, process.stdout));
  log('host disconnected; shutting down');
  rpc.stop();
  process.exit(0);
}

main().catch((e) => {
  console.error('[signal-mcpl] fatal:', e);
  process.exit(1);
});
