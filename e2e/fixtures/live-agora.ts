import type { Page } from '@playwright/test';
import type { Row } from './postgrest';
import { WORKSPACE_ID } from './chat-data';

// A live-capable stand-in for the harness Agora stub, served in its place for
// one page (the harness stub itself is unchanged): each connection registers
// on window.__agoraLive, and a spec delivers a peer's text or command to every
// registered handler (the app's foundation handler and the open thread's), as
// Agora would. `suppressed` drops deliveries (missed events: asleep, away).

const LIVE_STUB = `
const live = (globalThis.__agoraLive ??= { connections: new Set(), suppressed: false, delivered: 0 });
let sequence = 0;
class HarnessConnection {
  constructor() { this.handlers = new Map(); live.connections.add(this); }
  open() { return Promise.resolve({ accessToken: 'harness' }); }
  close() { this.handlers.clear(); live.connections.delete(this); }
  renewToken() { return Promise.resolve({ status: true }); }
  addEventHandler(id, handler) { this.handlers.set(id, handler); }
  removeEventHandler(id) { this.handlers.delete(id); }
  send() {
    sequence += 1;
    return Promise.resolve({ serverMsgId: 'harness-' + sequence, localMsgId: 'local-' + sequence });
  }
  subscribePresence() { return Promise.resolve({ data: { result: [] } }); }
  unsubscribePresence() { return Promise.resolve(); }
}
live.emit = (kind, message) => {
  if (live.suppressed) return 0;
  let n = 0;
  for (const connection of live.connections) {
    for (const handler of [...connection.handlers.values()]) {
      const fn = kind === 'txt' ? handler.onTextMessage : handler.onCmdMessage;
      if (typeof fn === 'function') { fn(message); n += 1; }
    }
  }
  live.delivered += n;
  return n;
};
const harnessSdk = {
  connection: HarnessConnection,
  message: {
    create(options) { sequence += 1; return { ...options, id: 'harness-msg-' + sequence }; },
  },
};
export default harnessSdk;
`;

/** The Agora username of a Sorted user id (u_ + 32 hex, no hyphens). */
export function agoraName(userId: string): string {
  return `u_${userId.toLowerCase().replace(/-/g, '')}`;
}

export interface LiveAgora {
  /** Stop (true) or resume delivering live events. */
  suppress: (on: boolean) => Promise<void>;
  /** A peer's new message: recorded in `rows`, then delivered live. */
  send: (input: {
    rows: Row[];
    id: string;
    channelId: string;
    from: string;
    body: string;
    createdAt: string;
    workspaceId?: string;
  }) => Promise<number>;
  /** A peer's edit: the row changes, then the edit signal goes live. */
  edit: (input: { row: Row; body: string; workspaceId?: string }) => Promise<number>;
  /** A peer's delete for everyone: the row turns deleted, then the signal goes live. */
  remove: (input: { row: Row; workspaceId?: string }) => Promise<number>;
  /** A peer's reaction: recorded in `reactions`, then the signal goes live. */
  react: (input: {
    reactions: Row[];
    messageId: string;
    from: string;
    emoji: string;
    workspaceId?: string;
  }) => Promise<number>;
}

/** Serve the live stub for this page (call after installHarnessNetwork, before goto). */
export async function installLiveAgora(page: Page): Promise<LiveAgora> {
  await page.route(/\/stubs\/agora-chat\.ts(\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/javascript' },
      body: LIVE_STUB,
    });
  });
  const emit = (kind: 'txt' | 'cmd', message: Record<string, unknown>): Promise<number> =>
    page.evaluate(
      ({ kind: k, message: m }) =>
        (
          window as unknown as {
            __agoraLive?: { emit: (kind: string, message: unknown) => number };
          }
        ).__agoraLive?.emit(k, m) ?? 0,
      { kind, message },
    );
  return {
    suppress: async (on) => {
      await page.evaluate((value) => {
        const live = (window as unknown as { __agoraLive?: { suppressed: boolean } }).__agoraLive;
        if (live !== undefined) live.suppressed = value;
      }, on);
    },
    send: async (input) => {
      input.rows.push({
        id: input.id,
        channel_id: input.channelId,
        workspace_id: WORKSPACE_ID,
        sender_user_id: input.from,
        body: input.body,
        mentions: null,
        attachment_asset_ids: null,
        shared_post_ids: null,
        shared_brief_ids: null,
        shared_plan_ids: null,
        reply_to_message_id: null,
        forwarded_from_message_id: null,
        attachment_meta: null,
        agora_event_id: null,
        created_at: input.createdAt,
        edited_at: null,
        deleted_at: null,
        thread_root_message_id: null,
      });
      return emit('txt', {
        id: `live-${input.id}`,
        type: 'txt',
        chatType: 'singleChat',
        msg: input.body,
        from: agoraName(input.from),
        to: 'harness',
        time: Date.parse(input.createdAt),
        ext: {
          sorted_message_id: input.id,
          sorted_channel_id: input.channelId,
          sorted_workspace_id: input.workspaceId ?? WORKSPACE_ID,
        },
      });
    },
    edit: async (input) => {
      const editedAt = new Date().toISOString();
      input.row.body = input.body;
      input.row.edited_at = editedAt;
      return emit('cmd', {
        id: `edit-${String(input.row.id)}-${editedAt}`,
        type: 'cmd',
        from: agoraName(String(input.row.sender_user_id)),
        ext: {
          sorted_event: 'edit',
          message_ids: [input.row.id],
          body: input.body,
          edited_at: editedAt,
          sorted_workspace_id: input.workspaceId ?? WORKSPACE_ID,
        },
      });
    },
    remove: async (input) => {
      input.row.deleted_at = new Date().toISOString();
      return emit('cmd', {
        id: `delete-${String(input.row.id)}`,
        type: 'cmd',
        from: agoraName(String(input.row.sender_user_id)),
        ext: {
          sorted_event: 'delete',
          message_ids: [input.row.id],
          sorted_workspace_id: input.workspaceId ?? WORKSPACE_ID,
        },
      });
    },
    react: async (input) => {
      input.reactions.push({
        message_id: input.messageId,
        emoji: input.emoji,
        user_id: input.from,
        created_at: new Date().toISOString(),
      });
      return emit('cmd', {
        id: `react-${input.messageId}-${input.emoji}`,
        type: 'cmd',
        from: agoraName(input.from),
        ext: {
          sorted_event: 'reaction',
          message_id: input.messageId,
          emoji: input.emoji,
          op: 'add',
          sorted_workspace_id: input.workspaceId ?? WORKSPACE_ID,
        },
      });
    },
  };
}
