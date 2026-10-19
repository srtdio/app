// Voice note drafts (FT42): a recording that was still running when its
// composer went away (Back, a chat switch, a tab change, sign-out, the page
// hiding) is kept per chat instead of being dropped. Returning to that chat
// shows it above the composer with Play, Send and Delete.
//
// The draft lives in an in-memory map keyed by channel id (one per chat; a
// new one replaces the old), plus a best-effort copy of the blob in the
// outbox's IndexedDB store (outbox-files.ts) so it survives a reload. Every
// storage call is in a try/catch: a failing IndexedDB still leaves the
// in-memory draft for this session. Recordings shorter than MIN_VOICE_NOTE_MS
// are dropped, as a send of one would be.
//
// The IndexedDB copy is one StoredOutboxFile under the entry id
// "voice-draft:<channelId>" (index 0). Its `name` carries the draft's
// metadata as JSON (duration, mime, recorder mime), since the file record has
// no other free field. The provider's boot prune keeps these ids
// (isVoiceDraftEntryId) and sign-out clears the whole store.

import { useSyncExternalStore } from 'react';
import { openIndexedDbFiles, outboxFileKey, type OutboxFileAdapter } from '@/lib/chat/outbox-files';
import { MIN_VOICE_NOTE_MS, type RecordingResult } from '@/lib/chat/use-audio-recorder';

/** One chat's saved voice note. */
export interface VoiceDraft {
  channelId: string;
  blob: Blob;
  mime: string;
  recorderMime: string;
  durationMs: number;
  /** The recording it came from (a live snapshot is replaced when that recording ends). */
  recordingId: string | null;
}

/** The IndexedDB entry id prefix of a voice draft. */
export const VOICE_DRAFT_PREFIX = 'voice-draft:';

export function voiceDraftEntryId(channelId: string): string {
  return `${VOICE_DRAFT_PREFIX}${channelId}`;
}

/** Whether an outbox-files entry id is a voice draft's (the boot prune keeps these). */
export function isVoiceDraftEntryId(entryId: string): boolean {
  return entryId.startsWith(VOICE_DRAFT_PREFIX);
}

/** Whether a recording is long enough to keep (the send path's own rule). Pure. */
export function keepsAsDraft(rec: Pick<RecordingResult, 'blob' | 'durationMs'> | null): boolean {
  return rec !== null && rec.blob.size > 0 && rec.durationMs >= MIN_VOICE_NOTE_MS;
}

/** "Voice note 0:07": the draft's label, m:ss. Pure. */
export function voiceDraftLabel(durationMs: number): string {
  const total = Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs / 1000) : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `Voice note ${m}:${String(s).padStart(2, '0')}`;
}

export const VOICE_DRAFT_DELETE_TITLE = 'Delete this voice note?';
export const VOICE_DRAFT_REPLACE_TITLE = 'Replace the saved voice note?';

const drafts = new Map<string, VoiceDraft>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

// The IndexedDB store, opened on first use; null where there is none. Tests
// swap it with setVoiceDraftFiles.
let files: OutboxFileAdapter | null | undefined;

function store(): OutboxFileAdapter | null {
  if (files === undefined) {
    try {
      files = openIndexedDbFiles();
    } catch {
      files = null;
    }
  }
  return files;
}

/** Test seam: the file store voice drafts copy into (null: none). */
export function setVoiceDraftFiles(adapter: OutboxFileAdapter | null): void {
  files = adapter;
}

interface StoredMeta {
  durationMs: number;
  mime: string;
  recorderMime: string;
}

function encodeMeta(meta: StoredMeta): string {
  return JSON.stringify(meta);
}

function decodeMeta(name: string): StoredMeta | null {
  try {
    const value: unknown = JSON.parse(name);
    if (typeof value !== 'object' || value === null) return null;
    const { durationMs, mime, recorderMime } = value as Record<string, unknown>;
    if (typeof durationMs !== 'number' || typeof mime !== 'string') return null;
    return {
      durationMs,
      mime,
      recorderMime: typeof recorderMime === 'string' ? recorderMime : '',
    };
  } catch {
    return null;
  }
}

