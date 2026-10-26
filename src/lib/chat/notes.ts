// Personal notes: one private chat per person per workspace. Its id is
// deterministic (notes__<workspace>__<user>), so the chat home tile and the
// thread paint from it at once; notes_channel_ensure creates the row once per
// workspace per session, in the background. Notes never touch Agora: no join,
// publish, typing, presence or read signal. Other devices catch up from
// Postgres when the thread opens, the window gets focus or the tab turns visible.

import type { Client, Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import type { ChannelSummary } from '@/lib/chat-reads';
import { abortable, READ_TIMEOUT_MS } from '@/lib/chat-reads';
import { generateTraceId } from '@/lib/trace';
import type { OutboxEntry } from '@/lib/chat/chat-store';
import type { ThreadMessage } from '@/lib/chat/thread';
import type { MessageAttachment } from '@/lib/chat/attachments';

/** The chat's name everywhere it shows (tile, header, search, forward picker). */
export const NOTES_TITLE = 'Personal notes';

/** The tile's second line. */
export const NOTES_TILE_LINE = 'Only you can see this';

/** The toast after a message was saved; tapping it opens notes. */
export const SAVED_TO_NOTES_TOAST = 'Saved to Personal notes';

/** The composer's placeholder in notes. */
export const NOTES_PLACEHOLDER = 'Note';

/** The id prefix every notes channel carries. */
const NOTES_PREFIX = 'notes__';

/** The caller's notes channel id in a workspace. Pure. */
export function notesChannelId(workspaceId: string, userId: string): string {
  return `${NOTES_PREFIX}${workspaceId}__${userId}`;
}

/** Whether a channel id names a notes channel. Pure. */
export function isNotesChannelId(channelId: string | null | undefined): boolean {
  return typeof channelId === 'string' && channelId.startsWith(NOTES_PREFIX);
}

/** Whether a roster row is a notes chat. Pure. */
export function isNotes(channel: Pick<ChannelSummary, 'channelType'> | null | undefined): boolean {
  return channel?.channelType === 'notes';
}

/**
 * The notes chat as a roster row, built from the session user and the open
 * workspace (never read), so it exists before notes_channel_ensure answers. Pure.
 */
export function notesSummary(
  workspaceId: string,
  userId: string,
  /** The user's own users.avatar_url (the notes avatar's photo); null shows the notebook. */
  avatarUrl: string | null = null,
): ChannelSummary {
  return {
    channelId: notesChannelId(workspaceId, userId),
    channelType: 'notes',
    title: NOTES_TITLE,
    avatarUrl,
    createdBy: null,
    agoraGroupId: null,
    groupId: null,
    peerUserId: null,
    role: null,
    // Never sorts: the tile is pinned above Groups.
    createdAt: '',
  };
}

/**
 * The roster with notes first (the forward picker, deep links, search hit
 * names). A notes row the read returned is replaced by the built one. Pure.
 */
export function withNotesFirst(
  roster: readonly ChannelSummary[],
  notes: ChannelSummary,
): ChannelSummary[] {
  return [notes, ...roster.filter((c) => c.channelType !== 'notes')];
}

/** One notes_channel_ensure call: its own uuid_v7 trace, 5s, never throws. */
export async function ensureNotesChannel(
  client: Client,
  params: { workspaceId: string; traceId?: string; timeoutMs?: number },
): Promise<Result<string>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? READ_TIMEOUT_MS);
  try {
    // Args built first, as record.ts does: p_trace_id is the proc's trace parameter.
    const args: Database['public']['Functions']['notes_channel_ensure']['Args'] = {
      p_workspace_id: params.workspaceId,
      p_trace_id: params.traceId ?? generateTraceId(),
    };
    const res = await abortable(client.rpc('notes_channel_ensure', args), controller.signal);
    if (controller.signal.aborted) return fail('notes_channel_ensure timed out');
    if (res.error) return fail(res.error.message);
    if (typeof res.data !== 'string' || res.data === '') return fail('notes_channel_ensure: no id');
    return { ok: true, data: res.data };
  } catch (error: unknown) {
    return fail(String(error));
  } finally {
    clearTimeout(timer);
  }
}

