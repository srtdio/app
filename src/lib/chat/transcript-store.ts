// Per-device voice-note state: the transcript fetched on tap, a failed attempt,
// the transcript block's collapsed flag, and whether the note has played to the
// end once. Private to this device: nothing here is written to Supabase,
// attachment_meta, Agora or any RPC.
//
// Backed by localStorage under one namespaced key (there is no shared
// IndexedDB wrapper in src/lib). Reads are synchronous, so a bubble renders its
// final state on first paint. Records are kept in recency order and capped at
// VOICE_RECORD_CAP (oldest evicted). Every storage read and write is wrapped:
// when storage is unavailable or throws, the store keeps working in memory for
// the session and never throws into render.
//
// An in-flight transcription ("pending") is session-only and never persisted.

import { useSyncExternalStore } from 'react';

/** The localStorage key holding every record. */
export const VOICE_STORE_KEY = 'srtdio.chat.voice-notes.v1';

/** Most records kept; the least recently touched are evicted beyond this. */
const VOICE_RECORD_CAP = 500;

/** One message's local voice-note state. */
interface VoiceRecord {
  transcript?: string;
  /** Epoch ms of the last failed transcription; absent when none failed. */
  failedAt?: number;
  /** The transcript block is folded to its one-line row. */
  collapsed?: boolean;
  /** Epoch ms the note first played to the end on this device. */
  playedAt?: number;
}

/** Fields to merge into a record; an undefined value clears that field. */
type VoicePatch = { [K in keyof VoiceRecord]?: VoiceRecord[K] | undefined };

/** What a bubble renders for its transcript. */
export type TranscriptView =
  | { kind: 'none' }
  | { kind: 'pending' }
  | { kind: 'failed' }
  | { kind: 'shown'; text: string; collapsed: boolean };

/** The slice of Storage the store touches; a fake satisfies it in tests. */
export interface VoiceStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
}

function isRecord(value: unknown): value is VoiceRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    (r.transcript === undefined || typeof r.transcript === 'string') &&
    (r.failedAt === undefined || typeof r.failedAt === 'number') &&
    (r.collapsed === undefined || typeof r.collapsed === 'boolean') &&
    (r.playedAt === undefined || typeof r.playedAt === 'number')
  );
}

/** Parse the stored payload: [id, record] pairs, oldest first. Malformed input reads as empty. */
export function parseVoiceRecords(raw: string | null): Map<string, VoiceRecord> {
  const map = new Map<string, VoiceRecord>();
  if (raw === null) return map;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return map;
  }
  if (!Array.isArray(parsed)) return map;
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [id, record] = entry as [unknown, unknown];
    if (typeof id === 'string' && id !== '' && isRecord(record)) map.set(id, record);
  }
  return map;
}

/** The view for one record plus its pending flag. Pure. */
export function transcriptView(record: VoiceRecord | undefined, pending: boolean): TranscriptView {
  if (pending) return { kind: 'pending' };
  if (record?.transcript !== undefined) {
    return { kind: 'shown', text: record.transcript, collapsed: record.collapsed === true };
  }
  if (record?.failedAt !== undefined) return { kind: 'failed' };
  return { kind: 'none' };
}

/**
 * Whether the menu offers "Transcribe": no transcript yet, or the last attempt
 * failed; never while one is in flight. Pure.
 */
export function canOfferTranscribe(record: VoiceRecord | undefined, pending: boolean): boolean {
  return !pending && record?.transcript === undefined;
}

interface VoiceStore {
  get: (id: string) => VoiceRecord | undefined;
  isPending: (id: string) => boolean;
  /** Merge fields into a record (moving it to the newest end) and persist. */
  update: (id: string, patch: VoicePatch) => void;
  setPending: (id: string, pending: boolean) => void;
  subscribe: (listener: () => void) => () => void;
  /** Forget every record (memory and storage) and pending flag. */
  clear: () => void;
}