/** The best-effort IndexedDB copy. Never throws. */
async function persist(draft: VoiceDraft): Promise<void> {
  const adapter = store();
  if (adapter === null) return;
  try {
    const entryId = voiceDraftEntryId(draft.channelId);
    await adapter.put(outboxFileKey(entryId, 0), {
      entryId,
      index: 0,
      name: encodeMeta({
        durationMs: draft.durationMs,
        mime: draft.mime,
        recorderMime: draft.recorderMime,
      }),
      type: draft.mime,
      lastModified: Date.now(),
      blob: draft.blob,
    });
  } catch {
    // The in-memory draft still holds for this session.
  }
}

async function unpersist(channelId: string): Promise<void> {
  const adapter = store();
  if (adapter === null) return;
  try {
    await adapter.delete([outboxFileKey(voiceDraftEntryId(channelId), 0)]);
  } catch {
    // An orphan copy is replaced by the next draft or cleared on sign-out.
  }
}

/**
 * Keep a recording as this chat's draft (replacing any). False when it is
 * too short (dropped, as today) or has no chat. The in-memory copy is set
 * synchronously; the IndexedDB copy follows in the background.
 */
export function saveVoiceDraft(
  channelId: string | undefined,
  rec: RecordingResult | null,
  recordingId: string | null = null,
): boolean {
  if (channelId === undefined || channelId === '' || rec === null || !keepsAsDraft(rec)) {
    return false;
  }
  const draft: VoiceDraft = {
    channelId,
    blob: rec.blob,
    mime: rec.mime,
    recorderMime: rec.recorderMime,
    durationMs: rec.durationMs,
    recordingId,
  };
  drafts.set(channelId, draft);
  notify();
  void persist(draft);
  return true;
}

export function getVoiceDraft(channelId: string | undefined): VoiceDraft | null {
  if (channelId === undefined) return null;
  return drafts.get(channelId) ?? null;
}

/** Drop this chat's draft (Send, Delete, Replace). */
export function deleteVoiceDraft(channelId: string | undefined): void {
  if (channelId === undefined) return;
  const had = drafts.delete(channelId);
  if (had) notify();
  void unpersist(channelId);
}

/**
 * Drop the draft only when it is a snapshot of this recording (a page-hide
 * copy of a recording that then ended normally: sent or cancelled).
 */
export function dropSnapshotOf(channelId: string | undefined, recordingId: string): void {
  const draft = getVoiceDraft(channelId);
  if (draft !== null && draft.recordingId === recordingId) deleteVoiceDraft(channelId);
}

/** The recording to hand to the send path. Pure. */
export function draftRecording(draft: VoiceDraft): RecordingResult {
  return {
    blob: draft.blob,
    mime: draft.mime,
    recorderMime: draft.recorderMime,
    durationMs: draft.durationMs,
  };
}

/**
 * Bring a chat's draft back from IndexedDB after a reload (no-op when one is
 * already in memory or nothing is stored). Never throws.
 */
export async function restoreVoiceDraft(channelId: string | undefined): Promise<void> {
  if (channelId === undefined || drafts.has(channelId)) return;
  const adapter = store();
  if (adapter === null) return;
  try {
    const found = await adapter.get(outboxFileKey(voiceDraftEntryId(channelId), 0));
    if (found === undefined || !(found.blob instanceof Blob)) return;
    const meta = decodeMeta(found.name);
    if (meta === null || drafts.has(channelId)) return;
    const rec: RecordingResult = {
      blob: found.blob,
      mime: meta.mime,
      recorderMime: meta.recorderMime,
      durationMs: meta.durationMs,
    };
    if (!keepsAsDraft(rec)) return;
    drafts.set(channelId, { channelId, ...rec, recordingId: null });
    notify();
  } catch {
    // Unreadable store: no draft to bring back.
  }
}

/** Sign-out: no draft outlives the session in memory (the provider clears IndexedDB). */
export function clearVoiceDrafts(): void {
  if (drafts.size === 0) return;
  drafts.clear();
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** This chat's draft, re-read on every change. */
export function useVoiceDraft(channelId: string | undefined): VoiceDraft | null {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  return getVoiceDraft(channelId);
}

/** Test seam: forget every draft and the store. */
export function resetVoiceDrafts(): void {
  drafts.clear();
  files = undefined;
  notify();
}
