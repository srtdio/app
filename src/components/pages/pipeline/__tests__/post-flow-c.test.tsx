// Post flow C: one regression test per Pipeline fix (cards, status line, the
// corner move button, due line, search fields, chips, the narrowing count and
// undated hint, the two header buttons, the move sheet actions, the ask-first
// confirms, the plain move error) plus the empty pipeline copy. Node env: cards
// render to static markup, hookless views are walked as element trees, and
// only the stage_transition proc is mocked.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@srtdio/posts', async () => {
  const actual = await vi.importActual<typeof import('@srtdio/posts')>('@srtdio/posts');
  return { ...actual, stageTransition: vi.fn() };
});
// No DOM here: the header buttons read a fixed laptop breakpoint, and the range
// calendar (closed in every test) is stubbed out.
vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => true }));
vi.mock('@/components/pages/pipeline/PipelineDateRangeCalendar', () => ({
  PipelineDateRangeCalendar: () => null,
}));

import { PostCard, cardCoverKind, cardRatio, dueLabel } from '@/components/pages/PostCard';
import type { PostCardProps } from '@/components/pages/PostCard';
import {
  hasAllowedMove,
  joinNames,
  rejectConfirmBody,
  reviewStatus,
  sendForReviewHelper,
  type CardViewer,
} from '@/components/pages/pipeline/card-status';
import { MoveSheetView, moveActions } from '@/components/pages/pipeline/MoveSheet';
import {
  REASON_HINT,
  REASON_LABEL,
  StageMoveConfirmView,
  needsConfirm,
  stageConfirmCopy,
  type ConfirmTarget,
} from '@/components/pages/pipeline/StageMoveConfirm';
import { BoardApproveConfirm } from '@/components/pages/pipeline/PipelineBoard';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import {
  PipelineDateControl,
  PipelineSortControl,
  dateButtonLabel,
  dateControlBody,
  sortControlBody,
} from '@/components/pages/pipeline/PipelineSortControl';
import { GATE_IDLE, createApproveGate } from '@/components/pages/pipeline/approve-gate';
import { parsePipelineQuery } from '@/components/pages/pipeline/pipeline-query';
import { StageChips, type StageChipItem } from '@/components/pages/pipeline/StageChips';
import {
  INITIAL_STAGE,
  MOVE_FALLBACK_MESSAGE,
  emptyPipeline,
  headerCountLabel,
  moveErrorMessage,
  pipelineHeader,
  postSearchFields,
  runUndoableMove,
  stageChipItems,
  undatedHiddenLine,
  undatedHint,
  type UndoableMoveDeps,
} from '@/components/pages/PipelinePage';
import { reasonFailureTitle } from '@/components/pages/pcs/stage-move-commit';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { filterByFields, filterByWindow, isUndated, sortPosts } from '@/lib/list-sort';
import type { UndoableAction } from '@/lib/use-undoable-action';
import type { PresignCache } from '@/lib/asset-presign';
import { stageTransition } from '@srtdio/posts';
import type { Client, DomainErrorCode, PipelinePost, Result, Stage } from '@srtdio/posts';
import { x5Post } from './x5-fixtures';

const stMock = vi.mocked(stageTransition);
const cache = { peek: vi.fn(() => null), resolve: vi.fn() } as unknown as PresignCache;
type Cover = NonNullable<PostCardProps['cover']>;

function card(props: Partial<PostCardProps> & Pick<PostCardProps, 'post'>): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <PostCard cache={cache} presignEnabled={false} {...props} />
    </MemoryRouter>,
  );
}

function viewer(role: string | null, approverFirstNames: string[] = []): CardViewer {
  return { role, approverFirstNames };
}

function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

/** Every element in a tree, walking children and a Sheet's footer; SectionHeader is expanded. */
function all(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    node.forEach((child) => all(child, out));
    return out;
  }
  if (!isElement(node)) return out;
  out.push(node);
  if (node.type === SectionHeader) {
    const render = node.type as unknown as (props: unknown) => ReactElement;
    all(render(node.props), out);
    return out;
  }
  const props = node.props as { children?: ReactNode; footer?: ReactNode };
  all(props.footer, out);
  all(props.children, out);
  return out;
}

