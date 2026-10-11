import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  confirmMarkTransition,
  MarkSheetRow,
  MarksList,
  marksListBody,
  NO_OPEN_MARKS,
  MarksSheet,
  OpenPostSheetRow,
  OpenPostsList,
  openPostLines,
} from '@/components/chat/MarksSheet';
import type { ChatMark } from '@/lib/chat/marks';
import type { OpenPostRow } from '@/lib/chat/use-open-posts';

// MarkSheetRow is hook-free, so its returned tree is walked directly with no
// DOM, as MessageThread.test.tsx does for MessageBubble.
function mark(over: Partial<ChatMark> = {}): ChatMark {
  return {
    messageId: 'm1',
    channelId: 'c1',
    type: 'commitment',
    priority: null,
    markedAt: '2026-09-27T10:00:00+00:00',
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    ...over,
  };
}

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
    walk(n.props.children);
  };
  walk(node);
  return out;
}

function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<AnyProps>(node)) return text(node.props.children);
  return '';
}

function row(m: ChatMark, confirming = false, resolver?: { name: string; when: string }) {
  const handlers = { onJump: vi.fn(), onAsk: vi.fn(), onCancel: vi.fn(), onConfirm: vi.fn() };
  const el = MarkSheetRow({
    mark: m,
    sender: 'Asha',
    text: 'Ship the deck',
    when: '10:00',
    ...(resolver !== undefined ? { resolver } : {}),
    confirming,
    busy: false,
    ...handlers,
  });
  return { el, handlers };
}

const byAttr = (name: string) => (el: ReactElement<AnyProps>) => el.props[name] !== undefined;

describe('MarkSheetRow (Open)', () => {
  it('shows one stamp per type: Delivered, Closed, Completed', () => {
    const cases = [
      ['commitment', 'Delivered'],
      ['decision', 'Closed'],
      ['pending', 'Completed'],
    ] as const;
    for (const [type, word] of cases) {
      const { el } = row(mark({ type }));
      const actions = findAll(el, byAttr('data-mark-action'));
      expect(actions).toHaveLength(1);
      expect(actions[0]?.props['data-mark-action']).toBe('resolve');
      expect(text(actions[0]?.props.children)).toBe(word);
      // 44x44 minimum hit area: the shared default Button at size lg (h-11).
      expect(actions[0]?.type).toBe(Button);
      expect(actions[0]?.props.size).toBe('lg');
      expect(String(actions[0]?.props.className)).toContain('min-w-[44px]');
      expect(text(el)).not.toContain('Resolve');
    }
  });

  it('tapping the stamp asks; the inline confirm repeats the stamp word', () => {
    const { el, handlers } = row(mark({ type: 'decision' }));
    expect(findAll(el, byAttr('data-mark-confirm'))).toHaveLength(0);
    (findAll(el, byAttr('data-mark-action'))[0]?.props.onClick as () => void)();
    expect(handlers.onAsk).toHaveBeenCalledOnce();

    const cases = [
      ['commitment', 'Mark this commitment as delivered?', 'Delivered'],
      ['decision', 'Mark this decision as closed?', 'Closed'],
      ['pending', 'Mark this priority as completed?', 'Completed'],
    ] as const;
    for (const [type, copy, word] of cases) {
      const open = row(mark({ type }), true);
      const [confirm] = findAll(open.el, byAttr('data-mark-confirm'));
      expect(confirm?.props['data-mark-confirm']).toBe('resolve');
      expect(text(confirm)).toContain(copy);
      const buttons = findAll(confirm, (e) => e.type === Button);
      expect(buttons.map((b) => text(b.props.children))).toEqual(['Cancel', word]);
      (buttons[1]?.props.onClick as () => void)();
      expect(open.handlers.onConfirm).toHaveBeenCalledOnce();
      (buttons[0]?.props.onClick as () => void)();
      expect(open.handlers.onCancel).toHaveBeenCalledOnce();
    }
  });
});

