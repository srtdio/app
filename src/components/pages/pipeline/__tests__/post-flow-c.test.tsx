// Post flow C: one regression test per Pipeline fix (cards, status line, the
// select bar rows (the old ⋮), due words, chips, the narrowing count and
// undated hint, the two header buttons, the move sheet actions, the ask-first
// confirms, the plain move error) plus the empty pipeline copy. Node env: cards
// render to static markup, hookless views are walked as element trees, and
// only the stage_transition proc is mocked.
import { afterEach, describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@srtdio/posts', async () => {
  const actual = await vi.importActual<typeof import('@srtdio/posts')>('@srtdio/posts');
  return { ...actual, stageTransition: vi.fn() };
});
// No DOM here: the header buttons read a fixed laptop breakpoint, and the range
// calendar (closed in every test) is stubbed out.
vi.mock('@/components/pages/pipeline/PipelineDateRangeCalendar', () => ({
  PipelineDateRangeCalendar: () => null,
}));

import { PostCard, cardCoverKind, cardDue } from '@/components/pages/PostCard';
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
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import { Sheet } from '@/components/ui/Sheet';
import { WritingBox } from '@/components/ui/WritingBox';
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
  pipelineSelectActions,
  runUndoableMove,
  stageChipItems,
  undatedHiddenLine,
  undatedHint,
  type UndoableMoveDeps,
} from '@/components/pages/PipelinePage';
import { reasonFailureTitle } from '@/components/pages/pcs/stage-move-commit';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { listScreenChipRow } from '@/components/shell/ListScreen';
import { filterByWindow, isUndated, sortPosts } from '@/lib/list-sort';
import type { UndoableAction } from '@/lib/use-undoable-action';
import { formatAgo } from '@/lib/time';
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
// The status time is formatAgo: "2h".
const WHEN = formatAgo(T0, TWO_HOURS_LATER);

