// X5 fix 8 (FT3): a failed posts read shows ui/LoadError ("Couldn't load
// posts.") with a Retry that re-runs the read; the raw error never shows.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', () => ({ useIsLaptop: () => true }));
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { postsLoadError } from '@/components/pages/PipelinePage';
import { LoadError } from '@/components/ui/LoadError';

function find(node: ReactNode, match: (el: ReactElement) => boolean): ReactElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, match);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (typeof node !== 'object' || node === null || !('props' in node)) return undefined;
  const el = node as ReactElement;
  if (match(el)) return el;
  return find((el.props as { children?: ReactNode }).children, match);
}

describe('X5 pipeline load error', () => {
  it('shows the plain line and Retry, and no raw text', () => {
    const out = renderToStaticMarkup(postsLoadError(() => {}, false));
    expect(out).toContain('Couldn&#x27;t load posts.');
    expect(out).toContain('Retry');
    expect(out).not.toContain('Could not load posts');
    expect(out).not.toMatch(/permission denied|PGRST|Failed to fetch/i);
  });

  it('Retry re-runs the read', () => {
    const reload = vi.fn();
    const tree = postsLoadError(reload, false);
    const loadError = find(tree, (el) => el.type === LoadError)!;
    (loadError.props as { onRetry: () => void }).onRetry();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the page never interpolates the raw read error', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../PipelinePage.tsx', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('Could not load posts.');
    expect(source).not.toContain('result.error.message');
    expect(source).toContain('postsLoadError(');
  });
});