function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (!isElement(node)) return '';
  return text((node.props as { children?: ReactNode }).children);
}

const T0 = '2026-01-01T00:00:00Z';
const TWO_HOURS_LATER = new Date('2026-01-01T02:00:00Z');

describe('post flow C: Pipeline card', () => {
  it('fix 1: one fixed cover box per workspace platform (4:5 on Instagram), none for a text-only post', () => {
    expect(cardRatio({ platform: 'instagram' })).toBeCloseTo(0.8);
    expect(cardRatio({ platform: 'tiktok' })).toBeCloseTo(9 / 16);
    expect(cardRatio({ platform: 'not-a-platform' })).toBeNull();
    const square: Cover = { assetVersionId: 'av1', kind: 'image', width: 1000, height: 1000 };
    const wide: Cover = { assetVersionId: 'av1', kind: 'image', width: 3000, height: 1000 };
    const video: Cover = { assetVersionId: 'av2', kind: 'video', width: null, height: null };
    expect(cardCoverKind(x5Post({ thumbnailAssetVersionId: 'av1' }), square)).toBe('image');
    expect(cardCoverKind(x5Post({ format: 'reel' }), undefined)).toBe('video');
    expect(cardCoverKind(x5Post({ format: 'single_image' }), video)).toBe('video');
    expect(cardCoverKind(x5Post({ format: 'text' }), null)).toBe('none');
    expect(cardCoverKind(x5Post({ format: 'single_image' }), null)).toBe('none');

    // The media's own size never changes the box: the same inline ratio for all.
    const media = x5Post({ format: 'single_image', thumbnailAssetVersionId: 'av1' });
    for (const cover of [undefined, square, wide]) {
      const out = card({ post: media, cover });
      expect(out).toContain('aspect-ratio:0.8');
      expect(out).not.toContain('aspect-square');
    }
    const textCard = card({ post: x5Post({ format: 'text', caption: 'Hello' }) });
    expect(textCard).not.toContain('data-post-card-thumb');
    expect(textCard).not.toContain('aspect-ratio');
  });

  it('fix 2: the review status line is "Waiting on you" for an approver, "With {first} · {time}" for a creator', () => {
    expect(reviewStatus('review', T0, viewer('client'), TWO_HOURS_LATER)).toEqual({
      tone: 'you',
      text: 'Waiting on you',
    });
    expect(reviewStatus('review', T0, viewer('agency', ['Meera']), TWO_HOURS_LATER)).toEqual({
      tone: 'with',
      text: 'With Meera · 2 hours ago',
      ago: '2 hours ago',
    });
    for (const role of ['owner', 'admin', 'agency']) {
      expect(reviewStatus('review', T0, viewer(role, ['Meera', 'Arjun']), TWO_HOURS_LATER)).toEqual(
        { tone: 'with', text: 'With approvers · 2 hours ago', ago: '2 hours ago' },
      );
    }
    expect(reviewStatus('review', T0, viewer('owner'), TWO_HOURS_LATER)?.text).toBe(
      'With approvers · 2 hours ago',
    );
    // Only Review has a status line; an unknown role gets none.
    expect(reviewStatus('approved', T0, viewer('client'), TWO_HOURS_LATER)).toBeNull();
    expect(reviewStatus('draft', T0, viewer('agency', ['Meera']), TWO_HOURS_LATER)).toBeNull();
    expect(reviewStatus('review', T0, viewer(null), TWO_HOURS_LATER)).toBeNull();

    // On the card: the approver's line is marked "you"; with a status line the
    // All view leaves the stage label out; without one it keeps it.
    const mine = card({
      post: x5Post({ stage: 'review', stage_entered_at: T0 }),
      viewer: viewer('client'),
      now: TWO_HOURS_LATER,
      showStage: true,
    });
    expect(mine).toContain('data-post-card-status="you"');
    expect(mine).toContain('Waiting on you');
    expect(mine).not.toContain('data-post-card-stage');
    const theirs = card({
      post: x5Post({ stage: 'review', stage_entered_at: T0 }),
      viewer: viewer('agency', ['Meera']),
      now: TWO_HOURS_LATER,
    });
    expect(theirs).toContain('data-post-card-status="with"');
    // The line shows the time only; the full phrase is its title and aria-label.
    expect(theirs).toContain('aria-label="With Meera · 2 hours ago"');
    expect(theirs).toContain('title="With Meera · 2 hours ago"');
    expect(theirs).toContain('>2 hours ago</span>');
    const draft = card({
      post: x5Post({ stage: 'draft' }),
      viewer: viewer('agency'),
      showStage: true,
    });
    expect(draft).not.toContain('data-post-card-status');
    expect(draft).toContain('data-post-card-stage');
    // No viewer: no status line at all.
    expect(card({ post: x5Post({ stage: 'review' }) })).not.toContain('data-post-card-status');
  });

  it('fix 3: the ⋯ ends the due row, off the picture, and hides when the viewer has no move', () => {
    const out = card({ post: x5Post({ stage: 'review' }), onMove: () => {} });
    const button = /<button[^>]*data-post-card-move=""[^>]*>/.exec(out)?.[0] ?? '';
    expect(button).toContain('aria-label="Move post Post title"');
    expect(button).toContain('ml-auto');
    expect(button).not.toContain('absolute');
    const metaAt = out.indexOf('data-post-card-meta');
    expect(metaAt).toBeGreaterThan(out.indexOf('data-post-card-body'));
    expect(out.indexOf('data-post-card-move')).toBeGreaterThan(metaAt);
    // Nothing of the move control sits on the picture.
    const thumb = out.slice(
      out.indexOf('data-post-card-thumb'),
      out.indexOf('data-post-card-body'),
    );
    expect(thumb).not.toContain('data-post-card-move');
    expect(thumb).not.toContain('bg-overlay-badge-hover');
    // The title takes the full width and clamps at two lines.
    const title = /<div[^>]*data-post-card-title=""[^>]*>/.exec(out)?.[0] ?? '';
    expect(title).toContain('line-clamp-2');

    // An approver can do nothing with a Draft, Parked or Rejected post: no ⋯.
    for (const stage of ['draft', 'parked', 'rejected'] as const) {
      expect(hasAllowedMove('client', stage)).toBe(false);
      const hidden = card({ post: x5Post({ stage }), onMove: () => {}, viewer: viewer('client') });
      expect(hidden).not.toContain('data-post-card-move');
    }
    expect(hasAllowedMove('client', 'review')).toBe(true);
    expect(hasAllowedMove('client', 'approved')).toBe(true);
    for (const stage of ['draft', 'review', 'approved', 'parked', 'rejected'] as const) {
      expect(hasAllowedMove('agency', stage)).toBe(true);
      expect(hasAllowedMove(null, stage)).toBe(false);
    }
    const shown = card({
      post: x5Post({ stage: 'draft' }),
      onMove: () => {},
      viewer: viewer('agency'),
    });
    expect(shown).toContain('data-post-card-move');
  });

  it('fix 4: date reads Due d MMM, the year only outside now', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    expect(dueLabel('2026-03-15T02:00:00Z', 'Asia/Kolkata', now)).toBe('Due 15 Mar');
    expect(dueLabel('2026-03-15T02:00:00Z', 'America/New_York', now)).toBe('Due 14 Mar');
    expect(dueLabel('2026-12-01T00:00:00Z', 'UTC', now)).toBe('Due 1 Dec');
    expect(dueLabel('2027-01-04T00:00:00Z', 'UTC', now)).toBe('Due 4 Jan 2027');
    expect(dueLabel('2026-03-15T02:00:00Z', 'Not/AZone', now)).toBe('Due 15 Mar');
    expect(dueLabel('soon')).toBe('Due soon');
    const out = card({
      post: x5Post({ target_date: '2026-03-15T02:00:00Z' }),
      timeZone: 'UTC',
      now: new Date('2026-03-01T00:00:00Z'),
    });
    expect(out).toMatch(/<span[^>]*data-post-card-due=""[^>]*>Due 15 Mar<\/span>/);
    expect(out).not.toContain('2026');
    expect(card({ post: x5Post({ target_date: null }) })).not.toContain('data-post-card-due');
  });

  it('fix 5: no platform mark, no "Caption:" prefix, search reads title and caption only', () => {
    const out = card({ post: x5Post({ format: 'text', caption: 'Diwali offer copy' }) });
    expect(out).not.toContain('aria-label="instagram"');
    const caption = /<p[^>]*data-post-card-caption=""[^>]*>(.*?)<\/p>/.exec(out)?.[1] ?? '';
    expect(caption).toBe('Diwali offer copy');
    const post = x5Post({ title: 'Launch teaser', caption: 'New drop', platform: 'instagram' });
    expect(postSearchFields(post)).toEqual(['Launch teaser', 'New drop']);
    expect(filterByFields([post], 'instagram', postSearchFields)).toEqual([]);
    expect(filterByFields([post], 'drop', postSearchFields)).toEqual([post]);
  });
});