describe('MarkSheetRow (History)', () => {
  const resolver = { name: 'Asha', when: '11:30' };

  it('shows the stamp word, resolver and time, and a 44x44 Reopen', () => {
    const { el } = row(
      mark({ type: 'pending', resolved: true, resolvedBy: 'u2', resolvedAt: 'x' }),
      false,
      resolver,
    );
    const [block] = findAll(el, byAttr('data-mark-history'));
    expect(text(block)).toContain('Completed');
    expect(text(block)).toContain('Asha · 11:30');
    const [reopen] = findAll(el, byAttr('data-mark-action'));
    expect(reopen?.props['data-mark-action']).toBe('reopen');
    expect(text(reopen?.props.children)).toBe('Reopen');
    expect(reopen?.type).toBe(Button);
    expect(reopen?.props.size).toBe('lg');
  });

  it('Reopen confirm copy per type', () => {
    const cases = [
      ['commitment', 'Reopen this commitment?'],
      ['decision', 'Reopen this decision?'],
      ['pending', 'Reopen this priority?'],
    ] as const;
    for (const [type, copy] of cases) {
      const { el } = row(mark({ type, resolved: true }), true, resolver);
      const [confirm] = findAll(el, byAttr('data-mark-confirm'));
      expect(confirm?.props['data-mark-confirm']).toBe('reopen');
      expect(text(confirm)).toContain(copy);
      expect(findAll(confirm, (e) => e.type === Button).map((b) => text(b.props.children))).toEqual(
        ['Cancel', 'Reopen'],
      );
    }
  });
});

describe('confirmMarkTransition', () => {
  it('runs the matching handler and toasts "Could not update" on failure', async () => {
    const onResolve = vi.fn(() => Promise.resolve({ ok: false as const, message: 'boom' }));
    const onReopen = vi.fn(() => Promise.resolve({ ok: true as const }));
    const toast = { show: vi.fn() };
    await confirmMarkTransition({ action: 'resolve', messageId: 'm1', onResolve, onReopen, toast });
    expect(onResolve).toHaveBeenCalledWith('m1');
    expect(toast.show).toHaveBeenCalledWith({ title: 'Could not update' });

    toast.show.mockClear();
    await confirmMarkTransition({ action: 'reopen', messageId: 'm2', onResolve, onReopen, toast });
    expect(onReopen).toHaveBeenCalledWith('m2');
    expect(toast.show).not.toHaveBeenCalled();
  });
});

describe('MarksSheet', () => {
  it('wraps the shared MarksList in the Sheet, passing every list prop through', () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    const listProps = {
      open: true,
      marks: new Map([['m1', mark()]]),
      messageFor: () => undefined,
      profiles: new Map(),
      currentUserId: 'me',
      timeZone: 'UTC',
      onJump,
      onResolve: vi.fn(),
      onReopen: vi.fn(),
    };
    const tree = MarksSheet({ ...listProps, onClose });
    expect(tree.type).toBe(Sheet);
    expect(tree.props.title).toBe('Marked messages');
    expect(tree.props.onClose).toBe(onClose);
    const list = findAll(tree, (el) => el.type === MarksList)[0];
    expect(list?.props).toEqual(listProps);
  });
});

function openPost(over: Partial<OpenPostRow> = {}): OpenPostRow {
  return {
    id: 'p1',
    number: 12,
    title: 'Launch teaser',
    format: 'carousel',
    target_date: '2026-10-02',
    stage_entered_at: '2026-09-20T00:00:00Z',
    thumbnailAssetVersionId: null,
    ...over,
  };
}

