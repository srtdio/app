import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { deleteChoices, selectionDeleteChoices } from '@/lib/chat/delete-flow';
import { DELETE_SELECTION_WINDOW_MS } from '@/lib/chat/forward';
import {
  EMPTY_MEDIA_SELECTION,
  keyAfterHide,
  mediaDeleteEveryone,
  mediaSelectionItems,
  toggleMediaSelection,
} from '@/lib/chat/media-select';

const MIN = 60 * 1000;

describe('deleteChoices (the delete sheet rule)', () => {
  const base = { mine: true, ageMs: 5 * MIN, notes: false, failed: false };

  it('own message under 30 min: the sheet with Delete for everyone', () => {
    expect(deleteChoices(base)).toEqual({ kind: 'sheet', everyone: true });
    expect(deleteChoices({ ...base, ageMs: 0 })).toEqual({ kind: 'sheet', everyone: true });
    expect(deleteChoices({ ...base, ageMs: DELETE_SELECTION_WINDOW_MS })).toEqual({
      kind: 'sheet',
      everyone: true,
    });
  });

  it('own message past 30 min: Delete for me only', () => {
    expect(deleteChoices({ ...base, ageMs: DELETE_SELECTION_WINDOW_MS + 1 })).toEqual({
      kind: 'sheet',
      everyone: false,
    });
    expect(deleteChoices({ ...base, ageMs: 2 * 60 * MIN })).toEqual({
      kind: 'sheet',
      everyone: false,
    });
  });

  it('own message with no server time: never for everyone', () => {
    expect(deleteChoices({ ...base, ageMs: null })).toEqual({ kind: 'sheet', everyone: false });
    expect(deleteChoices({ ...base, ageMs: Number.NaN })).toEqual({
      kind: 'sheet',
      everyone: false,
    });
  });

  it("someone else's message: Delete for me only, at any age", () => {
    expect(deleteChoices({ ...base, mine: false })).toEqual({ kind: 'sheet', everyone: false });
    expect(deleteChoices({ ...base, mine: false, ageMs: 0 })).toEqual({
      kind: 'sheet',
      everyone: false,
    });
  });

  it('Personal notes keeps its single Delete', () => {
    expect(deleteChoices({ ...base, notes: true })).toEqual({ kind: 'notes' });
    expect(deleteChoices({ ...base, notes: true, mine: false })).toEqual({ kind: 'notes' });
  });

  it('a failed send is discarded from this device (wins over notes)', () => {
    expect(deleteChoices({ ...base, failed: true })).toEqual({ kind: 'discard' });
    expect(deleteChoices({ ...base, failed: true, notes: true })).toEqual({ kind: 'discard' });
  });
});

describe('selectionDeleteChoices (the selection bar rule)', () => {
  const fresh = { mine: true, ageMs: MIN };

  it('every selected message qualifies: Delete for everyone', () => {
    expect(selectionDeleteChoices([fresh, { mine: true, ageMs: 29 * MIN }])).toEqual({
      everyone: true,
    });
  });

  it("mixed (one of someone else's, or one past 30 min): Delete for me only", () => {
    expect(selectionDeleteChoices([fresh, { mine: false, ageMs: MIN }])).toEqual({
      everyone: false,
    });
    expect(selectionDeleteChoices([fresh, { mine: true, ageMs: 31 * MIN }])).toEqual({
      everyone: false,
    });
    expect(selectionDeleteChoices([fresh, { mine: true, ageMs: null }])).toEqual({
      everyone: false,
    });
  });

  it('nothing selected: never for everyone', () => {
    expect(selectionDeleteChoices([])).toEqual({ everyone: false });
  });
});

describe('media-select (chip view item select)', () => {
  it('toggles a message in and out; a new Map each time', () => {
    const one = toggleMediaSelection(EMPTY_MEDIA_SELECTION, { messageId: 'm1', channelId: 'c1' });
    expect(one).not.toBe(EMPTY_MEDIA_SELECTION);
    expect(EMPTY_MEDIA_SELECTION.size).toBe(0);
    expect([...one]).toEqual([['m1', 'c1']]);
    const two = toggleMediaSelection(one, { messageId: 'm2', channelId: 'c2' });
    expect(two.size).toBe(2);
    expect(one.size).toBe(1);
    const back = toggleMediaSelection(two, { messageId: 'm1', channelId: 'c1' });
    expect([...back]).toEqual([['m2', 'c2']]);
  });

  it('a message carrying several items is one selection', () => {
    let sel = toggleMediaSelection(EMPTY_MEDIA_SELECTION, { messageId: 'm1', channelId: 'c1' });
    // A second tile of the same message toggles the same entry.
    sel = toggleMediaSelection(sel, { messageId: 'm1', channelId: 'c1' });
    expect(sel.size).toBe(0);
  });

  it('turns the selection into Delete for me / Forward items, in selection order', () => {
    let sel = toggleMediaSelection(EMPTY_MEDIA_SELECTION, { messageId: 'b', channelId: 'c1' });
    sel = toggleMediaSelection(sel, { messageId: 'a', channelId: 'c2' });
    expect(mediaSelectionItems(sel)).toEqual([
      { messageId: 'b', channelId: 'c1' },
      { messageId: 'a', channelId: 'c2' },
    ]);
    expect(mediaSelectionItems(EMPTY_MEDIA_SELECTION)).toEqual([]);
  });

  it('keyAfterHide: the next item of another message, else the nearest earlier, else null', () => {
    const items = [
      { key: 'k0', messageId: 'a' },
      { key: 'k1', messageId: 'b' },
      { key: 'k2', messageId: 'b' },
      { key: 'k3', messageId: 'c' },
    ];
    expect(keyAfterHide(items, 1)).toBe('k3');
    expect(keyAfterHide(items, 2)).toBe('k3');
    expect(keyAfterHide(items, 3)).toBe('k2');
    expect(keyAfterHide(items, 0)).toBe('k1');
    expect(keyAfterHide([{ key: 'k0', messageId: 'a' }], 0)).toBeNull();
    expect(
      keyAfterHide(
        [
          { key: 'k0', messageId: 'a' },
          { key: 'k1', messageId: 'a' },
        ],
        1,
      ),
    ).toBeNull();
    expect(keyAfterHide(items, 9)).toBeNull();
  });

  it('mediaDeleteEveryone: own, under 30 min, with a path for it', () => {
    const now = Date.parse('2026-11-07T12:00:00Z');
    const input = {
      senderId: 'me',
      currentUserId: 'me',
      createdAt: '2026-11-07T11:50:00Z',
      nowMs: now,
      notes: false,
      canEveryone: true,
    };
    expect(mediaDeleteEveryone(input)).toBe(true);
    expect(mediaDeleteEveryone({ ...input, canEveryone: false })).toBe(false);
    expect(mediaDeleteEveryone({ ...input, senderId: 'peer' })).toBe(false);
    expect(mediaDeleteEveryone({ ...input, senderId: null })).toBe(false);
    expect(mediaDeleteEveryone({ ...input, createdAt: '2026-11-07T11:00:00Z' })).toBe(false);
    expect(mediaDeleteEveryone({ ...input, createdAt: 'not a date' })).toBe(false);
    expect(mediaDeleteEveryone({ ...input, notes: true })).toBe(false);
  });
});
