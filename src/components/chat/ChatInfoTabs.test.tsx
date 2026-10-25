import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  CONTACT_EMPTY,
  ChatInfoTabsView,
  FeedBody,
  NOTHING_RECENT,
  PREVIEW_COUNT,
  SEE_ALL_LABEL,
  SENDER_READ_TIMEOUT_MS,
  SeeAllRow,
  contactSenderName,
  missingSenderIds,
  previewLimit,
  previewOf,
  readSenderProfiles,
  senderNameResolver,
  type ChatInfoTabsViewProps,
  type ContactTab,
  type Feed,
} from '@/components/chat/ChatInfoTabs';
import { MarksList } from '@/components/chat/MarksSheet';
import { PresignCache } from '@/lib/asset-presign';
import type { ChatProfile } from '@/lib/chat-reads';
import type { Result } from '@srtdio/rpc';
import type { ChannelAttachmentItem, ChannelLinkItem } from '@/lib/chat/channel-media';

type AnyProps = Record<string, unknown> & { children?: ReactNode };

// ChatInfoTabsView, FeedBody and SeeAllRow are hook-free: the walk expands
// them by calling them and reads every other element's props (node env, no DOM).
function findAll(
  node: ReactNode,
  test: (el: ReactElement<AnyProps>) => boolean,
): ReactElement<AnyProps>[] {
  const out: ReactElement<AnyProps>[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement<AnyProps>(n)) return;
    if (test(n)) out.push(n);
    if (n.type === FeedBody) {
      walk((FeedBody as (p: AnyProps) => ReactElement)(n.props));
      return;
    }
    walk(n.props.children);
    for (const key of ['empty'] as const) walk(n.props[key] as ReactNode);
  };
  walk(node);
  return out;
}

const cache = new PresignCache({
  endpoint: null,
  getAccessToken: () => Promise.resolve(null),
  fetcher: () => Promise.reject(new Error('unused')),
});

function item(n: number, over: Partial<ChannelAttachmentItem> = {}): ChannelAttachmentItem {
  return {
    messageId: `m${n}`,
    versionId: `v${n}`,
    name: `a${n}.png`,
    mime: 'image/png',
    size: 10,
    createdAt: '2026-09-22T10:00:00+00:00',
    senderUserId: 'u1',
    ...over,
  };
}

function link(n: number): ChannelLinkItem {
  return {
    messageId: `l${n}`,
    url: `https://example.com/${n}`,
    createdAt: '2026-09-22T10:00:00+00:00',
    senderUserId: 'u1',
  };
}

function feed<T>(items: T[], hasMore = false): Feed<T> {
  return { status: 'ready', items, hasMore, cursor: null, loadingMore: false };
}

function props(over: Partial<ChatInfoTabsViewProps> = {}): ChatInfoTabsViewProps {
  return {
    tab: 'media',
    onTab: vi.fn(),
    attachments: feed<ChannelAttachmentItem>([]),
    links: feed<ChannelLinkItem>([]),
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    cache,
    presignEnabled: false,
    timeZone: 'UTC',
    senderName: () => 'Alice',
    onOpenImage: vi.fn(),
    marks: {
      marks: new Map(),
      messageFor: () => undefined,
      profiles: new Map(),
      currentUserId: 'me',
      timeZone: 'UTC',
      onResolve: vi.fn(),
      onReopen: vi.fn(),
    },
    open: true,
    onJump: vi.fn(),
    mode: 'preview',
    ...over,
  };
}

const view = (p: ChatInfoTabsViewProps): ReactElement => ChatInfoTabsView(p);
const tiles = (tree: ReactElement) =>
  findAll(tree, (el) => 'data-media-grid' in el.props).flatMap((grid) =>
    Array.isArray(grid.props.children) ? (grid.props.children as ReactElement[]) : [],
  );
const listRows = (tree: ReactElement, attr: string) =>
  findAll(tree, (el) => attr in el.props).flatMap((list) =>
    Array.isArray(list.props.children) ? (list.props.children as ReactElement[]) : [],
  );
