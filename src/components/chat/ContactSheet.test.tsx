import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import {
  appendPage,
  CONTACT_EMPTY,
  ContactSheetView,
  FEED_LOADING,
  FeedBody,
  feedForTab,
  showLoadMore,
  type ContactSheetViewProps,
  type ContactTab,
  type Feed,
} from '@/components/chat/ContactSheet';
import { MarksList } from '@/components/chat/MarksSheet';
import { PresignCache } from '@/lib/asset-presign';
import type { ChannelAttachmentItem, ChannelLinkItem } from '@/lib/chat/channel-media';

type AnyProps = Record<string, unknown> & { children?: ReactNode };

// ContactSheetView and FeedBody are hook-free: the walk expands FeedBody by
// calling it and reads every other element's props, with no DOM (node env).
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

function item(over: Partial<ChannelAttachmentItem> = {}): ChannelAttachmentItem {
  return {
    messageId: 'm1',
    versionId: 'v1',
    name: 'a.png',
    mime: 'image/png',
    size: 10,
    createdAt: '2026-09-22T10:00:00+00:00',
    senderUserId: 'u1',
    ...over,
  };
}

function feed<T>(items: T[], hasMore = false): Feed<T> {
  return { status: 'ready', items, hasMore, cursor: null, loadingMore: false };
}

function props(over: Partial<ContactSheetViewProps> = {}): ContactSheetViewProps {
  return {
    open: true,
    onClose: vi.fn(),
    title: 'Alice Doe',
    avatarUrl: null,
    roleLine: 'Client · Acme',
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
    onJump: vi.fn(),
    ...over,
  };
}

const view = (p: ContactSheetViewProps): ReactElement => ContactSheetView(p) as ReactElement;
const emptyTitles = (tree: ReactElement): string[] =>
  findAll(tree, (el) => el.type === EmptyState).map((el) => String(el.props.title));
const loadMore = (tree: ReactElement) =>
  findAll(tree, (el) => el.type === Button && 'data-load-more' in el.props);

