// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', () => ({ useIsLaptop: () => true }));
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { PipelineBoardView } from '@/components/pages/pipeline/PipelineBoard';
import { filterControlBody } from '@/components/pages/pipeline/PipelineSortControl';
import { BOARD_CAP, stageLabel } from '@/components/pages/pipeline/stage-meta';
import { groupByStage } from '@/lib/post-board';
import { STAGE_TRANSITIONS } from '@srtdio/posts';
import type { PipelinePost, Stage } from '@srtdio/posts';
import type { PresignCache } from '@/lib/asset-presign';

// Type roles on the Pipeline page (design rules, 24 Oct 2026): the board's
// column header is a row title (base/500) with its count as meta (sm, fg-3),
// cards carry a base/500 title, and the filter sheet's "Due date" / "Sort"
// headings are section labels (sm/600 uppercase tracking-[0.06em] fg-2).

const STAGES = Object.keys(STAGE_TRANSITIONS) as Stage[];
const cache = {} as unknown as PresignCache;

function makePost(id: string, stage: Stage): PipelinePost {
  return {
    id,
    workspace_id: 'w',
    number: 1,
    title: `Post ${id}`,
    stage,
    platform: 'instagram',
    format: 'reel',
    origin: 'manual',
    legacy_author_name: null,
    caption: null,
    brief_id: null,
    bucket_id: null,
    owner_user_id: 'u',
    created_by: 'u',
    target_date: null,
    deleted_at: null,
    row_version: 1,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    stage_entered_at: '2026-01-01',
    approved_by: null,
    approved_on_behalf_of: null,
    approved_at: null,
    thumbnailAssetVersionId: null,
  };
}

function paintBoard(posts: PipelinePost[]): HTMLDivElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    <MemoryRouter>
      {PipelineBoardView({
        stages: STAGES,
        grouped: groupByStage(posts, STAGES),
        cap: BOARD_CAP,
        cache,
        presignEnabled: false,
        onViewAll: () => {},
        onMovePost: () => {},
        role: 'agency',
      })}
    </MemoryRouter>,
  );
  return host;
}

function paintFilter(): HTMLDivElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    filterControlBody({
      order: 'target',
      onOrderChange: () => {},
      dateWindow: 'month',
      onDateWindowChange: () => {},
      customRange: null,
      onCustomOpen: () => {},
    }),
  );
  return host;
}

/** The deepest element whose trimmed text is exactly `text`. */
function byText(scope: Element, text: string): HTMLElement {
  const matches = [...scope.querySelectorAll<HTMLElement>('*')].filter(
    (el) => el.textContent?.trim() === text,
  );
  const el = matches[matches.length - 1];
  if (el === undefined) throw new Error(`no element with text "${text}"`);
  return el;
}

function classes(el: Element | null): string[] {
  return (el?.getAttribute('class') ?? '').split(/\s+/);
}

describe('Pipeline page type roles', () => {
  it('column header: stage name is a row title, its count is meta', () => {
    const host = paintBoard([makePost('a', 'review'), makePost('b', 'review')]);
    const column = host.querySelector('[data-stage="review"]');
    expect(column).not.toBeNull();
    const name = byText(column!, stageLabel('review'));
    expect(classes(name)).toEqual(expect.arrayContaining(['text-base', 'font-medium']));
    const count = byText(name.parentElement!, '2');
    expect(classes(count)).toEqual(expect.arrayContaining(['text-sm', 'text-fg-3']));
  });

  it('card title: text-base font-medium', () => {
    const host = paintBoard([makePost('a', 'draft')]);
    expect(classes(byText(host, 'Post a'))).toEqual(
      expect.arrayContaining(['text-base', 'font-medium']),
    );
  });

  it('filter headings are section labels', () => {
    const host = paintFilter();
    for (const label of ['Due date', 'Sort']) {
      expect(classes(byText(host, label))).toEqual(
        expect.arrayContaining([
          'text-sm',
          'font-semibold',
          'uppercase',
          'tracking-[0.06em]',
          'text-fg-2',
        ]),
      );
    }
  });

  it('renders no off-scale type classes', () => {
    const html = paintBoard([makePost('a', 'draft')]).innerHTML + paintFilter().innerHTML;
    expect(html).not.toMatch(/text-legacy-|text-\[\d|leading-\[\d|font-bold|font-\[/);
  });
});
