// The Plan tab calendar (U6, U7, U8, U11): comment counts at an item's right
// end (none at 0), 44px month lines and "+N more" on a coarse pointer (22px
// on a fine one, unchanged), the long-press guards on creators' items only,
// and a concept's week card showing its first image.

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { PlanBundle, PlanItemRow, PlanRow } from '@/lib/chat/plans';
import type { CalendarEntry } from '@/lib/plan-tab';

const env = vi.hoisted(() => ({ coarse: false }));
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
  useCoarsePointer: () => env.coarse,
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws', workspaces: [{ id: 'ws', timezone: 'UTC' }] }),
}));
vi.mock('@/components/chat/PlanMoveSheet', () => ({ PlanKeepApprovalSheet: () => null }));
vi.mock('@/components/chat/PlanDayPickerSheet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/chat/PlanDayPickerSheet')>()),
  PlanDayPickerSheet: () => null,
}));
vi.mock('@/components/media/Thumbnail', () => ({ Thumbnail: () => null }));

import {
  PlanCalendar,
  cardCover,
  entryCommentCount,
} from '@/components/pages/plan-tab/PlanCalendar';
import { commentCountLabel } from '@/components/chat/PlanScreen';
import { ToastProvider } from '@/components/ui/toast';
import { civilToday } from '@/lib/plan-week';

const TODAY = civilToday(new Date(), 'UTC');

const PLAN: PlanRow = {
  id: 'p',
  workspace_id: 'ws',
  title: 'Week',
  starts_on: TODAY,
  ends_on: TODAY,
  audience: 'client',
  created_by: null,
};

const concept = (id: string, title: string): PlanItemRow => ({
  id,
  plan_id: 'p',
  kind: 'concept',
  position: 0,
  title,
  description: null,
  post_id: null,
  created_at: '2026-10-01T00:00:00Z',
  target_date: TODAY,
});

const BUNDLE: PlanBundle = {
  plan: PLAN,
  items: [concept('c1', 'Talked about'), concept('c2', 'Quiet one')],
  reviews: [],
  postStages: {},
  postInfo: {},
  commentCounts: { c1: 3 },
};
const THUMBS = { posts: {}, concepts: { c1: { kind: 'image' as const, versionId: 'v-c1' } } };

function render(view: 'month' | 'week', side: 'agency' | 'client'): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ToastProvider>
        <PlanCalendar
          view={view}
          anchor={TODAY}
          today={TODAY}
          timeZone="UTC"
          side={side}
          data={{ bundles: [BUNDLE], posts: [], thumbs: THUMBS }}
          onAnchor={() => {}}
          onWeekOf={() => {}}
          onOpen={() => {}}
          onAddTo={() => {}}
          onNewPlan={() => {}}
          reload={async () => {}}
          more={null}
        />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** One entry's opening tag and contents, up to the next entry. */
function entry(html: string, key: string): string {
  const at = html.indexOf(`data-plan-tab-entry="${key}"`);
  if (at < 0) return '';
  const start = html.lastIndexOf('<button', at);
  return html.slice(start, html.indexOf('</button>', at));
}

describe('comment counts (U11)', () => {
  it('an item with comments shows IconChat and the count, named "3 comments"; 0 shows nothing', () => {
    expect(commentCountLabel(1)).toBe('1 comment');
    expect(commentCountLabel(3)).toBe('3 comments');
    for (const view of ['month', 'week'] as const) {
      const html = render(view, 'client');
      const talked = entry(html, 'item:c1');
      const quiet = entry(html, 'item:c2');
      expect(talked).toContain('aria-label="3 comments"');
      expect(talked).toContain('data-plan-comment-count="3"');
      expect(talked).toContain('tabular-nums');
      expect(quiet).not.toContain('data-plan-comment-count');
    }
  });

  it('entryCommentCount reads the bundle counts; a post in no plan has none', () => {
    const item = {
      kind: 'item',
      bundle: BUNDLE,
      item: BUNDLE.items[0],
    } as unknown as CalendarEntry;
    expect(entryCommentCount(item)).toBe(3);
    expect(entryCommentCount({ kind: 'post' } as unknown as CalendarEntry)).toBe(0);
  });
});

describe('coarse pointer (U6, U7)', () => {
  it('fine pointer: 22px month lines (unchanged), no long-press guards', () => {
    env.coarse = false;
    const html = render('month', 'agency');
    const line = entry(html, 'item:c1');
    expect(line).toContain('min-h-[22px]');
    expect(line).toContain('h-[22px]');
    expect(line).not.toContain('data-plan-tab-holdable');
  });

  it('coarse pointer: 44px month lines; creators get the long-press guards (no callout, no select)', () => {
    env.coarse = true;
    const html = render('month', 'agency');
    const line = entry(html, 'item:c1');
    expect(line).toContain('min-h-[44px]');
    expect(line).not.toContain('h-[22px]');
    expect(line).toContain('data-plan-tab-holdable');
    expect(line).toContain('select-none');
    expect(line).toContain('[-webkit-touch-callout:none]');
    env.coarse = false;
  });

  it('coarse pointer, approvers: 44px lines, no long-press', () => {
    env.coarse = true;
    const line = entry(render('month', 'client'), 'item:c1');
    expect(line).toContain('min-h-[44px]');
    expect(line).not.toContain('data-plan-tab-holdable');
    env.coarse = false;
  });
});

describe("a concept's week card shows its first image (U8)", () => {
  it('cardCover: the concept image tile; a file-only concept keeps the soft tile', () => {
    const c1 = { kind: 'item', bundle: BUNDLE, item: BUNDLE.items[0] } as unknown as CalendarEntry;
    const c2 = { kind: 'item', bundle: BUNDLE, item: BUNDLE.items[1] } as unknown as CalendarEntry;
    expect(cardCover(c1, THUMBS)).toBe('v-c1');
    expect(cardCover(c2, THUMBS)).toBeNull();
    expect(cardCover(c2, { posts: {}, concepts: { c2: { kind: 'file' } } })).toBeNull();
  });
});
