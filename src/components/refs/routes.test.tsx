import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Stub supabase so importing the resolvers never spins up a real client. The
// resolution effect does not run under renderToStaticMarkup, so a pretty route
// renders its loading branch without touching the network (matching the pattern
// in AcceptInvitePage.test).
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

// The classic detail routes must keep rendering their existing pages. Those pages
// depend on the full provider stack, so here they are stubbed to identifiable
// markers: the assertion is that the router still dispatches /posts/:postId and
// /briefs/:briefId to them, unchanged by the pretty-link work.
vi.mock('@/components/pages/PostDetailPage', () => ({
  PostDetailPage: ({ postId }: { postId?: string }) => <div>post-detail:{postId ?? 'param'}</div>,
}));
vi.mock('@/components/pages/BriefDetailPage', () => ({
  BriefDetailPage: ({ briefId }: { briefId?: string }) => (
    <div>brief-detail:{briefId ?? 'param'}</div>
  ),
}));

import { PostDetailPage } from '@/components/pages/PostDetailPage';
import { BriefDetailPage } from '@/components/pages/BriefDetailPage';
import { PostRefResolver } from '@/components/refs/PostRefResolver';
import { BriefRefResolver } from '@/components/refs/BriefRefResolver';

// Mirror the App route table for the four entity routes so classic + pretty forms
// resolve exactly as they do in production.
function render(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/posts/:postId" element={<PostDetailPage />} />
        <Route path="/p/:ref" element={<PostRefResolver />} />
        <Route path="/briefs/:briefId" element={<BriefDetailPage />} />
        <Route path="/b/:ref" element={<BriefRefResolver />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('entity route regression', () => {
  it('still renders the classic /posts/:postId route', () => {
    expect(render('/posts/p1')).toContain('post-detail:param');
  });

  it('still renders the classic /briefs/:briefId route', () => {
    expect(render('/briefs/b1')).toContain('brief-detail:param');
  });

  it('mounts the /p/:ref resolver (loading before resolution)', () => {
    expect(render('/p/gbl-1')).toContain('Loading post');
  });

  it('mounts the /b/:ref resolver (loading before resolution)', () => {
    expect(render('/b/gbl-1')).toContain('Loading brief');
  });
});