function fail<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'unknown', message } };
}

/** Where a workspace's ensure stands this session. */
export type EnsureState = 'pending' | 'ready' | 'failed';

/**
 * Once per workspace per session: the first ask runs the call, later asks
 * share its answer. A failed call is forgotten, so the next ask (a Retry, a
 * Save) tries again. Keyed by workspace and user (a sign-in as someone else
 * never reuses another person's answer).
 */
export interface NotesEnsurer {
  ensure: (workspaceId: string, userId: string) => Promise<Result<string>>;
  state: (workspaceId: string, userId: string) => EnsureState | null;
  /** Test seam: forget every answer. */
  reset: () => void;
}

export function createNotesEnsurer(
  run: (workspaceId: string) => Promise<Result<string>>,
): NotesEnsurer {
  const flights = new Map<string, Promise<Result<string>>>();
  const states = new Map<string, EnsureState>();
  const key = (workspaceId: string, userId: string): string => `${workspaceId}:${userId}`;
  return {
    ensure: (workspaceId, userId) => {
      const k = key(workspaceId, userId);
      const known = flights.get(k);
      if (known !== undefined) return known;
      states.set(k, 'pending');
      const flight = run(workspaceId).then((result) => {
        if (result.ok) states.set(k, 'ready');
        else {
          states.set(k, 'failed');
          flights.delete(k);
        }
        return result;
      });
      flights.set(k, flight);
      return flight;
    },
    state: (workspaceId, userId) => states.get(key(workspaceId, userId)) ?? null,
    reset: () => {
      flights.clear();
      states.clear();
    },
  };
}

/** Wait for an ensure at most this long before the thread shows its Retry. */
const NOTES_OPEN_WAIT_MS = 5_000;

/** Race an ensure against the open wait; a timeout is a failure. Never throws. */
export async function waitForNotes(
  flight: Promise<Result<string>>,
  timeoutMs: number = NOTES_OPEN_WAIT_MS,
): Promise<Result<string>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Result<string>>((resolve) => {
    timer = setTimeout(() => resolve(fail('notes open timed out')), timeoutMs);
  });
  try {
    return await Promise.race([
      flight.catch((error: unknown) => fail<string>(String(error))),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Save to notes as an outbox entry: the body as is, every attachment id with
 * its meta (no re-upload; the local file and preview are left behind, so the
 * source bubble keeps its own), the shared post and brief ids, the source id
 * as forwarded_from, no reply and no mentions. Pure.
 */
export function saveToNotesEntry(source: ThreadMessage, id: string): OutboxEntry {
  return {
    id,
    text: source.body,
    local: {
      attachments: source.attachments.map(withoutLocalFile),
      sharedPostIds: [...source.sharedPostIds],
      sharedBriefIds: [...source.sharedBriefIds],
      reply: null,
      forwardedFromMessageId: source.id,
    },
    state: 'sending',
  };
}

function withoutLocalFile(attachment: MessageAttachment): MessageAttachment {
  const { local, ...rest } = attachment;
  void local;
  return rest;
}

/** Whether a message can be saved: recorded and not deleted (sending and failed cannot). Pure. */
export function canSaveToNotes(message: Pick<ThreadMessage, 'state' | 'deleted'>): boolean {
  return message.state === 'sent' && message.deleted !== true;
}

/**
 * The live (Agora) connection a chat may use: none for notes, so no join,
 * publish, typing, presence or read signal can reach Agora from it. Pure.
 */
export function liveClientFor<T>(
  channel: Pick<ChannelSummary, 'channelType'> | null,
  client: T | null,
): T | null {
  return isNotes(channel) ? null : client;
}