describe('post flow C: Pipeline card', () => {
  it('fix 1: the picture is the post cover, the play placeholder or "Aa" (a text post)', () => {
    const square: Cover = { assetVersionId: 'av1', kind: 'image', width: 1000, height: 1000 };
    const video: Cover = { assetVersionId: 'av2', kind: 'video', width: null, height: null };
    expect(cardCoverKind(x5Post({ thumbnailAssetVersionId: 'av1' }), square)).toBe('image');
    expect(cardCoverKind(x5Post({ format: 'reel' }), undefined)).toBe('video');
    expect(cardCoverKind(x5Post({ format: 'single_image' }), video)).toBe('video');
    expect(cardCoverKind(x5Post({ format: 'text' }), null)).toBe('none');
    expect(cardCoverKind(x5Post({ format: 'single_image' }), null)).toBe('none');

    // The picture is ListCard's 72 square, whatever the media's own size.
    const media = x5Post({ format: 'single_image', thumbnailAssetVersionId: 'av1' });
    const out = card({ post: media, cover: square });
    expect(out).toContain('data-list-card-picture="image"');
    expect(out).not.toContain('aspect-ratio:');
    const textCard = card({ post: x5Post({ format: 'text', caption: 'Hello' }) });
    expect(textCard).not.toContain('data-post-card-thumb');
    expect(textCard).toContain('data-post-placeholder="text"');
  });

  it('fix 2: the review status line is "Waiting on you" for an approver, "With {first} · {time}" for a creator', () => {
    expect(reviewStatus('review', T0, viewer('client'), TWO_HOURS_LATER)).toEqual({
      tone: 'you',
      text: 'Waiting on you',
    });
    expect(reviewStatus('review', T0, viewer('agency', ['Meera']), TWO_HOURS_LATER)).toEqual({
      tone: 'with',
      text: 'With Meera · 2h',
    });
    for (const role of ['owner', 'admin', 'agency']) {
      expect(reviewStatus('review', T0, viewer(role, ['Meera', 'Arjun']), TWO_HOURS_LATER)).toEqual(
        { tone: 'with', text: `With approvers · ${WHEN}` },
      );
    }
    expect(reviewStatus('review', T0, viewer('owner'), TWO_HOURS_LATER)?.text).toBe(
      `With approvers · ${WHEN}`,
    );
    expect(WHEN).toBe('2h');
    // Only Review has a status line; an unknown role gets none.
    expect(reviewStatus('approved', T0, viewer('client'), TWO_HOURS_LATER)).toBeNull();
    expect(reviewStatus('draft', T0, viewer('agency', ['Meera']), TWO_HOURS_LATER)).toBeNull();
    expect(reviewStatus('review', T0, viewer(null), TWO_HOURS_LATER)).toBeNull();

    // On the card: the status line leads line 2; the stage tag always shows.
    const mine = card({
      post: x5Post({ stage: 'review', stage_entered_at: T0 }),
      viewer: viewer('client'),
      now: TWO_HOURS_LATER,
    });
    expect(mine).toMatch(/data-post-card-status="you"[^>]*>Waiting on you</);
    expect(mine).toContain('data-post-card-stage="review"');
    const theirs = card({
      post: x5Post({ stage: 'review', stage_entered_at: T0 }),
      viewer: viewer('agency', ['Meera']),
      now: TWO_HOURS_LATER,
    });
    expect(theirs).toMatch(/data-post-card-status="with"[^>]*>With Meera · 2h</);
    const draft = card({ post: x5Post({ stage: 'draft' }), viewer: viewer('agency') });
    expect(draft).not.toContain('data-post-card-status');
    expect(draft).toContain('data-post-card-stage="draft"');
    // No viewer: no status line at all.
    expect(card({ post: x5Post({ stage: 'review' }) })).not.toContain('data-post-card-status');
  });

  it('fix 3: no ⋮ on the card; the select bar carries Open, Copy link and the moves', () => {
    const out = card({ post: x5Post({ stage: 'review' }), viewer: viewer('agency') });
    expect(out).not.toContain('data-post-card-move');
    expect(out).not.toContain('Actions for');
    expect(out).not.toContain('data-list-card-line="3"');
    // Nothing of a move control sits on the picture.
    const picture = out.slice(
      out.indexOf('data-list-card-picture'),
      out.indexOf('data-list-card-line="1"'),
    );
    expect(picture).not.toContain('bg-overlay-badge-hover');
    // The title is one line (ListCard line 1).
    const title = /<span[^>]*data-list-card-title=""[^>]*>/.exec(out)?.[0] ?? '';
    expect(title).toContain('truncate');

    // An approver can do nothing with a Draft, Parked or Rejected post: the bar
    // keeps Open and Copy link, and no move row shows (never disabled).
    for (const stage of ['draft', 'parked', 'rejected'] as const) {
      expect(hasAllowedMove('client', stage)).toBe(false);
    }
    const noop = (): void => {};
    const rows = (stage: Stage, v: CardViewer): string[] =>
      pipelineSelectActions({
        post: x5Post({ stage }),
        count: 1,
        viewer: v,
        onOpen: noop,
        onCopyLink: noop,
        onMove: noop,
      }).map((a) => a.label);
    expect(rows('draft', viewer('client'))).toEqual(['Open', 'Copy link']);
    expect(rows('draft', { role: null, approverFirstNames: [], pending: true })).toEqual([
      'Open',
      'Copy link',
      'Move',
    ]);
    expect(rows('draft', viewer('agency'))).toEqual([
      'Open',
      'Copy link',
      'Send for review',
      'Park',
    ]);
    expect(hasAllowedMove('client', 'review')).toBe(true);
    expect(hasAllowedMove('client', 'approved')).toBe(true);
    for (const stage of ['draft', 'review', 'approved', 'parked', 'rejected'] as const) {
      expect(hasAllowedMove('agency', stage)).toBe(true);
      expect(hasAllowedMove(null, stage)).toBe(false);
    }
  });

  it('fix 4: the due time is words only (formatDue) on the workspace day; past reads late', () => {
    const now = new Date('2026-03-01T12:00:00Z');
    const due = (value: string, zone: string | null | undefined): string =>
      cardDue(value, 'review', zone, now).text;
    expect(due('2026-03-15T02:00:00Z', 'Asia/Kolkata')).toBe('15 Mar');
    expect(due('2026-03-15T02:00:00Z', 'America/New_York')).toBe('14 Mar');
    expect(due('2026-03-01T12:00:00Z', 'UTC')).toBe('Today');
    expect(due('2026-03-02T12:00:00Z', 'UTC')).toBe('Tomorrow');
    expect(due('2026-12-01T00:00:00Z', 'UTC')).toBe('1 Dec');
    expect(due('2027-01-04T00:00:00Z', 'UTC')).toBe('4 Jan 2027');
    expect(due('2026-02-27T12:00:00Z', 'UTC')).toBe('2d late');
    expect(due('2026-03-15T02:00:00Z', 'Not/AZone')).toBe(due('2026-03-15T02:00:00Z', undefined));
    expect(due('soon', 'UTC')).toBe('');
    const out = card({
      post: x5Post({ target_date: '2026-03-15T02:00:00Z' }),
      timeZone: 'UTC',
      now,
    });
    expect(out).toMatch(/<span[^>]*data-post-card-due=""[^>]*>15 Mar<\/span>/);
    expect(out).not.toContain('2026');
    expect(out).not.toMatch(/>Due /);
    expect(card({ post: x5Post({ target_date: null }) })).not.toContain('data-post-card-due');
  });

  it('fix 5: no platform mark, no "Caption:" prefix', () => {
    const out = card({ post: x5Post({ format: 'text', caption: 'Diwali offer copy' }) });
    expect(out).not.toContain('aria-label="instagram"');
    const caption = /<span[^>]*data-post-card-caption=""[^>]*>(.*?)<\/span>/.exec(out)?.[1] ?? '';
    expect(caption).toBe('Diwali offer copy');
  });
});

