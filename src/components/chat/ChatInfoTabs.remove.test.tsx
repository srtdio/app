// @vitest-environment jsdom
// Chat - remove files, keep the message: the chat info Media and Files tabs.
// Select shows only with an own removable file on the open tab; select mode
// ticks own files only (others', voice notes and marked messages get no
// check); Remove is disabled at 0 and hands the ticked files to onRemoveFiles;
// Escape leaves select mode and refocuses Select; the shared overlay hides
// removed files at once and Undo brings them back.
import { isValidElement, act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/chat-reads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat-reads')>()),
  readProfiles: vi.fn(() => Promise.resolve({ ok: true, data: [] })),
}));
const { mockList } = vi.hoisted(() => ({ mockList: vi.fn() }));
vi.mock('@/lib/chat/channel-media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/channel-media')>()),
  listChannelAttachments: mockList,
}));

import {
  ChatInfoTabs,
  ChatInfoTabsView,
  FeedBody,
  canTickFile,
  fileKey,
  showSelect,
  tickedFiles,
  type ChatInfoTabsProps,
  type ChatInfoTabsViewProps,
  type Feed,
  type InfoSelectChrome,
} from '@/components/chat/ChatInfoTabs';
import { RemoveSelectionBarView } from '@/components/chat/SelectionBar';
import { PresignCache } from '@/lib/asset-presign';
import { removedFilesStore } from '@/lib/chat/remove-files';
import { resetHistorySteps } from '@/lib/chat/use-history-step';
import type { ChatMark } from '@/lib/chat/marks';
import type { ChannelAttachmentItem, ChannelLinkItem } from '@/lib/chat/channel-media';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = 'me';

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
    senderUserId: ME,
    ...over,
  };
}

/** m3 is marked: its files stay. */
const MARKS = new Map<string, ChatMark>([['m3', {} as ChatMark]]);

