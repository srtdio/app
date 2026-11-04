// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The chat home media chips' results: tiles paint from the device cache, then
// the network page lands on the same DOM (no remount), under month headers.

const { markSpy } = vi.hoisted(() => ({ markSpy: vi.fn() }));

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));
// No asset-read Worker: tiles show their glyphs, nothing presigns.
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/lib/perf-marks', () => ({ mark: markSpy }));

import { MediaResults, type MediaResultsProps } from '@/components/chat/MediaResults';
import type { MediaItem } from '@/lib/chat/media-items';
import {
  IDLE_SEARCH,
  type SearchHit,
  type SearchRunner,
  type SearchState,
} from '@/lib/chat/search';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-11-04T12:00:00Z');
const UTC = 'UTC';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  markSpy.mockReset();
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
      }),
    });
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function runner(): SearchRunner & { loadMore: ReturnType<typeof vi.fn> } {
  return {
    setQuery: vi.fn(),
    loadMore: vi.fn(async () => undefined),
    retry: vi.fn(),
    getState: () => IDLE_SEARCH,
    dispose: vi.fn(),
  };
}

function media(messageId: string, versionId: string, over: Partial<MediaItem> = {}): MediaItem {
  return {
    key: `${messageId}:${versionId}`,
    messageId,
    channelId: 'c1',
    senderId: 'u1',
    createdAt: '2026-11-03T10:00:00Z',
    versionId,
    mime: 'image/jpeg',
    name: `${versionId}.jpg`,
    size: 10,
    width: null,
    height: null,
    thumbW: null,
    thumbH: null,
    durationMs: null,
    pageCount: null,
    ...over,
  };
}

function photoHit(id: string, versionIds: string[], createdAt = '2026-11-03T10:00:00Z'): SearchHit {
  return {
    id,
    channelId: 'c1',
    senderUserId: 'u1',
    body: '',
    createdAt,
    attachmentAssetIds: versionIds,
    attachmentMeta: Object.fromEntries(
      versionIds.map((v) => [v, { mime: 'image/jpeg', name: `${v}.jpg`, size: 10 }]),
    ),
  };
}

function ready(kind: SearchState['kind'], hits: SearchHit[], hasMore = false): SearchState {
  return { ...IDLE_SEARCH, query: '', kind, status: 'ready', hits, hasMore };
}

function props(over: Partial<MediaResultsProps>): MediaResultsProps {
  return {
    kind: 'photo',
    query: '',
    state: { ...IDLE_SEARCH, kind: 'photo', status: 'loading' },
    runner: runner(),
    cached: undefined,
    channelsById: new Map(),
    currentUserId: 'me',
    nameOf: () => undefined,
    nowMs: NOW,
    timeZone: UTC,
    onClear: vi.fn(),
    onShowInChat: vi.fn(),
    ...over,
  };
}

function render(p: MediaResultsProps): void {
  act(() => root?.render(<MediaResults {...p} />));
}

const tile = (key: string): Element | null => document.querySelector(`[data-media-tile="${key}"]`);

describe('MediaResults', () => {
  it('paints tiles from the cache, then the network page on the same nodes', () => {
    const r = runner();
    const cached = { kind: 'photo' as const, items: [media('m1', 'a'), media('m1', 'b')] };
    render(props({ runner: r, cached }));
    const rootEl = document.querySelector('[data-media-results="photo"]');
    const first = tile('m1:a');
    expect(first).not.toBeNull();
    expect(tile('m1:b')).not.toBeNull();
    expect(document.querySelector('[data-media-skeleton]')).toBeNull();
    expect(markSpy).toHaveBeenCalledWith('chat:chip:painted');
    expect(markSpy).not.toHaveBeenCalledWith('chat:chip:ready');

    render(props({ runner: r, cached, state: ready('photo', [photoHit('m1', ['a', 'b', 'c'])]) }));
    expect(document.querySelector('[data-media-results="photo"]')).toBe(rootEl);
    expect(tile('m1:a')).toBe(first);
    expect(tile('m1:c')).not.toBeNull();
    expect(markSpy).toHaveBeenCalledWith('chat:chip:ready');
    expect(markSpy.mock.calls.filter(([n]) => n === 'chat:chip:painted')).toHaveLength(1);
  });

  it('shows loading boxes only when the device holds nothing', () => {
    render(props({}));
    expect(document.querySelector('[data-media-skeleton]')).not.toBeNull();
    expect(document.querySelector('[data-media-tile]')).toBeNull();
  });

  it('turns a 3-photo message into 3 tiles', () => {
    render(props({ state: ready('photo', [photoHit('m1', ['a', 'b', 'c'])]) }));
    expect(document.querySelectorAll('[data-media-tile]')).toHaveLength(3);
  });

  it('groups items under month headers', () => {
    const items = [
      media('m1', 'a', { createdAt: '2026-11-03T10:00:00Z' }),
      media('m2', 'b', { createdAt: '2026-10-12T10:00:00Z' }),
      media('m3', 'c', { createdAt: '2025-09-01T10:00:00Z' }),
    ];
    render(props({ cached: { kind: 'photo', items } }));
    const headers = [...document.querySelectorAll('[data-media-month]')];
    expect(headers.map((h) => h.getAttribute('data-media-month'))).toEqual([
      'week',
      '2026-10',
      '2025-09',
    ]);
    expect(headers.map((h) => h.textContent)).toEqual(['This week', 'October', 'September 2025']);
  });

  it('labels a video tile with its length, and none without one', () => {
    const items = [
      media('m1', 'v1', { mime: 'video/mp4', name: 'v1.mp4', durationMs: 12_000 }),
      media('m2', 'v2', { mime: 'video/mp4', name: 'v2.mp4' }),
    ];
    render(
      props({
        kind: 'video',
        state: { ...IDLE_SEARCH, kind: 'video', status: 'loading' },
        cached: { kind: 'video', items },
      }),
    );
    expect(document.querySelector('[data-media-results="video"]')).not.toBeNull();
    expect(tile('m1:v1')?.querySelector('[data-media-duration]')?.textContent).toBe('0:12');
    expect(tile('m2:v2')?.querySelector('[data-media-duration]')).toBeNull();
  });

  it('reads the next page once when a page flattens to too few tiles', () => {
    const r = runner();
    const state = ready('photo', [photoHit('m1', ['a'])], true);
    render(props({ runner: r, state }));
    expect(r.loadMore).toHaveBeenCalledTimes(1);
    render(props({ runner: r, state: { ...state } }));
    expect(r.loadMore).toHaveBeenCalledTimes(1);
  });

  it('shows NoResults with the chip on when nothing matches', () => {
    render(props({ state: ready('photo', []) }));
    expect(document.querySelector('[data-search-empty]')).not.toBeNull();
    expect(document.querySelector('[data-media-tile]')).toBeNull();
  });
});
