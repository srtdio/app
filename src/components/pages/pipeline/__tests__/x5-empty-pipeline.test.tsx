// X5 fix 5 (FT21): an empty pipeline has a headline and, for post.create, a
// "Create your first post" button; empty board columns use emptyStageMessage, not "Empty".
import { describe, expect, it, vi } from 'vitest';
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
  it('people with post.create get a headline and a create button', () => {
    const out = renderToStaticMarkup(emptyPipeline(true));
    expect(out).toContain('No posts yet');
    expect(out).toContain('Create your first post');
    // The header owns the exact "New post" name; no second control shares it.
    expect(out.toLowerCase()).not.toContain('new post');
  });

  it('people without post.create get the headline only', () => {
    const out = renderToStaticMarkup(emptyPipeline(false));
    expect(out).toContain('No posts yet');
    expect(out).not.toContain('Create your first post');
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