describe('post flow C: header, count and filters', () => {
  function header(hideDraft: boolean): ReactElement {
    return pipelineHeader({
      search: '',
      onSearchChange: () => {},
      sort: 'updated',
      onSortChange: () => {},
      dateWindow: 'any',
      onDateWindowChange: () => {},
      customRange: null,
      onCustomRangeChange: () => {},
      weekStartDay: 1,
      stage: 'review',
      onStageChange: () => {},
      counts: { all: 4, draft: 2, review: 1, approved: 1 },
      canCreate: false,
      hideDraft,
    });
  }

  it('fix 6: approvers get no Draft chip (stageChipItems and pipelineHeader hideDraft)', () => {
    const counts = { all: 4, draft: 2, review: 1, approved: 1 };
    expect(stageChipItems(counts, true).map((item) => item.key)).toEqual([
      'review',
      'approved',
      'parked',
      'rejected',
      'all',
    ]);
    const withDraft = stageChipItems(counts, false);
    expect(withDraft.map((item) => item.key)).toEqual([
      'draft',
      'review',
      'approved',
      'parked',
      'rejected',
      'all',
    ]);
    expect(withDraft.find((item) => item.key === 'draft')?.count).toBe(2);
    expect(withDraft.find((item) => item.key === 'parked')?.count).toBe(0);
    expect(withDraft[withDraft.length - 1]).toEqual({ key: 'all', label: 'All', count: 4 });

    const chipsOf = (tree: ReactElement): StageChipItem[] => {
      const chips = all(tree).find((el) => el.type === StageChips)!;
      return (chips.props as { items: StageChipItem[] }).items;
    };
    expect(chipsOf(header(true)).some((item) => item.key === 'draft')).toBe(false);
    expect(chipsOf(header(false)).some((item) => item.key === 'draft')).toBe(true);
  });

  it('fix 7: "{shown} of {total} posts" while filtered, and the undated hint with Show them', () => {
    expect(headerCountLabel(1, 5, true)).toBe('1 of 5 posts');
    expect(headerCountLabel(0, 1, true)).toBe('0 of 1 post');
    expect(undatedHiddenLine('This week', 2)).toBe('This week. 2 posts with no date are hidden.');
    expect(undatedHiddenLine('This month', 1)).toBe('This month. 1 post with no date is hidden.');
    expect(undatedHint('This week', 0, () => {})).toBeNull();
    const onShow = vi.fn();
    const hint = undatedHint('This week', 2, onShow)!;
    expect(text(hint)).toContain('This week. 2 posts with no date are hidden.');
    const show = all(hint).find((el) => el.type === Button)!;
    expect(text(show)).toBe('Show them');
    expect((show.props as { variant: string }).variant).toBe('link');
    (show.props as { onClick: () => void }).onClick();
    expect(onShow).toHaveBeenCalledTimes(1);

    // includeUndated keeps null and unreadable target dates in a dated window.
    const now = new Date('2026-06-17T12:00:00Z');
    const rows = [
      { id: 'a', target_date: '2026-06-16T00:00:00Z' },
      { id: 'b', target_date: null },
      { id: 'c', target_date: 'not a date' },
      { id: 'd', target_date: '2026-08-01T00:00:00Z' },
    ];
    const bounds = { now, timeZone: 'UTC', weekStartDay: 1 };
    const ids = (list: { id: string }[]): string[] => list.map((row) => row.id);
    expect(ids(filterByWindow(rows, 'week', bounds))).toEqual(['a']);
    expect(ids(filterByWindow(rows, 'week', { ...bounds, includeUndated: true }))).toEqual([
      'a',
      'b',
      'c',
    ]);
    const customRange = { start: '2026-06-16', end: '2026-06-16' };
    expect(
      ids(filterByWindow(rows, 'custom', { ...bounds, customRange, includeUndated: true })),
    ).toEqual(['a', 'b', 'c']);
    expect(rows.filter(isUndated).map((row) => row.id)).toEqual(['b', 'c']);
  });

  it('fix 8: Sort is order only with directional labels; the date filter is its own 44px button', () => {
    const sortRows = all(sortControlBody({ order: 'updated', onOrderChange: () => {} })).filter(
      (el) => (el.props as { role?: string }).role === 'menuitemradio',
    );
    expect(sortRows.map(text)).toEqual([
      'Recently updated',
      'Least recently updated',
      'Due soonest first',
    ]);
    for (const row of sortRows) {
      const className = (row.props as { className: string }).className;
      expect(className).toContain('h-11');
      expect(className).not.toContain('md:h-9');
      expect(className).not.toContain('md:min-h-0');
    }
    const dateRows = all(
      dateControlBody({
        dateWindow: 'week',
        onDateWindowChange: () => {},
        customRange: null,
        onCustomOpen: () => {},
      }),
    ).filter((el) => (el.props as { role?: string }).role === 'menuitemradio');
    expect(dateRows.map(text)).toEqual(['Any time', 'This week', 'This month', 'Custom…']);

    // 'oldest' is the updated order reversed.
    const posts = [
      x5Post({ id: 'a', updated_at: '2026-01-02T00:00:00Z' }),
      x5Post({ id: 'b', updated_at: '2026-01-01T00:00:00Z' }),
      x5Post({ id: 'c', updated_at: '2026-01-03T00:00:00Z' }),
    ];
    expect(sortPosts(posts, 'updated').map((p) => p.id)).toEqual(['c', 'a', 'b']);
    expect(sortPosts(posts, 'oldest').map((p) => p.id)).toEqual(['b', 'a', 'c']);

    expect(dateButtonLabel('any', null)).toBe('Any time');
    expect(dateButtonLabel('week', null)).toBe('This week');
    expect(dateButtonLabel('month', null)).toBe('This month');
    expect(dateButtonLabel('custom', null)).toBe('Any time');
    expect(dateButtonLabel('custom', { start: '2026-06-24', end: '2026-06-27' })).toBe(
      '24 Jun to 27 Jun',
    );

    const sortTrigger = renderToStaticMarkup(
      <PipelineSortControl order="oldest" onOrderChange={() => {}} />,
    );
    expect(sortTrigger).toContain('h-11');
    expect(sortTrigger).not.toContain('md:h-9');
    expect(sortTrigger).toContain('Least recently updated');
    const dateTrigger = (dateWindow: 'any' | 'week'): string =>
      renderToStaticMarkup(
        <PipelineDateControl
          dateWindow={dateWindow}
          onDateWindowChange={() => {}}
          customRange={null}
          onCustomRangeChange={() => {}}
          weekStartDay={1}
        />,
      );
    const on = dateTrigger('week');
    expect(on).toContain('data-date-filter');
    expect(on).toContain('aria-label="Due date: This week"');
    expect(on).toContain('h-11');
    expect(on).toContain('<span class="hidden md:inline">This week</span>');
    expect(on).toContain('border-accent-line');
    const off = dateTrigger('any');
    expect(off).toContain('aria-label="Due date: Any time"');
    expect(off).not.toContain('border-accent-line');
  });

  it('fix 9: the page still opens on the Review chip', () => {
    expect(INITIAL_STAGE).toBe('review');
    expect(parsePipelineQuery(new URLSearchParams(), INITIAL_STAGE).stage).toBe('review');
  });

  it('empty copy: non-creators read "Posts show up here once creators make them."', () => {
    const out = renderToStaticMarkup(emptyPipeline(false));
    expect(out).toContain('Posts show up here once creators make them.');
    expect(out).not.toContain('agency');
    expect(renderToStaticMarkup(emptyPipeline(true))).not.toContain('once creators make them');
  });
});