const seeAll = (tree: ReactElement) => findAll(tree, (el) => el.type === SeeAllRow);
const loadMore = (tree: ReactElement) =>
  findAll(tree, (el) => el.type === Button && 'data-load-more' in el.props);
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

describe('ChatInfoTabsView preview', () => {
  it('9 media items: 6 tiles plus See all, and no Load more', () => {
    const tree = view(
      props({
        attachments: feed(
          range(9).map((n) => item(n)),
          true,
        ),
      }),
    );
    expect(tiles(tree)).toHaveLength(PREVIEW_COUNT.media);
    expect(seeAll(tree)).toHaveLength(1);
    expect(loadMore(tree)).toEqual([]);
  });

  it('6 or fewer media items: no See all', () => {
    for (const count of [0, 1, 6]) {
      const tree = view(props({ attachments: feed(range(count).map((n) => item(n))) }));
      expect(seeAll(tree)).toEqual([]);
      expect(tiles(tree)).toHaveLength(count);
    }
  });

  it('See all switches that tab to the full paged list', () => {
    const onSeeAll = vi.fn();
    const attachments = feed(
      range(9).map((n) => item(n)),
      true,
    );
    const [row] = seeAll(view(props({ attachments, onSeeAll })));
    (row?.props.onClick as () => void)();
    expect(onSeeAll).toHaveBeenCalledWith('media');
    const full = view(props({ attachments, expanded: new Set<ContactTab>(['media']) }));
    expect(tiles(full)).toHaveLength(9);
    expect(seeAll(full)).toEqual([]);
    expect(loadMore(full)).toHaveLength(1);
  });

  it('keeps See-all state per tab', () => {
    const attachments = feed([
      ...range(9).map((n) => item(n)),
      ...range(5).map((n) => item(100 + n, { mime: 'application/pdf', name: `f${n}.pdf` })),
    ]);
    const links = feed(range(5).map(link));
    const expanded = new Set<ContactTab>(['files']);
    const base = { attachments, links, expanded };
    expect(tiles(view(props({ ...base, tab: 'media' })))).toHaveLength(6);
    expect(listRows(view(props({ ...base, tab: 'files' })), 'data-files')).toHaveLength(5);
    expect(listRows(view(props({ ...base, tab: 'links' })), 'data-links')).toHaveLength(3);
    expect(seeAll(view(props({ ...base, tab: 'links' })))).toHaveLength(1);
    expect(previewLimit('preview', 'files', expanded)).toBeNull();
    expect(previewLimit('preview', 'media', expanded)).toBe(6);
    expect(previewLimit('full', 'media', new Set())).toBeNull();
  });

  it('Files and Links show 3 rows then See all', () => {
    const attachments = feed(
      range(4).map((n) => item(n, { mime: 'application/pdf', name: `f${n}.pdf` })),
    );
    const files = view(props({ tab: 'files', attachments }));
    expect(listRows(files, 'data-files')).toHaveLength(3);
    expect(seeAll(files)).toHaveLength(1);
    const links = view(props({ tab: 'links', links: feed(range(3).map(link)) }));
    expect(listRows(links, 'data-links')).toHaveLength(3);
    expect(seeAll(links)).toEqual([]);
  });

  it('Marks passes a 3-row preview with See all until expanded', () => {
    const onSeeAll = vi.fn();
    const [list] = findAll(view(props({ tab: 'marks', onSeeAll })), (el) => el.type === MarksList);
    const preview = list?.props.preview as { rows: number; seeAll: ReactElement };
    expect(preview.rows).toBe(PREVIEW_COUNT.marks);
    expect(preview.seeAll.type).toBe(SeeAllRow);
    (preview.seeAll.props as { onClick: () => void }).onClick();
    expect(onSeeAll).toHaveBeenCalledWith('marks');
    const expanded = view(props({ tab: 'marks', expanded: new Set<ContactTab>(['marks']) }));
    const [full] = findAll(expanded, (el) => el.type === MarksList);
    expect(full?.props.preview).toBeUndefined();
  });

  it('first paint is the same loading state as full mode', () => {
    const tree = view(props({ attachments: null }));
    expect(findAll(tree, (el) => el.props['data-feed'] === 'loading')).toHaveLength(1);
    expect(seeAll(tree)).toEqual([]);
  });

  it('full mode never caps and never shows See all', () => {
    const tree = view(props({ mode: 'full', attachments: feed(range(9).map((n) => item(n))) }));
    expect(tiles(tree)).toHaveLength(9);
    expect(seeAll(tree)).toEqual([]);
    const [list] = findAll(
      view(props({ mode: 'full', tab: 'marks' })),
      (el) => el.type === MarksList,
    );
    expect(list?.props.preview).toBeUndefined();
  });

  it('previewOf offers See all past the cap or when an older page may exist', () => {
    expect(previewOf([1, 2, 3], false, 3)).toEqual({ shown: [1, 2, 3], seeAll: false });
    expect(previewOf([1, 2, 3, 4], false, 3)).toEqual({ shown: [1, 2, 3], seeAll: true });
    expect(previewOf([1], true, 3)).toEqual({ shown: [1], seeAll: true });
    expect(previewOf([1, 2, 3, 4], true, null)).toEqual({ shown: [1, 2, 3, 4], seeAll: false });
  });

  it('empty preview with an older page: "Recent items show up here." then See all, per tab', () => {
    const cases: Array<Partial<ChatInfoTabsViewProps>> = [
      { tab: 'media', attachments: feed<ChannelAttachmentItem>([], true) },
      { tab: 'files', attachments: feed<ChannelAttachmentItem>([], true) },
      { tab: 'links', links: feed<ChannelLinkItem>([], true) },
    ];
    for (const over of cases) {
      const tree = view(props(over));
      const [line] = findAll(tree, (el) => 'data-nothing-recent' in el.props);
      expect(line?.props.children).toBe(NOTHING_RECENT);
      expect(String(line?.props.className)).toContain('text-fg-3');
      expect(seeAll(tree)).toHaveLength(1);
      expect(findAll(tree, (el) => el.type === EmptyState)).toEqual([]);
    }
  });

  it('empty preview with no older page: the empty state and no See all', () => {
    const tree = view(props({ attachments: feed<ChannelAttachmentItem>([], false) }));
    expect(findAll(tree, (el) => el.type === EmptyState)).toHaveLength(1);
    expect(findAll(tree, (el) => 'data-nothing-recent' in el.props)).toEqual([]);
    expect(seeAll(tree)).toEqual([]);
  });

  it('full mode is unchanged when empty with an older page: Load more, no line', () => {
    const tree = view(props({ mode: 'full', attachments: feed<ChannelAttachmentItem>([], true) }));
    expect(findAll(tree, (el) => 'data-nothing-recent' in el.props)).toEqual([]);
    expect(seeAll(tree)).toEqual([]);
    expect(loadMore(tree)).toHaveLength(1);
  });

  it('See all is the 44px full-width secondary button', () => {
    const row = SeeAllRow({ onClick: vi.fn() });
    // The shared Button primitive (44px tall, 8px radius) in its secondary variant.
    expect(row.type).toBe(Button);
    expect(row.props.variant).toBe('secondary');
    const className = String(row.props.className);
    expect(className).not.toContain('min-h-[48px]');
    expect(className).not.toContain('rounded-md');
    expect(className).toContain('w-full');
    expect(row.props.children).toBe(SEE_ALL_LABEL);
  });
});

