// Personal notes fixture: the signed-in user's notes channel (deterministic id
// notes__<workspace>__<user>) with enough notes to scroll, one saved copy of a
// DM message ("Saved from <DM> · <peer>"), and a photo note for the Photos chip.
// seedNotes adds them to a built world; without it, notes_channel_ensure
// creates the empty channel on Chat home load like the live proc.

import type { Row } from './postgrest';
import { DM_CHANNEL, ME, WORKSPACE_ID, type ChatWorld } from './chat-data';

export const NOTES_CHANNEL = `notes__${WORKSPACE_ID}__${ME}`;
export const NOTES_TITLE = 'Personal notes';
export const NOTE_PHOTO_BODY = 'Moodboard for the spring shoot';
/** The photo note's asset version id. */
const NOTE_PHOTO_ASSET = '0190c9d0-0000-7000-8000-000000000001';
const HOUR = 3_600_000;

const NOTES = [
  'Shoot list for Monday: hero pack, 3 flat lays, 1 lifestyle',
  'Ask the client about the spring palette',
  'Caption ideas: fresh start, new season, clean slate',
  'Book the studio for Thursday morning',
  'Review the analytics deck before the call',
  'Draft three hooks for the teaser reel',
  'Send the invoice for September',
  'Check alt text on the carousel images',
];

function noteId(n: number): string {
  return `0190c900-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

/** The photo note's tile in the Photos chip grid (`messageId:versionId`). */
export const NOTE_PHOTO_TILE = `${noteId(18)}:${NOTE_PHOTO_ASSET}`;

/** The notes channel row, as notes_channel_ensure inserts it. */
export function notesChannelRow(): Row {
  return {
    channel_id: NOTES_CHANNEL,
    workspace_id: WORKSPACE_ID,
    channel_type: 'notes',
    entity_id: null,
    dm_user_a: null,
    dm_user_b: null,
    owner_user_id: ME,
    agora_group_id: null,
    last_synced_at: null,
    created_at: new Date(Date.now() - 48 * HOUR).toISOString(),
  };
}

function noteRow(n: number, createdAt: string, body: string | null): Row {
  return {
    id: noteId(n),
    channel_id: NOTES_CHANNEL,
    workspace_id: WORKSPACE_ID,
    sender_user_id: ME,
    body,
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    reply_to_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: createdAt,
    edited_at: null,
    deleted_at: null,
    thread_root_message_id: null,
  };
}

/** Add the notes channel and its notes (a saved DM copy, a photo note) to the world. */
export function seedNotes(world: ChatWorld, now: number = Date.now()): { savedSourceId: string } {
  const channels = (world.tables.chat_channels ??= []);
  if (!channels.some((c) => c.channel_id === NOTES_CHANNEL)) channels.push(notesChannelRow());
  const messages = (world.tables.chat_messages ??= []);
  const start = now - 20 * HOUR;
  const rows: Row[] = [];
  for (let n = 1; n <= 16; n += 1) {
    rows.push(
      noteRow(
        n,
        new Date(start + n * 60 * 60_000).toISOString(),
        NOTES[n % NOTES.length] ?? 'Note',
      ),
    );
  }
  // A saved copy of a peer's DM message.
  const source = world.dmMessages.find(
    (m) => m.sender_user_id !== ME && typeof m.body === 'string',
  );
  const savedSourceId = String(source?.id ?? '');
  const saved = noteRow(17, new Date(now - 50 * 60_000).toISOString(), String(source?.body ?? ''));
  saved.forwarded_from_message_id = savedSourceId;
  rows.push(saved);
  // A photo note (the Photos chip lists it).
  const photo = noteRow(18, new Date(now - 40 * 60_000).toISOString(), NOTE_PHOTO_BODY);
  const asset = NOTE_PHOTO_ASSET;
  photo.attachment_asset_ids = [asset];
  photo.attachment_meta = { [asset]: { mime: 'image/png', name: 'moodboard.png', size: 52_000 } };
  rows.push(photo);
  messages.push(...rows);
  return { savedSourceId };
}

export { DM_CHANNEL };

/** A profile photo the asset-read fixture host serves (a solid PNG). */
export const OWN_PHOTO_URL = 'https://asset-read.harness.test/blob/profile/me.png';

/** Give the signed-in user a profile photo (users.avatar_url). */
export function setOwnAvatar(world: ChatWorld, url: string | null): void {
  const me = (world.tables.users ?? []).find((u) => u.id === ME);
  if (me !== undefined) me.avatar_url = url;
}