/** Build a store over `storage` (null: memory only). Never throws. */
export function createVoiceStore(
  storage: VoiceStorage | null,
  cap: number = VOICE_RECORD_CAP,
): VoiceStore {
  let backing = storage;
  let records: Map<string, VoiceRecord> | null = null;
  const pending = new Set<string>();
  const listeners = new Set<() => void>();

  const load = (): Map<string, VoiceRecord> => {
    if (records !== null) return records;
    let raw: string | null = null;
    try {
      raw = backing?.getItem(VOICE_STORE_KEY) ?? null;
    } catch {
      backing = null;
    }
    records = parseVoiceRecords(raw);
    return records;
  };

  const persist = (map: Map<string, VoiceRecord>): void => {
    if (backing === null) return;
    try {
      backing.setItem(VOICE_STORE_KEY, JSON.stringify([...map.entries()]));
    } catch {
      // Quota or a blocked store: keep the session going in memory.
      backing = null;
    }
  };

  const emit = (): void => {
    for (const listener of listeners) listener();
  };

  return {
    get: (id) => load().get(id),
    isPending: (id) => pending.has(id),
    update(id, patch) {
      const map = load();
      const merged: VoicePatch = { ...map.get(id), ...patch };
      const next: VoiceRecord = {};
      if (merged.transcript !== undefined) next.transcript = merged.transcript;
      if (merged.failedAt !== undefined) next.failedAt = merged.failedAt;
      if (merged.collapsed !== undefined) next.collapsed = merged.collapsed;
      if (merged.playedAt !== undefined) next.playedAt = merged.playedAt;
      map.delete(id);
      map.set(id, next);
      while (map.size > cap) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
      persist(map);
      emit();
    },
    setPending(id, on) {
      if (on === pending.has(id)) return;
      if (on) pending.add(id);
      else pending.delete(id);
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear() {
      records = new Map();
      pending.clear();
      // The original storage, even when a failed write fell back to memory.
      if (storage !== null) {
        try {
          if (storage.removeItem !== undefined) storage.removeItem(VOICE_STORE_KEY);
          else storage.setItem(VOICE_STORE_KEY, '[]');
        } catch {
          // Blocked storage has nothing to clear.
        }
      }
      emit();
    },
  };
}

function browserStorage(): VoiceStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** The app-wide store. */
export const voiceStore = createVoiceStore(browserStorage());

/** Sign-out: every voice-note record goes, from memory and storage. Never throws. */
export function clearVoiceTranscripts(store: VoiceStore = voiceStore): void {
  store.clear();
}

/**
 * One message's record and pending flag. A write replaces only that message's
 * record object, so a bubble re-renders for its own changes, never another's.
 * `id` undefined reads as nothing.
 */
export function useVoiceRecord(
  id: string | undefined,
  store: VoiceStore = voiceStore,
): { record: VoiceRecord | undefined; pending: boolean } {
  const readRecord = (): VoiceRecord | undefined => (id !== undefined ? store.get(id) : undefined);
  const readPending = (): boolean => id !== undefined && store.isPending(id);
  const record = useSyncExternalStore(store.subscribe, readRecord, readRecord);
  const pending = useSyncExternalStore(store.subscribe, readPending, readPending);
  return { record, pending };
}

/** Result shape of the transcribe call (mirrors transcribe.ts's Result). */
type TranscribeOutcome = { ok: true; transcript: string } | { ok: false };

/**
 * Transcribe one note on tap: mark it pending, resolve its audio source (the
 * app passes the presigned URL), hand it to the transcriber, then store the
 * transcript (expanded) or the failure. Never throws; a second tap while one
 * is in flight is ignored.
 */
export async function transcribeVoiceNote<A>(params: {
  messageId: string;
  fetchAudio: () => Promise<A>;
  transcribe: (audio: A) => Promise<TranscribeOutcome>;
  store?: VoiceStore;
  now?: () => number;
}): Promise<void> {
  const store = params.store ?? voiceStore;
  const now = params.now ?? Date.now;
  const id = params.messageId;
  if (store.isPending(id)) return;
  store.setPending(id, true);
  let text: string | null = null;
  try {
    const audio = await params.fetchAudio();
    const result = await params.transcribe(audio);
    if (result.ok && result.transcript.trim() !== '') text = result.transcript.trim();
  } catch {
    text = null;
  }
  if (text !== null) store.update(id, { transcript: text, failedAt: undefined, collapsed: false });
  else store.update(id, { failedAt: now() });
  store.setPending(id, false);
}
