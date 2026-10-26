// One composer draft per chat, like WhatsApp: the text, caret, reply target,
// shared cards and picked files typed into a chat stay with that chat when
// another one opens, and come back when it reopens. Keyed by the Sorted channel
// id, never by the title. Plain get / set / clear over one module map, plus a
// version and a subscribe so the chat list can show "Draft:" previews.
//
// The map is mirrored to localStorage per user and workspace (setDraftScope),
// so a reload brings drafts back: text, caret, reply and cards only. Picked
// files (a File and its object URL) stay in memory: a reload drops them, the
// rest of the draft stays. Writes are debounced and flushed on pagehide and
// when the tab hides. Without a scope the drafts are memory only. Sign-out
// clears every draft (clearAllDrafts); drafts for chats no longer in the
// user's roster are dropped (pruneDrafts). Every storage call is guarded: a
// blocked or malformed store reads as empty and never throws.

import type { PostCardFields } from '@srtdio/posts';
import type { BriefCardFields } from '@/lib/chat/briefs';
import type { ReplyQuote } from '@/lib/chat/attachments';
import { isNotesChannelId } from '@/lib/chat/notes';

/** A picked file waiting in a draft (the composer's chip). */
export interface DraftFile {
  id: string;
  file: File;
  previewUrl: string | null;
}

/** The reply a draft carries: its quote (quote.id is the replied-to message id). */
export interface DraftReply {
  authorName: string;
  quote: ReplyQuote;
  /**
   * The quoted message was deleted for everyone: the quote's text is gone and
   * the reply bar reads deletedMessageLabel. Absent is the same as false.
   */
  deleted?: true;
}

/** A draft reply whose quoted message was deleted: its text stripped, marked deleted. Pure. */
export function strippedReply(reply: DraftReply): DraftReply {
  return reply.deleted === true && reply.quote.preview === ''
    ? reply
    : { ...reply, quote: { ...reply.quote, preview: '' }, deleted: true };
}

interface ChannelDraft {
  text: string;
  caret: number;
  reply: DraftReply | null;
  sharedPosts: PostCardFields[];
  sharedBriefs: BriefCardFields[];
  pendingFiles: DraftFile[];
}

export const EMPTY_DRAFT: ChannelDraft = Object.freeze({
  text: '',
  caret: 0,
  reply: null,
  sharedPosts: [],
  sharedBriefs: [],
  pendingFiles: [],
}) as ChannelDraft;

/** The one localStorage key every persisted draft lives under. */
export const DRAFTS_STORAGE_KEY = 'sorted:chat:drafts:v1';

/** How long a change waits before it is written (pagehide and hiding flush it). */
export const DRAFTS_WRITE_DEBOUNCE_MS = 250;

/** The slice of Web Storage draft persistence uses (localStorage, or a test fake). */
export interface DraftStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/** Whose drafts are persisted: one user, one workspace. */
interface DraftScope {
  userId: string;
  workspaceId: string;
}

/** A draft as stored: everything but the picked files. */
type PersistedDraft = Omit<ChannelDraft, 'pendingFiles'>;

/** The stored blob: one user, a slot per workspace, a draft per channel. */
interface PersistedDrafts {
  userId: string;
  byWorkspace: Record<string, Record<string, PersistedDraft>>;
}

const drafts = new Map<string, ChannelDraft>();
// The workspace each in-memory draft belongs to (null: set with no scope).
const owners = new Map<string, string | null>();
const listeners = new Set<() => void>();
let version = 0;
let scope: DraftScope | null = null;
// The last user a scope was set for; survives setDraftScope(null) so the next
// user is compared with it (only clearAllDrafts and resetDrafts forget it).
let lastUserId: string | null = null;
// undefined: window.localStorage (looked up at call time).
let storageOverride: DraftStorage | null | undefined;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let flushListening = false;

function browserStorage(): DraftStorage | null {
  if (storageOverride !== undefined) return storageOverride;
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Test-only: the storage drafts persist to; undefined restores localStorage. */
export function setDraftStorage(storage: DraftStorage | null | undefined): void {
  storageOverride = storage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseReply(value: unknown): DraftReply | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.authorName !== 'string') return undefined;
  const quote = value.quote;
  if (!isRecord(quote) || typeof quote.id !== 'string' || typeof quote.preview !== 'string') {
    return undefined;
  }
  if (quote.authorUserId !== null && typeof quote.authorUserId !== 'string') return undefined;
  if (quote.rootId !== undefined && typeof quote.rootId !== 'string') return undefined;
  return {
    authorName: value.authorName,
    quote: {
      id: quote.id,
      authorUserId: quote.authorUserId,
      preview: quote.preview,
      ...(quote.rootId !== undefined ? { rootId: quote.rootId } : {}),
    },
    ...(value.deleted === true ? { deleted: true as const } : {}),
  };
}

