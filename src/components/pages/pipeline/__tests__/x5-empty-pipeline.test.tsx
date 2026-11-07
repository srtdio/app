// X5 fix 5 (FT21): an empty pipeline has a headline and no create button of its
// own (the header's New post is the only one); an empty stage chip uses
// emptyStageMessage, not "Empty".
import { describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyPipeline } from '@/components/pages/PipelinePage';
import { PipelineFeed } from '@/components/pages/pipeline/PipelineFeed';
import { emptyStageMessage } from '@/components/pages/pipeline/stage-meta';
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

  it('every empty stage names its stage instead of "Empty"', () => {
    for (const stage of STAGES) {
      const out = renderToStaticMarkup(
        <PipelineFeed
          posts={[]}
          activeStage={stage}
          cache={cache}
          presignEnabled={false}
          onLongPressPost={() => {}}
        />,
      );
      expect(out).toContain(emptyStageMessage(stage));
      expect(out).not.toMatch(/>Empty</);
    }
  });
});
