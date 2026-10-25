// X5 fix 5 (FT21): an empty pipeline has a headline and no create button of its
// own (the header's New post is the only one); empty board columns use
// emptyStageMessage, not "Empty".
import { describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', () => ({ useIsLaptop: () => true }));
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyPipeline } from '@/components/pages/PipelinePage';
import { PipelineBoardView } from '@/components/pages/pipeline/PipelineBoard';
import { emptyStageMessage } from '@/components/pages/pipeline/stage-meta';
import { groupByStage } from '@/lib/post-board';
import type { PresignCache } from '@/lib/asset-presign';
import { STAGE_TRANSITIONS, type Stage } from '@srtdio/posts';

const STAGES = Object.keys(STAGE_TRANSITIONS) as Stage[];
const cache = { peek: vi.fn(() => null), resolve: vi.fn() } as unknown as PresignCache;

describe('X5 empty pipeline', () => {
  it('an empty pipeline is the headline only: the header owns the create button', () => {
    const out = renderToStaticMarkup(emptyPipeline());
    expect(out).toContain('Posts show up here.');
    expect(out).not.toContain('Create your first post');
    expect(out).not.toContain('<button');
    expect(out.toLowerCase()).not.toContain('new post');
  });

  it('every empty board column names its stage instead of "Empty"', () => {
    const out = renderToStaticMarkup(
      PipelineBoardView({
        stages: STAGES,
        grouped: groupByStage([], STAGES),
        cap: 6,
        cache,
        presignEnabled: false,
        onViewAll: () => {},
        onMovePost: () => {},
        role: 'owner',
      }),
    );
    for (const stage of STAGES) expect(out).toContain(emptyStageMessage(stage));
    expect(out).not.toMatch(/>Empty</);
  });
});