/** One stored draft back to a ChannelDraft (no files); null when malformed. */
function parseDraft(value: unknown): ChannelDraft | null {
  if (!isRecord(value)) return null;
  const { text, caret, sharedPosts, sharedBriefs } = value;
  if (typeof text !== 'string' || typeof caret !== 'number' || !Number.isFinite(caret)) {
    return null;
  }
  if (!Array.isArray(sharedPosts) || !sharedPosts.every(isRecord)) return null;
  if (!Array.isArray(sharedBriefs) || !sharedBriefs.every(isRecord)) return null;
  const reply = parseReply(value.reply);
  if (reply === undefined) return null;
  const draft: ChannelDraft = {
    text,
    caret,
    reply,
    sharedPosts: sharedPosts as unknown as PostCardFields[],
    sharedBriefs: sharedBriefs as unknown as BriefCardFields[],
    pendingFiles: [],
  };
  return isEmptyDraft(draft) ? null : draft;
}

/** The stored blob; null when absent, unreadable or malformed. Never throws. */
function readBlob(storage: DraftStorage): PersistedDrafts | null {
  try {
    const raw = storage.getItem(DRAFTS_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.userId !== 'string') return null;
    const byWorkspace: PersistedDrafts['byWorkspace'] = {};
    if (isRecord(parsed.byWorkspace)) {
      for (const [workspaceId, slot] of Object.entries(parsed.byWorkspace)) {
        if (isRecord(slot)) byWorkspace[workspaceId] = slot as Record<string, PersistedDraft>;
      }
    }
    return { userId: parsed.userId, byWorkspace };
  } catch {
    return null;
  }
}

/** Write the blob; no slots removes the key. Never throws. */
function writeBlob(storage: DraftStorage, blob: PersistedDrafts): void {
  try {
    if (Object.keys(blob.byWorkspace).length === 0) storage.removeItem(DRAFTS_STORAGE_KEY);
    else storage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(blob));
  } catch {
    // Storage full or blocked: the drafts carry on from memory.
  }
}

function removeBlob(storage: DraftStorage | null): void {
  if (storage === null) return;
  try {
    storage.removeItem(DRAFTS_STORAGE_KEY);
  } catch {
    // Blocked storage has nothing to remove.
  }
}

function toPersisted(draft: ChannelDraft): PersistedDraft | null {
  const { text, caret, reply, sharedPosts, sharedBriefs } = draft;
  const kept: PersistedDraft = { text, caret, reply, sharedPosts, sharedBriefs };
  // A draft holding only picked files persists as absent.
  return isEmptyDraft({ ...kept, pendingFiles: [] }) ? null : kept;
}

function cancelWrite(): void {
  if (writeTimer === null) return;
  clearTimeout(writeTimer);
  writeTimer = null;
}

/**
 * Write the current scope's slot from memory now (read-modify-write: other
 * workspaces' slots stay; another user's blob is replaced). No scope: nothing.
 */
function flushDrafts(): void {
  cancelWrite();
  const current = scope;
  const storage = browserStorage();
  if (current === null || storage === null) return;
  const slot: Record<string, PersistedDraft> = {};
  for (const [channelId, draft] of drafts) {
    if (owners.get(channelId) !== current.workspaceId) continue;
    const kept = toPersisted(draft);
    if (kept !== null) slot[channelId] = kept;
  }
  const stored = readBlob(storage);
  const blob: PersistedDrafts =
    stored !== null && stored.userId === current.userId
      ? stored
      : { userId: current.userId, byWorkspace: {} };
  if (Object.keys(slot).length > 0) blob.byWorkspace[current.workspaceId] = slot;
  else delete blob.byWorkspace[current.workspaceId];
  writeBlob(storage, blob);
}

function onPageHide(): void {
  if (writeTimer !== null) flushDrafts();
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden' && writeTimer !== null) flushDrafts();
}

function listenForFlush(on: boolean): void {
  if (on === flushListening) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  flushListening = on;
  if (on) {
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
  } else {
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }
}

function scheduleWrite(): void {
  if (scope === null) return;
  cancelWrite();
  writeTimer = setTimeout(flushDrafts, DRAFTS_WRITE_DEBOUNCE_MS);
}

/**
 * Whose drafts persist: on a scope, another user's stored blob is removed;
 * otherwise this workspace's stored drafts are hydrated for the channels the
 * map does not already hold (an in-memory draft always wins). A user other
 * than the last one scoped (a null scope in between included) forgets the
 * previous user's in-memory drafts first. null (teardown) writes what is
 * pending first, then keeps drafts in memory only.
 */
export function setDraftScope(next: DraftScope | null): void {
  if (writeTimer !== null) flushDrafts();
  scope = next;
  listenForFlush(next !== null);
  if (next === null) return;
  // Another user in this tab (any sign-out, even one that never fired the
  // sign-out event): the previous user's in-memory drafts go before hydrating.
  if (lastUserId !== null && lastUserId !== next.userId) {
    drafts.clear();
    owners.clear();
  }
  lastUserId = next.userId;
  const storage = browserStorage();
  const stored = storage !== null ? readBlob(storage) : null;
  if (stored !== null && stored.userId !== next.userId) {
    removeBlob(storage);
  } else if (stored !== null) {
    const slot = stored.byWorkspace[next.workspaceId] ?? {};
    for (const [channelId, value] of Object.entries(slot)) {
      if (drafts.has(channelId)) continue;
      const draft = parseDraft(value);
      if (draft === null) continue;
      drafts.set(channelId, draft);
      owners.set(channelId, next.workspaceId);
    }
  }
  bump();
}