describe('post flow C: move sheet and confirms', () => {
  function sheet(stage: Stage, role: string | null): ReactElement {
    let state = GATE_IDLE;
    const gate = createApproveGate({
      move: vi.fn(),
      read: () => state,
      write: (next) => {
        state = next;
      },
    });
    return MoveSheetView({
      open: true,
      post: x5Post({ stage, title: 'Spring drop' }),
      onClose: () => {},
      gate,
      gateState: GATE_IDLE,
      targetDate: '',
      role,
    })!;
  }

  it('fix 39: the move sheet lists only allowed moves as one-line labelled actions', () => {
    expect(moveActions('agency', 'draft')).toEqual([
      { to: 'review', label: 'Send for review', tone: 'default' },
      { to: 'parked', label: 'Park', tone: 'default' },
    ]);
    expect(moveActions('owner', 'review')).toEqual([
      { to: 'approved', label: 'Approve on their behalf', tone: 'default' },
      { to: 'parked', label: 'Park', tone: 'default' },
      { to: 'rejected', label: 'Reject', tone: 'bad' },
    ]);
    expect(moveActions('client', 'review').map((a) => a.label)).toEqual(['Approve', 'Reject']);
    expect(moveActions('client', 'draft')).toEqual([]);
    expect(moveActions(null, 'review')).toEqual([]);
    for (const role of ['owner', 'admin', 'agency', 'client']) {
      for (const stage of ['draft', 'review', 'approved', 'parked', 'rejected'] as const) {
        expect(moveActions(role, stage).some((a) => a.to === 'draft' || a.to === stage)).toBe(
          false,
        );
      }
    }
    expect(sendForReviewHelper([])).toBe('Approvers get it to approve.');
    expect(joinNames(['Meera', 'Arjun', 'Kim'])).toBe('Meera, Arjun and Kim');

    // The sheet: titled by the post, one row per action, no helper lines.
    const tree = sheet('draft', 'agency');
    const moveSheet = all(tree).find((el) => el.type === Sheet)!;
    expect((moveSheet.props as { title: string }).title).toBe('Spring drop');
    const rows = all(tree).filter((el) => 'data-move-action' in (el.props as object));
    const targets = rows.map((row) => (row.props as Record<string, unknown>)['data-move-action']);
    expect(targets).toEqual(['review', 'parked']);
    expect(all(tree).some((el) => 'data-move-helper' in (el.props as object))).toBe(false);
    for (const row of rows) expect(text(row)).not.toContain('.');
    expect(all(tree).some((el) => text(el) === 'Draft' && el.type === 'button')).toBe(false);
  });

  it('fix 40: Reject and Park ask first; Reject takes an optional reason that goes to the comments', () => {
    const ctx = { creatorFirstName: 'Ravi', approverFirstNames: ['Meera', 'Arjun'] };
    expect(stageConfirmCopy('rejected', ctx)).toEqual({
      title: 'Reject this post?',
      body: 'Ravi gets it back to rework. You can send a reason.',
      confirmLabel: 'Reject',
      reason: true,
      variant: 'danger',
    });
    expect(rejectConfirmBody(null)).toBe(
      'The creator gets it back to rework. You can send a reason.',
    );
    expect(stageConfirmCopy('parked', ctx)).toMatchObject({
      title: 'Park this post?',
      body: null,
      confirmLabel: 'Park',
      reason: false,
    });
    expect(stageConfirmCopy('review', ctx)).toMatchObject({
      title: 'Send for review?',
      body: 'Meera and Arjun get it to approve.',
      confirmLabel: 'Send for review',
    });
    expect(REASON_LABEL).toBe('Reason (optional)');
    expect(REASON_HINT).toBe('Goes to the comments.');

    expect(needsConfirm('review', 'rejected', false)).toBe(true);
    expect(needsConfirm('approved', 'parked', false)).toBe(true);
    expect(needsConfirm('draft', 'review', true)).toBe(true);
    expect(needsConfirm('draft', 'review', false)).toBe(false);
    expect(needsConfirm('parked', 'review', true)).toBe(false);
    expect(needsConfirm('review', 'approved', true)).toBe(false);

    const confirmView = (to: ConfirmTarget, reason: string) => {
      const onConfirm = vi.fn<(postId: string, to: ConfirmTarget, reason: string | null) => void>();
      const onCancel = vi.fn();
      const pending = { post: x5Post({ title: 'Spring drop' }), to };
      const tree = StageMoveConfirmView({
        pending,
        shown: pending,
        open: true,
        creatorFirstName: 'Ravi',
        approverFirstNames: [],
        onCancel,
        onConfirm,
        reason,
        onReasonChange: () => {},
        reasonId: 'r1',
      })!;
      const button = (label: string): ReactElement =>
        all(tree).find((el) => text(el) === label && 'onClick' in (el.props as object))!;
      return { tree, onConfirm, onCancel, button };
    };

    const reject = confirmView('rejected', '  Wrong offer dates  ');
    expect((reject.tree.props as { title: string }).title).toBe('Reject this post?');
    const words = all(reject.tree).map(text);
    expect(words).toContain('Ravi gets it back to rework. You can send a reason.');
    expect(words).toContain(REASON_LABEL);
    expect(words).toContain(REASON_HINT);
    (reject.button('Reject').props as { onClick: () => void }).onClick();
    expect(reject.onConfirm).toHaveBeenCalledWith('p1', 'rejected', 'Wrong offer dates');
    (reject.button('Cancel').props as { onClick: () => void }).onClick();
    expect(reject.onCancel).toHaveBeenCalledTimes(1);

    const blank = confirmView('rejected', '   ');
    (blank.button('Reject').props as { onClick: () => void }).onClick();
    expect(blank.onConfirm).toHaveBeenCalledWith('p1', 'rejected', null);

    const park = confirmView('parked', 'ignored');
    expect((park.tree.props as { title: string }).title).toBe('Park this post?');
    expect(all(park.tree).map(text)).not.toContain(REASON_LABEL);
    (park.button('Park').props as { onClick: () => void }).onClick();
    expect(park.onConfirm).toHaveBeenCalledWith('p1', 'parked', null);

    // A client's board drag into Approved names the post in the header and asks once.
    let state = GATE_IDLE;
    const gate = createApproveGate({
      move: () => {},
      read: () => state,
      write: (next) => {
        state = next;
      },
    });
    gate.request('p1', 'approved');
    const board = BoardApproveConfirm({
      post: x5Post({ stage: 'review' }),
      gate,
      gateState: state,
      timeZone: 'UTC',
    })!;
    expect((board.props as { title: string }).title).toBe('Post title');
    const body = (board.props as { children: ReactNode }).children;
    expect(renderToStaticMarkup(<>{body}</>)).toContain('Approve this post?');
  });
});

