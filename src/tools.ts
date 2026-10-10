/**
 * Agent-facing tools. Plain prose replies don't need any of these — the host
 * publishes them to the conversation the agent is answering. These are for
 * the things prose can't express: quoting, reacting, editing, deleting,
 * reading back history, and sending files.
 *
 * Every `to` is optional and defaults to the most recently active
 * conversation; every `message_id` is a Signal timestamp as shown by
 * fetch_history.
 */

const to = {
  type: 'string',
  description: 'Conversation: a name, number, or channel id. Defaults to the most recent conversation.',
};
const messageId = {
  type: 'string',
  description: 'Message id (the number shown as "id" in fetch_history).',
};

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export function toolDefinitions(opts: { sendFile: boolean }): ToolDef[] {
  const tools: ToolDef[] = [
    {
      name: 'send_message',
      description: 'Send a Signal message. Use for quoting a specific message (reply_to) or messaging a conversation other than the one you are answering; ordinary replies can just be written as prose. Markdown (**bold**, *italic*, `code`, ~~strike~~, ||spoiler||) is converted to Signal formatting.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message text.' },
          to,
          reply_to: { ...messageId, description: 'Quote this message (id from fetch_history).' },
        },
        required: ['text'],
      },
    },
    {
      name: 'react',
      description: 'React to a Signal message with an emoji (or remove your reaction). Defaults to the latest message from the other person.',
      inputSchema: {
        type: 'object',
        properties: {
          emoji: { type: 'string', description: 'A single emoji.' },
          message_id: messageId,
          to,
          remove: { type: 'boolean', description: 'Remove this reaction instead of adding it.' },
        },
        required: ['emoji'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit one of your own sent Signal messages (Signal shows it as edited).',
      inputSchema: {
        type: 'object',
        properties: { message_id: messageId, text: { type: 'string', description: 'Replacement text.' }, to },
        required: ['message_id', 'text'],
      },
    },
    {
      name: 'delete_message',
      description: 'Delete one of your own sent Signal messages for everyone.',
      inputSchema: {
        type: 'object',
        properties: { message_id: messageId, to },
        required: ['message_id'],
      },
    },
    {
      name: 'fetch_history',
      description: 'Read recent messages in a Signal conversation from the local log (oldest first), with message ids, edits, deletions, and reactions.',
      inputSchema: {
        type: 'object',
        properties: {
          to,
          limit: { type: 'number', description: 'How many messages (default 30, max 200).' },
          before: { ...messageId, description: 'Only messages older than this id.' },
        },
      },
    },
    {
      name: 'list_conversations',
      description: 'List Signal conversations you can message, most recent first.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
  if (opts.sendFile) {
    tools.push({
      name: 'send_file',
      description: 'Send a file (image, document, …) over Signal, optionally with a caption. The path must be inside one of the directories the operator allowed.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (absolute, or relative to the first allowed directory).' },
          caption: { type: 'string', description: 'Optional message text sent with the file.' },
          to,
        },
        required: ['path'],
      },
    });
  }
  return tools;
}