/** Whether a draft carries nothing worth keeping. */
export function isEmptyDraft(draft: ChannelDraft): boolean {
  return (
    draft.text === '' &&
    draft.reply === null &&
    draft.sharedPosts.length === 0 &&
    draft.sharedBriefs.length === 0 &&
    draft.pendingFiles.length === 0
  );
}

function sameDraft(a: ChannelDraft, b: ChannelDraft): boolean {
  return (
    a.text === b.text &&
    a.caret === b.caret &&
    a.reply === b.reply &&
    a.sharedPosts === b.sharedPosts &&
    a.sharedBriefs === b.sharedBriefs &&
    a.pendingFiles === b.pendingFiles
  );
}

function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** The draft of one channel; EMPTY_DRAFT when it has none. */
export function getDraft(channelId: string): ChannelDraft {
  return drafts.get(channelId) ?? EMPTY_DRAFT;
}

/** Merge fields into one channel's draft; an empty result drops the entry. */
export function setDraft(channelId: string, patch: Partial<ChannelDraft>): void {
  const prev = getDraft(channelId);
  const next: ChannelDraft = { ...prev, ...patch };
  if (sameDraft(prev, next)) return;
  if (isEmptyDraft(next)) {
    if (!drafts.has(channelId)) return;
    drafts.delete(channelId);
    owners.delete(channelId);
  } else {
    drafts.set(channelId, next);
    if (!owners.has(channelId) || owners.get(channelId) === null) {
      owners.set(channelId, scope?.workspaceId ?? null);
    }
  }
  scheduleWrite();
  bump();
}

/** Drop one channel's draft (a successful send). */
export function clearDraft(channelId: string): void {
  if (!drafts.delete(channelId)) return;
  owners.delete(channelId);
  scheduleWrite();
  bump();
}

/**
 * Messages became tombstones: every draft reply (any chat) that quotes one
 * loses the quoted text and is marked deleted. One bump when anything changed.
 */
export function stripDeletedReplies(messageIds: readonly string[]): void {
  if (messageIds.length === 0) return;
  const hit = new Set(messageIds);
  let changed = false;
  for (const [channelId, draft] of drafts) {
    const reply = draft.reply;
    if (reply === null || !hit.has(reply.quote.id)) continue;
    const next = strippedReply(reply);
    if (next === reply) continue;
    drafts.set(channelId, { ...draft, reply: next });
    changed = true;
  }
  if (!changed) return;
  scheduleWrite();
  bump();
}

/** Sign-out: every draft goes, from memory and storage; listeners hear it. */
export function clearAllDrafts(): void {
  drafts.clear();
  owners.clear();
  lastUserId = null;
  cancelWrite();
  removeBlob(browserStorage());
  bump();
}

/**
 * Drop one workspace's drafts (memory and storage) for chats not in
 * `keepChannelIds`: the user no longer has them. The notes chat is never
 * dropped (it is never in the roster). Other workspaces are untouched.
 */
export function pruneDrafts(workspaceId: string, keepChannelIds: ReadonlySet<string>): void {
  const dropped = (channelId: string): boolean =>
    !keepChannelIds.has(channelId) && !isNotesChannelId(channelId);
  let changed = false;
  for (const channelId of [...drafts.keys()]) {
    if (owners.get(channelId) !== workspaceId || !dropped(channelId)) continue;
    drafts.delete(channelId);
    owners.delete(channelId);
    changed = true;
  }
  const storage = browserStorage();
  const stored = storage !== null ? readBlob(storage) : null;
  const slot = stored?.byWorkspace[workspaceId];
  if (storage !== null && stored !== null && slot !== undefined) {
    const kept = Object.fromEntries(Object.entries(slot).filter(([id]) => !dropped(id)));
    if (Object.keys(kept).length !== Object.keys(slot).length) {
      if (Object.keys(kept).length > 0) stored.byWorkspace[workspaceId] = kept;
      else delete stored.byWorkspace[workspaceId];
      writeBlob(storage, stored);
    }
  }
  if (changed) bump();
}

/** The draft text a chat list row previews; '' when none. */
export function draftText(channelId: string): string {
  return getDraft(channelId).text.trim() === '' ? '' : getDraft(channelId).text;
}

/** Bumped on every change; the chat list's external-store snapshot. */
export function draftsVersion(): number {
  return version;
}

/** Listen for draft changes; returns the unsubscribe. */
export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: forget every draft and the scope (storage is left as it is). */
export function resetDrafts(): void {
  drafts.clear();
  owners.clear();
  cancelWrite();
  scope = null;
  lastUserId = null;
  listenForFlush(false);
  bump();
}