describe('Open tab posts section', () => {
  it('row lines: KEY · title, then format · target date · where it is', () => {
    expect(openPostLines(openPost(), 'gbl', true, 'UTC')).toEqual({
      title: 'GBL-12 · Launch teaser',
      meta: 'Carousel · Oct 2 · in this chat',
    });
    expect(openPostLines(openPost({ target_date: null }), null, false, 'UTC')).toEqual({
      title: 'Launch teaser',
      meta: 'Carousel · not shared here yet',
    });
  });

  it('P6: a timestamptz target date renders in the workspace zone (never blank)', () => {
    const post = openPost({ target_date: '2026-10-02T20:30:00+00:00' });
    expect(openPostLines(post, 'gbl', true, 'UTC').meta).toBe('Carousel · Oct 2 · in this chat');
    // 20:30 UTC is already Oct 3 in Kolkata.
    expect(openPostLines(post, 'gbl', true, 'Asia/Kolkata').meta).toBe(
      'Carousel · Oct 3 · in this chat',
    );
    const html = renderToStaticMarkup(
      <OpenPostSheetRow
        post={post}
        workspaceKey="gbl"
        shared={false}
        timeZone="UTC"
        onJump={() => {}}
        onShare={() => {}}
      />,
    );
    expect(html).toContain('Oct 2');
  });

  it('Jump when a card is in this chat, Share here otherwise', () => {
    const onJump = vi.fn();
    const onShare = vi.fn();
    const shared = OpenPostSheetRow({
      post: openPost(),
      workspaceKey: 'gbl',
      shared: true,
      timeZone: 'UTC',
      onJump,
      onShare,
    });
    const [jump] = findAll(shared, (el) => el.type === Button);
    expect(text(jump)).toBe('Jump');
    (jump?.props.onClick as () => void)();
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onShare).not.toHaveBeenCalled();

    const other = OpenPostSheetRow({
      post: openPost(),
      workspaceKey: 'gbl',
      shared: false,
      timeZone: 'UTC',
      onJump,
      onShare,
    });
    const [share] = findAll(other, (el) => el.type === Button);
    expect(text(share)).toBe('Share here');
    expect(share?.props['data-open-post-action']).toBe('share');
    (share?.props.onClick as () => void)();
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it('rows are 64px with a 44px thumb; no cover shows the KEY monogram', () => {
    const html = renderToStaticMarkup(
      <OpenPostSheetRow
        post={openPost()}
        workspaceKey="gbl"
        shared={false}
        timeZone="UTC"
        onJump={() => {}}
        onShare={() => {}}
      />,
    );
    expect(html).toContain('h-16');
    expect(html).toMatch(/data-open-post-thumb=""[^>]*h-11 w-11[^>]*>GBL</);
  });

  it('lists under the side heading, marking which posts are shared here', () => {
    const onJump = vi.fn();
    const onShare = vi.fn();
    const html = renderToStaticMarkup(
      <OpenPostsList
        heading="Posts waiting on you"
        posts={[openPost(), openPost({ id: 'p2', number: 13, title: 'Reel cut' })]}
        workspaceKey="gbl"
        sharedIds={new Set(['p2'])}
        timeZone="UTC"
        onJump={onJump}
        onShare={onShare}
      />,
    );
    expect(html).toContain('Posts waiting on you');
    expect(html).toContain('data-open-post="p1"');
    expect(html).toContain('data-open-post-action="share"');
    expect(html).toContain('data-open-post-action="jump"');
  });

  it('renders nothing with no posts waiting or before the read lands', () => {
    const base = {
      heading: 'x',
      workspaceKey: 'gbl',
      sharedIds: new Set<string>(),
      timeZone: 'UTC',
      onJump: vi.fn(),
      onShare: vi.fn(),
    };
    expect(OpenPostsList({ ...base, posts: [] })).toBeNull();
    expect(OpenPostsList({ ...base, posts: null })).toBeNull();
  });
});

describe('marks section body (B3)', () => {
  it('posts listed and no open mark: the muted No open marks line, not the empty state', () => {
    expect(marksListBody('open', 0, 2)).toBe('no-open-marks');
    expect(NO_OPEN_MARKS).toBe('No open marks');
  });

  it('both empty keeps the EmptyState; rows win; History ignores posts', () => {
    expect(marksListBody('open', 0, 0)).toBe('empty');
    expect(marksListBody('open', 3, 2)).toBe('rows');
    expect(marksListBody('history', 0, 2)).toBe('empty');
  });
});
