# connectome-signal-mcpl

A [Signal](https://signal.org) surface for Connectome agents. It is an MCPL
server that wraps [signal-cli](https://github.com/AsamK/signal-cli)'s JSON-RPC
interface, so an agent can hold end-to-end-encrypted 1:1 conversations from
any Signal client (Signal, Molly, …).

```
phone (Signal/Molly) ⇄ Signal service ⇄ signal-cli ⇄ signal-mcpl ⇄ connectome-host ⇄ agent
                     └──────── end-to-end encrypted ────────┘
```

Messages are encrypted between the phone and the host running signal-cli; the
Signal service never sees plaintext. (The agent's inference provider and the
host's disk necessarily do.)

## What it does

- **Inbound:** DMs from allowlisted contacts are delivered to the agent as
  `push/event`s carrying `origin.mcplChannelId` (`signal:dm:<ACI>`), so the
  host registers the conversation and routes the agent's prose reply straight
  back. Edits, deletes, and reactions are relayed too (not tagged
  `chat:addressed`, so wake policies can treat them as ambient). Images are
  inlined; small text files are inlined; voice notes and other files are
  described.
- **Outbound:** the agent's prose (`channels/publish`) is sent as a Signal
  message, with markdown converted to Signal's native formatting (bold,
  italic, strikethrough, monospace, spoiler). Long messages are handled by
  signal-cli.
- **Presence:** a typing indicator while the agent is responding, and read
  receipts once the agent actually engages (types, replies, or reacts), not
  merely when the host queues the message.
- **Tools:** `send_message` (incl. quoting), `react`, `edit_message`,
  `delete_message`, `fetch_history`, `list_conversations`, and — if enabled —
  `send_file`. With multiple known contacts, specify `to`; ambiguous names
  are refused, so use the channel ID when names overlap.
- **History:** Signal has no server-side history, so every relayed message is
  appended to `$SIGNAL_STATE_DIR/messages.jsonl`; `fetch_history` and
  `channels/open` read from it.

Not yet: group chats (ignored), voice-note transcription, MCPL rollback.

## Safety properties

- **Allowlist, fail-closed.** Only senders in `SIGNAL_ALLOWED_SENDERS` are
  relayed, and the agent can only message allowlisted contacts. An empty list
  relays nothing. Dropped senders are logged by id only, never by content.
- **Nothing is lost before the host is ready.** signal-cli runs with
  `--receive-mode=manual` and is only subscribed once the host has granted
  push delivery (MCPL §5.3), so the Signal service holds messages until then.
- **Safety-number changes are not auto-trusted** (signal-cli's default
  `on-first-use`). A send to a contact whose key changed fails with an
  explanatory error until an operator verifies and runs `signal-cli trust`.
- **`send_file` is confined** to `SIGNAL_SEND_FILE_ROOTS` (symlinks resolved);
  without that variable the tool is not offered at all.

## Setup

### 1. Install signal-cli

macOS: `brew install signal-cli`. Linux: download a release from
<https://github.com/AsamK/signal-cli/releases> (the native build needs no
JVM; the JVM build needs the Java version named in the release notes).
Keep it updated — Signal stops accepting old clients after a few months.
The JSON-RPC integration was reviewed against signal-cli 0.14.9.

### 2. Register the bot's number

Run these as the user that will run the agent (signal-cli keeps its keys in
`~/.local/share/signal-cli` unless `--config` says otherwise):

```sh
# Solve https://signalcaptchas.org/registration/generate.html and copy the
# "Open Signal" link (signalcaptcha://…).
signal-cli -a +1BOTNUMBER register --captcha 'signalcaptcha://…'
#   landline? after one SMS attempt: add --voice
signal-cli -a +1BOTNUMBER verify 123456

signal-cli -a +1BOTNUMBER updateProfile --given-name SignalBot   # optional: --avatar pic.png
signal-cli -a +1BOTNUMBER setPin 'a-long-registration-lock-pin'   # blocks re-registration hijacks
```

### 3. Find your own id

From your phone, send the bot a message. Then run the server (or the agent)
with your number in `SIGNAL_ALLOWED_SENDERS`. If your number is hidden by
Signal's phone-number privacy, the message is dropped and the log prints your
ACI instead:

```
[signal-mcpl] dropped message from non-allowlisted sender uuid=… number=-
```

Put that UUID in `SIGNAL_ALLOWED_SENDERS`.

### 4. Build and add to the recipe

Requires Node.js 22.12 or newer.

```sh
git clone https://github.com/jimmielin/connectome-signal-mcpl.git
cd connectome-signal-mcpl
npm install && npm run build
```

```jsonc
"mcpServers": {
  "signal": {
    "command": "node",
    "args": ["/path/to/connectome-signal-mcpl/dist/src/index.js", "--stdio"],
    "env": {
      "SIGNAL_ACCOUNT": "${SIGNAL_ACCOUNT}",
      "SIGNAL_ALLOWED_SENDERS": "${SIGNAL_ALLOWED_SENDERS}",
      "SIGNAL_CONTACT_NAMES": "${SIGNAL_CONTACT_NAMES}",
      "SIGNAL_STATE_DIR": "./data/signal",
      "SIGNAL_CLI_BIN": "/path/to/signal-cli"
    }
  }
}
```

and, if the recipe has explicit wake policies, wake on addressed Signal
messages while letting reactions/edits wait for the next turn:

```jsonc
"wake": { "policies": [
  { "name": "signal-dm", "match": { "source": "signal", "tagsAny": ["chat:addressed"] }, "behavior": "always" },
  { "name": "signal-ambient", "match": { "source": "signal" }, "behavior": "defer" }
] }
```

(`source` is the `mcpServers` key.)

Set `SIGNAL_ACCOUNT` and `SIGNAL_ALLOWED_SENDERS` in the host's environment
before loading this recipe. Set `SIGNAL_CONTACT_NAMES` too, or remove its
optional line: Connectome rejects substitutions for unset variables. Other
`SIGNAL_*` settings must also be passed explicitly in the server's `env` map;
the host does not inherit arbitrary environment variables into MCPL children.

### Running signal-cli as a separate daemon (optional)

By default signal-mcpl spawns signal-cli as a child process. To keep
signal-cli running across agent restarts instead, run it as a service and
point the server at its socket:

```sh
signal-cli -a +1BOTNUMBER daemon --socket /run/user/$UID/signal-cli.sock --receive-mode=manual
```

```jsonc
"SIGNAL_CLI_SOCKET": "/run/user/1000/signal-cli.sock"
```

Socket requests explicitly select `SIGNAL_ACCOUNT`, and notifications for
other accounts are ignored. In socket mode, use the phone number for a
numbered account, or the ACI for a numberless account, matching signal-cli's
notification `account` field.

## Configuration

| Variable | Default | |
|---|---|---|
| `SIGNAL_ACCOUNT` | — (required) | The bot's registered number (or ACI). |
| `SIGNAL_ALLOWED_SENDERS` | empty ⇒ relay nothing | Comma-separated numbers and/or ACIs. |
| `SIGNAL_CONTACT_NAMES` | — | `id=Name,…` display names shown to the agent. |
| `SIGNAL_CLI_BIN` | `signal-cli` | Executable for spawn mode. |
| `SIGNAL_CLI_CONFIG` | signal-cli default | signal-cli data dir (`--config`). |
| `SIGNAL_CLI_SOCKET` | — | Use a running daemon instead of spawning. |
| `SIGNAL_STATE_DIR` | `./signal-state` | Message log and contact book. |
| `SIGNAL_MARKDOWN` | on | `off` sends agent text verbatim. |
| `SIGNAL_READ_RECEIPTS` | on | `off` never sends read receipts. |
| `SIGNAL_SEND_FILE_ROOTS` | — (tool hidden) | Colon-separated dirs `send_file` may read. |
| `SIGNAL_IMAGE_INLINE_MAX_BYTES` | 3500000 | Larger images are described, not inlined. |
| `SIGNAL_TEXT_INLINE_MAX_BYTES` | 65536 | Larger text files are described, not inlined. |
| `AGENT_TIMEZONE` | system | Injected by connectome-host; used in `fetch_history`. |

### Local data and privacy

The state directory contains **plaintext** message content and contact IDs.
New state directories are owner-only and state files are readable/writable
only by their owner. Keep this directory and signal-cli's key/attachment
directory out of Git, backups you do not trust, and public release artifacts.
The npm package includes only the runtime, source, README, and license.

The append-only log retains original text even after a message is edited or
deleted, and it does not implement Signal disappearing-message expiration.
Only the most recent 5,000 log entries are loaded for history; the on-disk log
is not automatically pruned. Delivery failures are logged, but are not
automatically replayed after a server restart. Dropped-sender diagnostics
contain contact IDs, and signal-cli's own diagnostics may also contain
operational metadata. Treat stderr logs as private.

## MCPL surface

- Capabilities: `pushEvents`, `channels.{register,lifecycle,publish,incoming,acknowledge,typing}`.
- Feature sets: `signal.messaging` (`tools`, `pushEvents`, `channels.register`,
  `channels.publish`) — the core; `signal.channels` (`channels.lifecycle`,
  `channels.incoming`, `channels.acknowledge`, `channels.typing`) — optional,
  so a host that withholds these degrades to "DMs in, replies out".
- Event tags: messages carry `chat:dm`, `chat:addressed`, `chat:private`,
  `chat:from-human`, plus `chat:reply` (quoting the agent) and
  `chat:has-image|audio|file`. Edits, deletes, and reactions carry only
  `chat:private`, `chat:from-human`, and `chat:edited` / `chat:deleted` /
  `chat:reaction` / `chat:reaction-remove` — never `chat:dm`, because the
  host expands `chat:dm` to `chat:addressed` (MCPL §16.3).

## Development

```sh
npm test    # unit tests + an end-to-end run against a fake signal-cli
```

`src/mcpl05.ts` and `src/timezone.ts` are vendored from
connectome-heartbeat-mcpl; keep them in sync.

This MCPL was developed in collaboration with Claude Opus 5.5.
