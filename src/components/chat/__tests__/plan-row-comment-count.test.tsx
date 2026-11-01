// U11 (Plan rows): a row with comments shows IconChat and the count under its
// tile (sm, tabular-nums, fg-2, named "{n} comment(s)"); a row with none
// renders nothing there; posts and concepts alike; the tile column stays 56px.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  PlanBody,
  PlanCommentCount,
  commentCountLabel,
  planListGroups,
} from '@/components/chat/PlanScreen';
import type { PlanBundle, PlanItemRow } from '@/lib/chat/plans';

const dir = fileURLToPath(new URL('..', import.meta.url));
const read = (name: string): string => readFileSync(`${dir}${name}`, 'utf8');

function item(over: Partial<PlanItemRow> & { id: string }): PlanItemRow {
  return {
    plan_id: 'plan',
    kind: 'concept',
    position: 0,
    title: 'Reel',
    description: null,
    post_id: null,
    created_at: '2026-10-09T10:00:00Z',
    ...over,
  };
}

const BUNDLE: PlanBundle = {
  plan: {
    id: 'plan',
    workspace_id: 'ws',
    title: 'Week of 12 Oct',
    starts_on: '2026-10-12',
    ends_on: '2026-10-18',
    audience: 'team',
    created_by: 'creator',
  },
  items: [
    item({ id: 'c-talk', target_date: '2026-10-13', position: 0 }),
    item({ id: 'c-quiet', target_date: '2026-10-13', position: 1 }),
    item({ id: 'p1', kind: 'post', title: null, post_id: 'post1', position: 2 }),
  ],
  reviews: [],
  postStages: { post1: 'review' },
  postInfo: { post1: { title: 'Carousel', target_date: '2026-10-15T12:00:00Z' } },
};

function render(counts: Record<string, number>): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <PlanBody
        bundle={BUNDLE}
        groups={planListGroups(BUNDLE, 'UTC', 'agency')}
        side="agency"
        timeZone="UTC"
        thumbs={{}}
        commentCounts={counts}
        drag={null}
        onOpenItem={() => undefined}
        onPlanOk={() => undefined}
        onPlanNotOk={() => undefined}
      />
    </MemoryRouter>,
  );
}

const rowOf = (html: string, id: string): string =>
  new RegExp(`<div data-plan-row-wrap="${id}"[^>]*>[\\s\\S]*?<\\/button>`).exec(html)?.[0] ?? '';

describe('Plan row comment counts (U11)', () => {
  it('the count sits under the tile in the 56px column, for a concept and a post', () => {
    const html = render({ 'c-talk': 2, p1: 1 });
    const talk = rowOf(html, 'c-talk');
    const col = talk.slice(talk.indexOf('data-plan-row-tile-col'));
    expect(col).toContain('w-14');
    expect(col.indexOf('data-plan-row-tile=')).toBeLessThan(col.indexOf('data-plan-comment-count'));
    expect(talk).toContain('aria-label="2 comments"');
    expect(rowOf(html, 'p1')).toContain('aria-label="1 comment"');
  });

  it('0 or missing: nothing renders there (the row height is unchanged)', () => {
    const html = render({ 'c-quiet': 0 });
    expect(rowOf(html, 'c-quiet')).not.toContain('data-plan-comment-count');
    expect(rowOf(html, 'p1')).not.toContain('data-plan-comment-count');
    expect(renderToStaticMarkup(<PlanCommentCount count={0} />)).toBe('');
  });

  it('the count: IconChat at the inline size, sm, tabular-nums, fg-2', () => {
    const html = renderToStaticMarkup(<PlanCommentCount count={4} />);
    expect(html).toContain('text-sm tabular-nums text-fg-2');
    expect(html).toContain('width="16"');
    expect(html).toContain('>4<');
    expect(commentCountLabel(4)).toBe('4 comments');
  });

  it('view and edit mode both pass the Plan screen read counts down to the rows', () => {
    const screen = read('PlanScreen.tsx');
    expect(screen).toContain(
      "commentCounts={read.status === 'ready' ? read.data.commentCounts : {}}",
    );
    expect(screen).toContain('commentCount={props.commentCounts?.[item.id] ?? 0}');
  });
});