type PostReason = NonNullable<UndoableMoveDeps['postReason']>;

/** A typed spy for the page's reason poster. */
function reasonSpy(impl: () => Promise<{ ok: boolean }>) {
  return vi.fn<PostReason>(impl);
}

describe('post flow C: the move itself', () => {
  afterEach(() => {
    stMock.mockReset();
  });

  function deps(over: Partial<UndoableMoveDeps> = {}): {
    deps: UndoableMoveDeps;
    actions: UndoableAction[];
    toasts: string[];
  } {
    const actions: UndoableAction[] = [];
    const toasts: string[] = [];
    let current: PipelinePost[] = [x5Post({ id: 'p1', stage: 'review' })];
    return {
      actions,
      toasts,
      deps: {
        client: {} as Client,
        posts: current,
        inFlight: new Set<string>(),
        setPosts: (updater) => {
          current = updater(current);
        },
        onClose: () => {},
        toast: (message) => toasts.push(message),
        role: 'client',
        run: (action) => actions.push(action),
        newTraceId: () => 'trace-1',
        ...over,
      },
    };
  }

  it('fix 40: a landed Reject posts its reason on the move trace; a failed reason toasts', async () => {
    stMock.mockResolvedValue({ ok: true, data: 'p1' } satisfies Result<string>);
    const postReason = reasonSpy(async () => ({ ok: true }));
    const ok = deps({ postReason });
    runUndoableMove(ok.deps, 'p1', 'rejected', 'Wrong offer dates');
    expect(postReason).not.toHaveBeenCalled();
    await ok.actions[0]!.commit();
    expect(stMock).toHaveBeenCalledWith(ok.deps.client, {
      postId: 'p1',
      toStage: 'rejected',
      traceId: 'trace-1',
    });
    expect(postReason).toHaveBeenCalledWith('p1', 'Wrong offer dates', 'trace-1');
    expect(ok.toasts).toEqual([]);

    for (const failing of [
      reasonSpy(async () => ({ ok: false })),
      reasonSpy(async () => {
        throw new Error('offline');
      }),
    ]) {
      const h = deps({ postReason: failing });
      runUndoableMove(h.deps, 'p1', 'rejected', 'Wrong offer dates');
      await h.actions[0]!.commit();
      expect(h.toasts).toEqual([reasonFailureTitle('rejected')]);
    }

    // No reason typed: nothing is posted.
    const none = reasonSpy(async () => ({ ok: true }));
    const quiet = deps({ postReason: none });
    runUndoableMove(quiet.deps, 'p1', 'rejected');
    await quiet.actions[0]!.commit();
    expect(none).not.toHaveBeenCalled();
  });

  it('fix 41: a failed move reads "Couldn\'t move the post. {reason}" and posts no reason', async () => {
    expect(MOVE_FALLBACK_MESSAGE).toBe("Couldn't move the post. Try again.");
    const codes: DomainErrorCode[] = ['invalid_stage_transition', 'unknown'];
    for (const code of codes) expect(moveErrorMessage(code)).toBe(MOVE_FALLBACK_MESSAGE);
    for (const code of ['forbidden_role', 'workspace_member_only'] as DomainErrorCode[]) {
      expect(moveErrorMessage(code)).toBe(
        "Couldn't move the post. You don't have access to do this.",
      );
    }

    stMock.mockResolvedValue({
      ok: false,
      error: { code: 'invalid_stage_transition', message: 'invalid_stage_transition' },
    } satisfies Result<string>);
    const postReason = reasonSpy(async () => ({ ok: true }));
    const refused = deps({ postReason });
    runUndoableMove(refused.deps, 'p1', 'rejected', 'Wrong offer dates');
    await refused.actions[0]!.commit();
    expect(refused.toasts).toEqual([MOVE_FALLBACK_MESSAGE]);
    expect(postReason).not.toHaveBeenCalled();

    stMock.mockRejectedValue(new Error('network down'));
    const thrown = deps({ postReason });
    runUndoableMove(thrown.deps, 'p1', 'rejected', 'Wrong offer dates');
    await thrown.actions[0]!.commit();
    expect(thrown.toasts).toEqual([MOVE_FALLBACK_MESSAGE]);
    expect(postReason).not.toHaveBeenCalled();
  });
});