describe('ContactSheetView page', () => {
  it('is a full-screen page, not a sheet', () => {
    const tree = view(props());
    expect(tree.props['data-contact-page']).toBe('');
    expect(String(tree.props.className)).toContain('fixed inset-0');
  });

  it('renders nothing while closed', () => {
    expect(ContactSheetView(props({ open: false }))).toBeNull();
  });

  it('the 44px back button closes the page', () => {
    const onClose = vi.fn();
    const [back] = findAll(view(props({ onClose })), (el) => el.type === IconButton);
    expect(back?.props.label).toBe('Close contact info');
    (back?.props.onClick as () => void)();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('heading defaults to Contact info and drives the title, aria-label and back label', () => {
    const tree = view(props());
    expect(tree.props['aria-label']).toBe('Contact info');
    const custom = view(props({ heading: 'Group info' }));
    expect(custom.props['aria-label']).toBe('Group info');
    const [back] = findAll(custom, (el) => el.type === IconButton);
    expect(back?.props.label).toBe('Close group info');
    const titles = findAll(custom, (el) => el.type === 'h2').map((el) => el.props.children);
    expect(titles).toEqual(['Group info']);
  });
});

describe('ContactSheetView tabs', () => {
  it('renders Media, Files, Links, Starred, Marks as tap chips; Media selected by default', () => {
    const tree = view(props());
    const chips = findAll(tree, (el) => el.type === Chip);
    expect(chips.map((c) => c.props.label)).toEqual([
      'Media',
      'Files',
      'Links',
      'Starred',
      'Marks',
    ]);
    expect(chips.every((c) => c.props.size === 'tap')).toBe(true);
    expect(chips.map((c) => c.props.selected)).toEqual([true, false, false, false, false]);
  });

  it('tapping a chip switches the tab, and the body follows the tab', () => {
    const onTab = vi.fn();
    const tree = view(props({ onTab }));
    const links = findAll(tree, (el) => el.type === Chip && el.props.label === 'Links')[0];
    (links?.props.onClick as () => void)();
    expect(onTab).toHaveBeenCalledWith('links');
    for (const tab of ['media', 'files', 'links', 'starred', 'marks'] as ContactTab[]) {
      const t = view(props({ tab }));
      expect(findAll(t, (el) => el.props['data-contact-tab'] === tab)).toHaveLength(1);
    }
  });

  it('shows the name and the role line from the header source', () => {
    const tree = view(props());
    const line = findAll(tree, (el) => 'data-role-line' in el.props)[0];
    expect(line?.props.children).toBe('Client · Acme');
    expect(findAll(view(props({ roleLine: null })), (el) => 'data-role-line' in el.props)).toEqual(
      [],
    );
  });

  it('Media and Files share the attachments read; Marks reads nothing', () => {
    expect(feedForTab('media')).toBe('attachments');
    expect(feedForTab('files')).toBe('attachments');
    expect(feedForTab('links')).toBe('links');
    expect(feedForTab('marks')).toBeNull();
    expect(feedForTab('starred')).toBeNull();
  });
});

describe('ContactSheetView states', () => {
  it('empty states per tab', () => {
    expect(emptyTitles(view(props({ tab: 'media' })))).toEqual([CONTACT_EMPTY.media]);
    expect(emptyTitles(view(props({ tab: 'files' })))).toEqual([CONTACT_EMPTY.files]);
    expect(emptyTitles(view(props({ tab: 'links' })))).toEqual([CONTACT_EMPTY.links]);
    expect(CONTACT_EMPTY).toEqual({
      media: 'Photos in this chat show up here.',
      files: 'Files in this chat show up here.',
      links: 'Links in this chat show up here.',
      starred: 'Starred messages show up here.',
    });
    expect(emptyTitles(view(props({ tab: 'starred' })))).toEqual([CONTACT_EMPTY.starred]);
  });

  it('voice notes (audio) appear in neither Media nor Files', () => {
    const attachments = feed([item({ mime: 'audio/webm', name: 'voice.webm' })]);
    expect(emptyTitles(view(props({ tab: 'media', attachments })))).toEqual([CONTACT_EMPTY.media]);
    expect(emptyTitles(view(props({ tab: 'files', attachments })))).toEqual([CONTACT_EMPTY.files]);
  });

  it('files only: Media is empty, Files lists them (video counts as a file)', () => {
    const attachments = feed([item({ mime: 'video/mp4', name: 'v.mp4' })]);
    expect(emptyTitles(view(props({ tab: 'media', attachments })))).toEqual([CONTACT_EMPTY.media]);
    const files = view(props({ tab: 'files', attachments }));
    expect(emptyTitles(files)).toEqual([]);
    expect(findAll(files, (el) => 'data-files' in el.props)).toHaveLength(1);
  });

  it('loading holds until the first page resolves: no list, no empty state', () => {
    const tree = view(props({ attachments: FEED_LOADING }));
    expect(findAll(tree, (el) => el.props['data-feed'] === 'loading')).toHaveLength(1);
    expect(emptyTitles(tree)).toEqual([]);
    expect(findAll(tree, (el) => 'data-media-grid' in el.props)).toEqual([]);
  });

  it('Load more shows only on a full page, and calls the tab feed', () => {
    expect(loadMore(view(props({ attachments: feed([item()], false) })))).toEqual([]);
    const onLoadMore = vi.fn();
    const tree = view(props({ tab: 'links', onLoadMore, links: feed<ChannelLinkItem>([], true) }));
    const [button] = loadMore(tree);
    expect(button).toBeDefined();
    (button?.props.onClick as () => void)();
    expect(onLoadMore).toHaveBeenCalledWith('links');
    expect(showLoadMore(FEED_LOADING)).toBe(false);
  });

  it('appendPage replaces loading with the first page, then appends', () => {
    const first = appendPage(FEED_LOADING as Feed<number>, {
      items: [1, 2],
      hasMore: true,
      cursor: { createdAt: 't', id: 'a' },
    });
    expect(first).toMatchObject({ status: 'ready', items: [1, 2], hasMore: true });
    const next = appendPage(first, { items: [3], hasMore: false, cursor: null });
    expect(next).toMatchObject({ items: [1, 2, 3], hasMore: false, cursor: { id: 'a' } });
  });
});

describe('ContactSheetView Marks', () => {
  it('jump closes the Contact sheet and calls onJump', () => {
    const onClose = vi.fn();
    const onJump = vi.fn();
    const tree = view(props({ tab: 'marks', onClose, onJump }));
    const list = findAll(tree, (el) => el.type === MarksList)[0];
    expect(list).toBeDefined();
    (list?.props.onJump as (id: string) => void)('m9');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith('m9');
  });
});