describe('post flow C: header, count and filters', () => {
  function header(hideDraft: boolean): ReactElement {
    return listScreenChipRow(
      pipelineHeader({
        stage: 'review',
        onStageChange: () => {},
        counts: { all: 4, draft: 2, review: 1, approved: 1 },
        hideDraft,
        selectMode: false,
        onSelectToggle: () => {},
      }),
    );
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
    expect(sortRows.map(text)).toEqual(['Newest first', 'Oldest first', 'Due date']);
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
      '24\u201327 Jun',
    );

    const sortTrigger = renderToStaticMarkup(
      <PipelineSortControl order="oldest" onOrderChange={() => {}} />,
    );
    expect(sortTrigger).toContain('h-11');
    expect(sortTrigger).not.toContain('md:h-9');
    expect(sortTrigger).toContain('Oldest first');
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
    expect(on).toContain('lit-selected');
    const off = dateTrigger('any');
    expect(off).toContain('aria-label="Due date: Any time"');
    expect(off).not.toContain('lit-selected');
  });

  it('fix 9: the page still opens on the Review chip', () => {
    expect(INITIAL_STAGE).toBe('review');
    expect(parsePipelineQuery(new URLSearchParams(), INITIAL_STAGE).stage).toBe('review');
  });

  it('empty copy: one positive line, "Posts show up here."', () => {
    const out = renderToStaticMarkup(emptyPipeline());
    expect(out).toContain('Posts show up here.');
    expect(out).not.toContain('agency');
    expect(out).not.toContain('No posts yet');
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
    expect(
      all(tree).some(
        (el) => text(el) === 'Draft' && (el.type === 'button' || el.type === PressableRow),
      ),
    ).toBe(false);
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
    // The reason is ui/WritingBox in comment mode, with no send of its own:
    // Cancel and Reject stay in the footer.
    const box = all(reject.tree).find((el) => el.type === WritingBox);
    expect(box).toBeDefined();
    const boxProps = box?.props as { mode: string; send?: unknown; input: ReactElement };
    expect(boxProps.mode).toBe('comment');
    expect(boxProps.send).toBeUndefined();
    expect((boxProps.input.props as { id?: string }).id).toBe('r1');
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