describe('ChatInfoTabsView voice notes', () => {
  it('audio is in neither Media nor Files, in both modes', () => {
    const attachments = feed([item(1, { mime: 'audio/webm', name: 'voice.webm' })]);
    for (const mode of ['full', 'preview'] as const) {
      const media = view(props({ mode, tab: 'media', attachments }));
      expect(findAll(media, (el) => el.type === EmptyState).map((el) => el.props.title)).toEqual([
        CONTACT_EMPTY.media,
      ]);
      const files = view(props({ mode, tab: 'files', attachments }));
      expect(findAll(files, (el) => el.type === EmptyState).map((el) => el.props.title)).toEqual([
        CONTACT_EMPTY.files,
      ]);
    }
  });
});

function profile(userId: string): ChatProfile {
  return { userId, displayName: `Name ${userId}`, avatarUrl: null };
}

describe('sender names', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('missingSenderIds dedupes and skips nulls and known ids', () => {
    expect(missingSenderIds(['a', null, 'b', 'a', 'k'], (id) => id === 'k')).toEqual(['a', 'b']);
  });

  it('a page with 3 unknown senders makes exactly one read with those 3 ids', async () => {
    const read = vi.fn((ids: string[]) =>
      Promise.resolve({ ok: true as const, data: ids.map(profile) }),
    );
    const onResolved = vi.fn();
    const resolve = senderNameResolver({ read, known: () => false, onResolved });
    await resolve(['a', 'b', 'a', 'c', null]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toEqual(['a', 'b', 'c']);
    const found = onResolved.mock.calls[0]?.[0] as Map<string, ChatProfile>;
    expect([...found.keys()]).toEqual(['a', 'b', 'c']);
    expect(contactSenderName('b', 'me', found)).toBe('Name b');
  });

  it('known ids and ids asked before are not requested', async () => {
    const read = vi.fn((ids: string[]) =>
      Promise.resolve({ ok: true as const, data: ids.map(profile) }),
    );
    const resolve = senderNameResolver({ read, known: (id) => id === 'k', onResolved: vi.fn() });
    await resolve(['k']);
    expect(read).not.toHaveBeenCalled();
    await resolve(['a', 'k']);
    await resolve(['a', 'b']);
    expect(read.mock.calls.map((call) => call[0])).toEqual([['a'], ['b']]);
  });

  it('an error keeps Unknown and is not retried', async () => {
    const read = vi.fn(
      (): Promise<Result<ChatProfile[]>> =>
        Promise.resolve({ ok: false, error: { code: 'unknown', message: 'boom' } }),
    );
    const onResolved = vi.fn();
    const resolve = senderNameResolver({ read, known: () => false, onResolved });
    await resolve(['a']);
    await resolve(['a']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(onResolved).not.toHaveBeenCalled();
    expect(contactSenderName('a', 'me', new Map())).toBe('Unknown');
  });

  it('a thrown read keeps Unknown', async () => {
    const found = await readSenderProfiles(['a'], () => Promise.reject(new Error('net')));
    expect(found.size).toBe(0);
  });

  it('a read past 5s is aborted, keeps Unknown and is not retried', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const read = vi.fn(
      (_ids: string[], s: AbortSignal) =>
        new Promise<{ ok: true; data: ChatProfile[] }>(() => {
          signal = s;
        }),
    );
    const onResolved = vi.fn();
    const resolve = senderNameResolver({ read, known: () => false, onResolved });
    const pending = resolve(['a']);
    await vi.advanceTimersByTimeAsync(SENDER_READ_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(onResolved).not.toHaveBeenCalled();
    await resolve(['a']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(SENDER_READ_TIMEOUT_MS).toBe(5000);
  });
});

describe('Files tab opens files in the in-app viewer', () => {
  it('each Files row is a button (no link out, no new tab), keyed by file kind', () => {
    const attachments = feed([
      item(1, { mime: 'application/pdf', name: 'deck.pdf' }),
      item(2, { mime: 'video/mp4', name: 'clip.mp4' }),
      item(3, {
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        name: 'brief.docx',
      }),
    ]);
    const html = renderToStaticMarkup(
      view(props({ tab: 'files', attachments, presignEnabled: true, mode: 'full' })),
    );
    expect(html).toContain('data-file-row="pdf"');
    expect(html).toContain('data-file-row="video"');
    expect(html).toContain('data-file-row="office"');
    expect(html).not.toMatch(/<a[^>]*data-file-row/);
    expect(html).not.toContain('target="_blank"');
  });

  it('the Links tab is unchanged: external links still open outside', () => {
    const html = renderToStaticMarkup(view(props({ tab: 'links', links: feed([link(1)]) })));
    expect(html).toContain('target="_blank"');
  });
});
