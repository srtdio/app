// Plan rows and calendar (5 Nov 2026): an item with unread comments for the
// viewer shows the comment glyph and the shared CountBadge in place of the grey
// total; with none it shows the grey total exactly as before. A post in no plan
// carries no item id, so it never reads unread.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { PlanCommentCount } from '@/components/chat/PlanScreen';
import { entryUnreadProps } from '@/components/pages/plan-tab/PlanCalendar';
import type { CalendarEntry } from '@/lib/plan-tab';
import { resetSessionReads } from '@/lib/session-read';
import { resetUnreadEntitiesForTest, seedUnreadEntitiesForTest } from '@/lib/inbox/unread-entities';

afterEach(() => {
  resetUnreadEntitiesForTest();
  resetSessionReads();
});

function seed(map: Record<string, number>): void {
  seedUnreadEntitiesForTest({ userId: 'u1', workspaceId: 'w1', map });
}

describe('PlanCommentCount unread', () => {
  it('unread comments replace the grey total with the glyph and the count pill', () => {
    seed({ 'plan_item:i1': 2 });
    const html = renderToStaticMarkup(<PlanCommentCount count={5} itemId="i1" />);
    expect(html).toContain('data-plan-comment-unread="2"');
    expect(html).toContain('aria-label="2 unread comments"');
    expect(html).toContain('data-count-badge=""');
    expect(html).not.toContain('data-plan-comment-count');
  });

  it('no unread: the grey total exactly as before', () => {
    seed({ 'plan_item:other': 3 });
    const html = renderToStaticMarkup(<PlanCommentCount count={4} itemId="i1" />);
    expect(html).toContain('data-plan-comment-count="4"');
    expect(html).toContain('text-sm tabular-nums text-fg-2');
    expect(html).not.toContain('data-plan-comment-unread');
  });

  it('without an item id it never reads unread', () => {
    seed({ 'plan_item:i1': 2 });
    expect(renderToStaticMarkup(<PlanCommentCount count={0} />)).toBe('');
  });

  it('calendar entries pass the item id only for plan items', () => {
    const item = { kind: 'item', item: { id: 'i9' } } as unknown as CalendarEntry;
    const loose = { kind: 'post' } as unknown as CalendarEntry;
    expect(entryUnreadProps(item)).toEqual({ itemId: 'i9' });
    expect(entryUnreadProps(loose)).toEqual({});
  });
});