function marksProps(marks: Map<string, ChatMark> = MARKS): ChatInfoTabsProps['marks'] {
  return {
    marks,
    messageFor: () => undefined,
    profiles: new Map(),
    currentUserId: ME,
    timeZone: 'UTC',
    onResolve: vi.fn(),
    onReopen: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Pure rules.

describe('who may tick a file', () => {
  it('own, unmarked, non-voice files only', () => {
    expect(canTickFile(item(1), ME, MARKS)).toBe(true);
    expect(canTickFile(item(2, { senderUserId: 'other' }), ME, MARKS)).toBe(false);
    expect(canTickFile(item(3), ME, MARKS)).toBe(false);
    expect(canTickFile(item(4, { mime: 'audio/webm' }), ME, MARKS)).toBe(false);
    expect(canTickFile(item(5, { versionId: '' }), ME, MARKS)).toBe(false);
    expect(canTickFile(item(6, { mime: 'application/pdf' }), ME, MARKS)).toBe(true);
  });

  it('Select shows only on Media or Files with an own removable file there', () => {
    expect(showSelect('media', [item(1)], ME, MARKS)).toBe(true);
    expect(showSelect('media', [item(2, { senderUserId: 'other' }), item(3)], ME, MARKS)).toBe(
      false,
    );
    expect(showSelect('media', [], ME, MARKS)).toBe(false);
    expect(showSelect('links', [item(1)], ME, MARKS)).toBe(false);
    expect(showSelect('starred', [item(1)], ME, MARKS)).toBe(false);
  });

  it('the ticked files map to message, asset id and mime, in list order', () => {
    const list = [item(1), item(2), item(6, { mime: 'application/pdf' })];
    const selected = new Set([fileKey(list[2]!), fileKey(list[0]!)]);
    expect(tickedFiles(list, selected)).toEqual([
      { messageId: 'm1', assetId: 'v1', mime: 'image/png' },
      { messageId: 'm6', assetId: 'v6', mime: 'application/pdf' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The hook-free view: ticks only on the files the rule allows.

type AnyProps = Record<string, unknown> & { children?: ReactNode };

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
  };
  walk(node);
  return out;
}

function feed<T>(items: T[]): Feed<T> {
  return { status: 'ready', items, hasMore: false, cursor: null, loadingMore: false };
}

function viewProps(over: Partial<ChatInfoTabsViewProps> = {}): ChatInfoTabsViewProps {
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
    marks: null,
    open: true,
    onJump: vi.fn(),
    mode: 'full',
    ...over,
  };
}

describe('ChatInfoTabsView select mode', () => {
  const list = [
    item(1),
    item(2, { senderUserId: 'other' }),
    item(3),
    item(6, { mime: 'application/pdf' }),
    item(7, { mime: 'application/pdf', senderUserId: 'other' }),
  ];
  const selection = {
    selected: new Set([fileKey(list[0]!)]),
    canTick: (i: ChannelAttachmentItem) => canTickFile(i, ME, MARKS),
    onToggle: vi.fn(),
  };
  const ticks = (tree: ReactElement) =>
    findAll(tree, (el) => 'tick' in el.props).map((el) => [
      (el.props.item as ChannelAttachmentItem).messageId,
      el.props.tick === null ? null : (el.props.tick as { checked: boolean }).checked,
      el.props.selecting,
    ]);

  it('Media: a tick only on own removable tiles; others and marked get none', () => {
    const tree = ChatInfoTabsView(viewProps({ attachments: feed(list), selection }));
    expect(ticks(tree)).toEqual([
      ['m1', true, true],
      ['m2', null, true],
      ['m3', null, true],
    ]);
  });

  it('Files: a tick only on own rows', () => {
    const tree = ChatInfoTabsView(viewProps({ tab: 'files', attachments: feed(list), selection }));
    expect(ticks(tree)).toEqual([
      ['m6', false, true],
      ['m7', null, true],
    ]);
  });

  it('outside select mode nothing carries a tick', () => {
    const tree = ChatInfoTabsView(viewProps({ attachments: feed(list) }));
    expect(ticks(tree).every(([, tick, selecting]) => tick === null && selecting === false)).toBe(
      true,
    );
  });
});

describe('RemoveSelectionBarView', () => {
  it('one danger Remove, disabled only at 0, clear of the safe area', () => {
    const onRemove = vi.fn();
    const bar = RemoveSelectionBarView({ count: 0, label: 'Remove', onRemove });
    expect(String(bar.props.className)).toContain('env(safe-area-inset-bottom)');
    const buttons = findAll(bar, (el) => el.props['data-selection-remove'] !== undefined);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.props.variant).toBe('danger');
    expect(buttons[0]!.props.disabled).toBe(true);
    expect(buttons[0]!.props.children).toBe('Remove');
    const on = RemoveSelectionBarView({ count: 2, label: 'Remove', onRemove });
    const button = findAll(on, (el) => el.props['data-selection-remove'] !== undefined)[0]!;
    expect(button.props.disabled).toBe(false);
    (button.props.onClick as () => void)();
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The stateful tabs, rendered.

let root: Root | null = null;

beforeEach(() => {
  resetHistorySteps();
  removedFilesStore.reset();
  mockList.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  removedFilesStore.reset();
});

/** A host page: the header slot, the tabs, then the bar (like Contact info). */
function frame(tabs: ReactElement, select: InfoSelectChrome): ReactElement {
  return (
    <div>
      <header data-host-header="">
        {select.selecting ? select.header : <h2>Contact info</h2>}
        {select.selecting ? null : select.header}
      </header>
      {tabs}
      {select.bar}
    </div>
  );
}

async function mount(
  items: ChannelAttachmentItem[],
  over: Partial<ChatInfoTabsProps> = {},
): Promise<void> {
  mockList.mockResolvedValue({
    ok: true,
    data: { items, hasMore: false, cursor: null },
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <ChatInfoTabs
        channelId="ch-1"
        profiles={new Map()}
        currentUserId={ME}
        timeZone="UTC"
        cache={cache}
        presignEnabled={false}
        marks={marksProps()}
        onJump={vi.fn()}
        mode="full"
        frame={frame}
        {...over}
      />,
    ),
  );
  await act(async () => Promise.resolve());
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
const selectButton = () => q<HTMLButtonElement>('[data-testid="info-select"]');
const removeButton = () => q<HTMLButtonElement>('[data-testid="info-remove"]');
const tile = (name: string) => q<HTMLButtonElement>(`button[aria-label="${name}"]`);
const click = (el: HTMLElement | null) => act(() => el!.click());

describe('ChatInfoTabs select mode', () => {
  const list = [item(1), item(2, { senderUserId: 'other' }), item(3)];

  it('Select shows with an own removable file and onRemoveFiles', async () => {
    await mount(list, { onRemoveFiles: vi.fn() });
    const button = selectButton();
    expect(button).not.toBeNull();
    expect(button!.getAttribute('aria-label')).toBe('Select');
    expect(button!.textContent).toBe('Select');
  });

  it('Select is hidden when only others and marked files are listed', async () => {
    await mount([item(2, { senderUserId: 'other' }), item(3)], { onRemoveFiles: vi.fn() });
    expect(selectButton()).toBeNull();
  });

  it('Select is hidden without onRemoveFiles', async () => {
    await mount(list);
    expect(selectButton()).toBeNull();
  });

  it('select mode: checks only on own removable tiles, others do nothing on tap', async () => {
    await mount(list, { onRemoveFiles: vi.fn() });
    await click(selectButton());
    expect(q('[data-testid="info-select-bar"]')).not.toBeNull();
    expect(q('[data-selection-count]')?.textContent).toBe('0 selected');
    expect(tile('a1.png')?.querySelector('[data-select-check]')).not.toBeNull();
    expect(tile('a1.png')?.getAttribute('aria-pressed')).toBe('false');
    for (const name of ['a2.png', 'a3.png']) {
      expect(tile(name)?.querySelector('[data-select-check]')).toBeNull();
      expect(tile(name)?.hasAttribute('aria-pressed')).toBe(false);
      expect(tile(name)?.disabled).toBe(false);
    }
    await click(tile('a2.png'));
    expect(q('[data-selection-count]')?.textContent).toBe('0 selected');
    expect(q('[role="dialog"]')).toBeNull();
  });

  it('Remove is disabled at 0 and hands the ticked files to onRemoveFiles', async () => {
    const onRemoveFiles = vi.fn();
    await mount([...list, item(4)], { onRemoveFiles });
    await click(selectButton());
    expect(removeButton()?.disabled).toBe(true);
    await click(tile('a1.png'));
    await click(tile('a4.png'));
    expect(tile('a1.png')?.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-selection-count]')?.textContent).toBe('2 selected');
    expect(removeButton()?.disabled).toBe(false);
    expect(removeButton()?.textContent).toBe('Remove');
    await click(removeButton());
    expect(onRemoveFiles).toHaveBeenCalledWith([
      { messageId: 'm1', assetId: 'v1', mime: 'image/png' },
      { messageId: 'm4', assetId: 'v4', mime: 'image/png' },
    ]);
    // Select mode ends after Remove.
    expect(q('[data-testid="info-select-bar"]')).toBeNull();
  });

  it('a second tap unticks', async () => {
    await mount(list, { onRemoveFiles: vi.fn() });
    await click(selectButton());
    await click(tile('a1.png'));
    await click(tile('a1.png'));
    expect(q('[data-selection-count]')?.textContent).toBe('0 selected');
    expect(removeButton()?.disabled).toBe(true);
  });

  it('Escape leaves select mode and returns focus to Select; the sheet stays', async () => {
    const onEscape = vi.fn();
    await mount(list, { onRemoveFiles: vi.fn(), onEscape });
    await click(selectButton());
    await click(tile('a1.png'));
    await act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(q('[data-testid="info-select-bar"]')).toBeNull();
    expect(selectButton()).not.toBeNull();
    expect(document.activeElement).toBe(selectButton());
    expect(onEscape).not.toHaveBeenCalled();
    // The next Escape closes the surface.
    await act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('Cancel leaves select mode and returns focus to Select', async () => {
    await mount(list, { onRemoveFiles: vi.fn() });
    await click(selectButton());
    await click(q('[data-selection-cancel]'));
    expect(q('[data-testid="info-select-bar"]')).toBeNull();
    expect(document.activeElement).toBe(selectButton());
  });

  it('switching tabs leaves select mode', async () => {
    await mount([...list, item(6, { mime: 'application/pdf' })], { onRemoveFiles: vi.fn() });
    await click(selectButton());
    const files = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Files');
    await click(files ?? null);
    expect(q('[data-testid="info-select-bar"]')).toBeNull();
    expect(selectButton()).not.toBeNull();
  });

  it('files removed through the overlay drop out at once; Undo brings them back', async () => {
    await mount(list, { onRemoveFiles: vi.fn() });
    expect(tile('a1.png')).not.toBeNull();
    let undo: () => void = () => undefined;
    await act(() => {
      undo = removedFilesStore.add('ch-1', [{ messageId: 'm1', assetId: 'v1' }]);
    });
    expect(tile('a1.png')).toBeNull();
    // Nothing of the viewer's left: Select goes too.
    expect(selectButton()).toBeNull();
    await act(() => undo());
    expect(tile('a1.png')).not.toBeNull();
    expect(selectButton()).not.toBeNull();
  });
});
