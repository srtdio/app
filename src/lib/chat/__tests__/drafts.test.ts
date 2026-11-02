import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllDrafts,
  clearDraft,
  draftText,
  draftsVersion,
  DRAFTS_STORAGE_KEY,
  DRAFTS_WRITE_DEBOUNCE_MS,
  EMPTY_DRAFT,
  getDraft,
  isEmptyDraft,
  pruneDrafts,
  resetDrafts,
  setDraft,
  setDraftScope,
  setDraftStorage,
  setPrivateReplyDraft,
  type DraftStorage,
  stripDeletedReplies,
  subscribeDrafts,
} from '@/lib/chat/drafts';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

const A = 'chan-a';
const B = 'chan-b';

afterEach(() => resetDrafts());

describe('per-chat drafts', () => {
  it('set / get / clear per channel', () => {
    expect(getDraft(A)).toBe(EMPTY_DRAFT);
    setDraft(A, { text: 'hello', caret: 5 });
    expect(getDraft(A)).toMatchObject({ text: 'hello', caret: 5, reply: null });
    setDraft(A, { caret: 2 });
    expect(getDraft(A)).toMatchObject({ text: 'hello', caret: 2 });
    clearDraft(A);
    expect(getDraft(A)).toBe(EMPTY_DRAFT);
  });

  it("channel A's text is never returned for channel B", () => {
    setDraft(A, { text: 'for A only' });
    expect(getDraft(B).text).toBe('');
    expect(draftText(B)).toBe('');
    setDraft(B, { text: 'for B' });
    expect(getDraft(A).text).toBe('for A only');
    expect(getDraft(B).text).toBe('for B');
    clearDraft(B);
    expect(getDraft(A).text).toBe('for A only');
  });

  it('keeps the reply, cards and files with their own chat', () => {
    const quote = { id: 'm1', authorUserId: 'u', preview: 'hi' };
    setDraft(A, { reply: { authorName: 'Ana', quote } });
    expect(getDraft(A).reply?.quote.id).toBe('m1');
    expect(getDraft(B).reply).toBeNull();
    // A reply alone is still a draft; the list preview reads text only.
    expect(isEmptyDraft(getDraft(A))).toBe(false);
    expect(draftText(A)).toBe('');
  });

  it('an emptied draft drops its entry', () => {
    setDraft(A, { text: 'x' });
    setDraft(A, { text: '' });
    expect(getDraft(A)).toBe(EMPTY_DRAFT);
  });

  it('notifies listeners on a change, not on a no-op', () => {
    const listener = vi.fn();
    const off = subscribeDrafts(listener);
    const v0 = draftsVersion();
    setDraft(A, { text: 'x' });
    expect(listener).toHaveBeenCalledTimes(1);
    setDraft(A, { text: 'x' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(draftsVersion()).toBe(v0 + 1);
    off();
    setDraft(A, { text: 'y' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('edit restore', () => {
  it("leaving an edit restores the same chat's draft, never another chat's", async () => {
    const { editRestoreText } = await import('@/components/chat/Composer');
    setDraft(A, { text: 'draft in A' });
    setDraft(B, { text: 'draft in B' });
    expect(editRestoreText(A, 'saved')).toBe('draft in A');
    expect(editRestoreText(B, 'saved')).toBe('draft in B');
    clearDraft(A);
    // No draft in the map: the session's own saved text, still never B's.
    expect(editRestoreText(A, 'saved')).toBe('saved');
    expect(editRestoreText(A, undefined)).toBe('');
  });
});

describe('D1: a deleted message leaves no text in draft replies', () => {
  it('strips the quote text from every draft (any chat) that quotes it and marks it deleted', () => {
    setDraft(A, {
      text: 'my reply',
      reply: { authorName: 'Asha', quote: { id: 'm1', authorUserId: 'p', preview: 'secret' } },
    });
    setDraft(B, {
      reply: { authorName: 'Ravi', quote: { id: 'm2', authorUserId: 'p', preview: 'fine' } },
    });
    const before = draftsVersion();
    stripDeletedReplies(['m1']);
    expect(getDraft(A).reply).toEqual({
      authorName: 'Asha',
      quote: { id: 'm1', authorUserId: 'p', preview: '' },
      deleted: true,
    });
    expect(getDraft(A).text).toBe('my reply');
    expect(getDraft(B).reply?.quote.preview).toBe('fine');
    expect(draftsVersion()).toBe(before + 1);
    // Idempotent: nothing left to strip, no bump.
    stripDeletedReplies(['m1']);
    expect(draftsVersion()).toBe(before + 1);
  });
});

function memoryStorage(initial: Record<string, string> = {}): DraftStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function stored(storage: { data: Map<string, string> }): {
  userId: string;
  byWorkspace: Record<string, Record<string, { text: string }>>;
} | null {
  const raw = storage.data.get(DRAFTS_STORAGE_KEY);
  return raw === undefined ? null : JSON.parse(raw);
}

const U1 = { userId: 'u1', workspaceId: 'ws-a' };
const REPLY = { authorName: 'Asha', quote: { id: 'm1', authorUserId: 'p', preview: 'hi' } };
const POST = { id: 'post-1', title: 'Launch' } as never;
const BRIEF = { id: 'brief-1', title: 'Q3' } as never;
const FILE = { id: 'f1', file: {} as File, previewUrl: 'blob:x' };

describe('persisted drafts (per user + workspace)', () => {
  afterEach(() => {
    resetDrafts();
    setDraftStorage(undefined);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a draft (text, reply, cards) survives a reload; picked files do not', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    setDraftStorage(storage);
    setDraftScope(U1);
    setDraft(A, {
      text: 'half typed',
      caret: 4,
      reply: REPLY,
      sharedPosts: [POST],
      sharedBriefs: [BRIEF],
      pendingFiles: [FILE],
    });
    expect(stored(storage)).toBeNull();
    vi.advanceTimersByTime(DRAFTS_WRITE_DEBOUNCE_MS);
    expect(stored(storage)?.byWorkspace['ws-a']?.[A]).not.toHaveProperty('pendingFiles');

    vi.resetModules();
    const fresh = await import('@/lib/chat/drafts');
    fresh.setDraftStorage(storage);
    expect(fresh.getDraft(A)).toBe(fresh.EMPTY_DRAFT);
    const before = fresh.draftsVersion();
    fresh.setDraftScope(U1);
    expect(fresh.draftsVersion()).toBeGreaterThan(before);
    expect(fresh.getDraft(A)).toEqual({
      text: 'half typed',
      caret: 4,
      reply: REPLY,
      sharedPosts: [POST],
      sharedBriefs: [BRIEF],
      pendingFiles: [],
      privateReply: null,
    });
    expect(fresh.draftText(A)).toBe('half typed');
    fresh.resetDrafts();
  });

  it('a draft holding only picked files persists as absent; no slot left removes the key', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    setDraftStorage(storage);
    setDraftScope(U1);
    setDraft(A, { pendingFiles: [FILE] });
    vi.advanceTimersByTime(DRAFTS_WRITE_DEBOUNCE_MS);
    expect(storage.data.has(DRAFTS_STORAGE_KEY)).toBe(false);
    setDraft(A, { text: 'x' });
    vi.advanceTimersByTime(DRAFTS_WRITE_DEBOUNCE_MS);
    expect(storage.data.has(DRAFTS_STORAGE_KEY)).toBe(true);
    clearDraft(A);
    vi.advanceTimersByTime(DRAFTS_WRITE_DEBOUNCE_MS);
    expect(storage.data.has(DRAFTS_STORAGE_KEY)).toBe(false);
  });

  it('hydrate never overwrites an in-memory draft', () => {
    const storage = memoryStorage({
      [DRAFTS_STORAGE_KEY]: JSON.stringify({
        userId: 'u1',
        byWorkspace: {
          'ws-a': {
            [A]: { text: 'old', caret: 3, reply: null, sharedPosts: [], sharedBriefs: [] },
            [B]: { text: 'from B', caret: 0, reply: null, sharedPosts: [], sharedBriefs: [] },
          },
        },
      }),
    });
    setDraftStorage(storage);
    setDraft(A, { text: 'typed now', caret: 9 });
    setDraftScope(U1);
    expect(getDraft(A).text).toBe('typed now');
    expect(getDraft(B).text).toBe('from B');
  });

  it("workspace B never shows A's drafts; writing in B leaves A's slot intact", () => {
    const storage = memoryStorage();
    setDraftStorage(storage);
    setDraftScope(U1);
    setDraft(A, { text: 'in A' });
    setDraftScope(null);
    resetDrafts();
    setDraftScope({ userId: 'u1', workspaceId: 'ws-b' });
    expect(getDraft(A)).toBe(EMPTY_DRAFT);
    setDraft(B, { text: 'in B' });
    setDraftScope(null);
    const blob = stored(storage);
    expect(blob?.byWorkspace['ws-a']?.[A]?.text).toBe('in A');
    expect(blob?.byWorkspace['ws-b']?.[B]?.text).toBe('in B');
    expect(blob?.byWorkspace['ws-b']?.[A]).toBeUndefined();
  });

  it("another user's blob is removed on setDraftScope", () => {
    const storage = memoryStorage({
      [DRAFTS_STORAGE_KEY]: JSON.stringify({
        userId: 'someone-else',
        byWorkspace: {
          'ws-a': {
            [A]: { text: 'theirs', caret: 0, reply: null, sharedPosts: [], sharedBriefs: [] },
          },
        },
      }),
    });
    setDraftStorage(storage);
    setDraftScope(U1);
    expect(storage.data.has(DRAFTS_STORAGE_KEY)).toBe(false);
    expect(getDraft(A)).toBe(EMPTY_DRAFT);
  });

  it('clearAllDrafts empties memory and storage and notifies listeners', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    setDraftStorage(storage);
    setDraftScope(U1);
    setDraft(A, { text: 'a' });
    vi.advanceTimersByTime(DRAFTS_WRITE_DEBOUNCE_MS);
    setDraft(B, { text: 'b pending' });
    const listener = vi.fn();
    const off = subscribeDrafts(listener);
    clearAllDrafts();
    off();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getDraft(A)).toBe(EMPTY_DRAFT);
    expect(getDraft(B)).toBe(EMPTY_DRAFT);
    expect(storage.data.has(DRAFTS_STORAGE_KEY)).toBe(false);
    // The pending write was cancelled: nothing comes back.
    vi.advanceTimersByTime(DRAFTS_WRITE_DEBOUNCE_MS);
    expect(storage.data.has(DRAFTS_STORAGE_KEY)).toBe(false);
  });

  it('pruneDrafts drops non-roster chats, keeps roster and notes chats, other workspaces untouched', () => {
    const NOTES = 'notes__u1';
    const storage = memoryStorage({
      [DRAFTS_STORAGE_KEY]: JSON.stringify({
        userId: 'u1',
        byWorkspace: {
          'ws-b': {
            other: { text: 'b', caret: 0, reply: null, sharedPosts: [], sharedBriefs: [] },
          },
        },
      }),
    });
    setDraftStorage(storage);
    setDraftScope(U1);
    setDraft(A, { text: 'keep' });
    setDraft(B, { text: 'gone' });
    setDraft(NOTES, { text: 'note to self' });
    setDraftScope(null);
    setDraftScope(U1);
    const before = draftsVersion();
    pruneDrafts('ws-a', new Set([A]));
    expect(draftsVersion()).toBe(before + 1);
    expect(getDraft(A).text).toBe('keep');
    expect(getDraft(B)).toBe(EMPTY_DRAFT);
    expect(getDraft(NOTES).text).toBe('note to self');
    const blob = stored(storage);
    expect(Object.keys(blob?.byWorkspace['ws-a'] ?? {}).sort()).toEqual([A, NOTES].sort());
    expect(blob?.byWorkspace['ws-b']?.['other']?.text).toBe('b');
  });

  it('the debounced write flushes on pagehide', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    const storage = memoryStorage();
    setDraftStorage(storage);
    setDraftScope(U1);
    setDraft(A, { text: 'leaving' });
    expect(storage.data.has(DRAFTS_STORAGE_KEY)).toBe(false);
    window.dispatchEvent(new Event('pagehide'));
    expect(stored(storage)?.byWorkspace['ws-a']?.[A]?.text).toBe('leaving');
  });

  it('the debounced write flushes when the tab hides', () => {
    vi.useFakeTimers();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', doc);
    const storage = memoryStorage();
    setDraftStorage(storage);
    setDraftScope(U1);
    setDraft(A, { text: 'hiding' });
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(stored(storage)?.byWorkspace['ws-a']?.[A]?.text).toBe('hiding');
  });

  it('without a scope drafts stay in memory only', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    setDraftStorage(storage);
    setDraft(A, { text: 'memory' });
    vi.advanceTimersByTime(DRAFTS_WRITE_DEBOUNCE_MS);
    expect(storage.data.size).toBe(0);
    expect(getDraft(A).text).toBe('memory');
  });

  it('malformed or throwing storage reads as empty and never throws', () => {
    for (const raw of [
      'not json',
      '[]',
      '{"userId":"u1","byWorkspace":{"ws-a":{"x":{"text":5}}}}',
    ]) {
      setDraftStorage(memoryStorage({ [DRAFTS_STORAGE_KEY]: raw }));
      expect(() => setDraftScope(U1)).not.toThrow();
      expect(getDraft('x')).toBe(EMPTY_DRAFT);
      resetDrafts();
    }
    const throwing: DraftStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    setDraftStorage(throwing);
    expect(() => {
      setDraftScope(U1);
      setDraft(A, { text: 'still works' });
      setDraftScope(null);
      pruneDrafts('ws-a', new Set());
      clearAllDrafts();
    }).not.toThrow();
  });
});

describe('a new user never inherits in-memory drafts', () => {
  afterEach(() => {
    resetDrafts();
    setDraftStorage(undefined);
  });

  it("user B after a null scope (no sign-out event) sees and stores nothing of A's", () => {
    const storage = memoryStorage();
    setDraftStorage(storage);
    setDraftScope(U1);
    setDraft(A, { text: "A's secret", reply: REPLY });
    setDraftScope(null);
    setDraftScope({ userId: 'u2', workspaceId: 'ws-a' });
    expect(getDraft(A)).toBe(EMPTY_DRAFT);
    expect(draftText(A)).toBe('');
    expect(storage.data.has(DRAFTS_STORAGE_KEY)).toBe(false);
    setDraft(B, { text: "B's" });
    setDraftScope(null);
    const blob = stored(storage);
    expect(blob?.userId).toBe('u2');
    expect(Object.keys(blob?.byWorkspace['ws-a'] ?? {})).toEqual([B]);
  });

  it('the same user after a null scope keeps the in-memory drafts', () => {
    setDraftStorage(memoryStorage());
    setDraftScope(U1);
    setDraft(A, { text: 'mine', pendingFiles: [FILE] });
    setDraftScope(null);
    setDraftScope(U1);
    expect(getDraft(A).text).toBe('mine');
    expect(getDraft(A).pendingFiles).toEqual([FILE]);
  });

  it('clearAllDrafts then a new user: nothing carried', () => {
    const storage = memoryStorage();
    setDraftStorage(storage);
    setDraftScope(U1);
    setDraft(A, { text: 'gone' });
    clearAllDrafts();
    setDraftScope(null);
    setDraftScope({ userId: 'u2', workspaceId: 'ws-a' });
    expect(getDraft(A)).toBe(EMPTY_DRAFT);
    expect(storage.data.has(DRAFTS_STORAGE_KEY)).toBe(false);
  });
});

const PRIVATE_REPLY = {
  kind: 'chat' as const,
  sourceId: 'msg-9',
  authorUserId: 'user-asha',
  authorName: 'Asha Rao',
  excerpt: 'Can you send the deck?',
  whereLabel: 'Launch team',
  link: { kind: 'chat' as const, channelId: 'grp-1', messageId: 'msg-9' },
};

describe('Reply privately quote on a draft', () => {
  afterEach(() => {
    resetDrafts();
    setDraftStorage(undefined);
    vi.useRealTimers();
  });

  it('setPrivateReplyDraft attaches the quote; the draft is not empty; null removes it', () => {
    setPrivateReplyDraft(A, PRIVATE_REPLY);
    expect(getDraft(A).privateReply).toEqual(PRIVATE_REPLY);
    expect(isEmptyDraft(getDraft(A))).toBe(false);
    setDraft(A, { text: 'hi' });
    expect(getDraft(A).privateReply).toEqual(PRIVATE_REPLY);
    setPrivateReplyDraft(A, null);
    expect(getDraft(A).privateReply).toBeNull();
    expect(getDraft(A).text).toBe('hi');
    setDraft(A, { text: '' });
    expect(getDraft(A)).toBe(EMPTY_DRAFT);
  });

  it('clearDraft (a send) drops the quote', () => {
    setPrivateReplyDraft(A, PRIVATE_REPLY);
    clearDraft(A);
    expect(getDraft(A).privateReply).toBeNull();
  });

  it('the quote survives a reload; a malformed stored quote reads as none', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    setDraftStorage(storage);
    setDraftScope(U1);
    setPrivateReplyDraft(A, PRIVATE_REPLY);
    setDraft(B, { text: 'x' });
    vi.advanceTimersByTime(DRAFTS_WRITE_DEBOUNCE_MS);
    // Corrupt B's quote in storage.
    const blob = JSON.parse(storage.data.get(DRAFTS_STORAGE_KEY) ?? '{}');
    blob.byWorkspace['ws-a'][B].privateReply = { kind: 'chat', sourceId: 7 };
    storage.data.set(DRAFTS_STORAGE_KEY, JSON.stringify(blob));

    vi.resetModules();
    const fresh = await import('@/lib/chat/drafts');
    fresh.setDraftStorage(storage);
    fresh.setDraftScope(U1);
    expect(fresh.getDraft(A).privateReply).toEqual(PRIVATE_REPLY);
    expect(fresh.getDraft(B).privateReply).toBeNull();
    expect(fresh.getDraft(B).text).toBe('x');
    fresh.resetDrafts();
  });
});
