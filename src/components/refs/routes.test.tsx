import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Stub supabase so importing the resolvers never spins up a real client. The
// resolution effect does not run under renderToStaticMarkup, so a pretty route
// renders its loading branch without touching the network (matching the pattern
// in AcceptInvitePage.test).
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
// The resolvers still receive the loaded workspaces; resolution is one ref_resolve read.
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaces: [{ id: 'w1', key: 'GBL' }] }),
}));

// The classic detail routes must keep rendering their existing pages. Those pages
// depend on the full provider stack, so here they are stubbed to identifiable
// markers: the assertion is that the router still dispatches /posts/:postId and
// /briefs/:briefId to them, unchanged by the pretty-link work.
vi.mock('@/components/pages/PostDetailPage', () => ({
  PostDetailPage: ({ postId, resolving }: { postId?: string; resolving?: boolean }) => (
    <div>post-detail:{resolving === true ? 'resolving' : (postId ?? 'param')}</div>
  ),
}));
vi.mock('@/components/pages/PlanPage', () => ({
  PlanPage: () => <div>plan-page</div>,
}));
vi.mock('@/components/pages/BriefDetailPage', () => ({
  BriefDetailPage: ({ briefId, resolving }: { briefId?: string; resolving?: boolean }) => (
    <div>brief-detail:{resolving === true ? 'resolving' : (briefId ?? 'param')}</div>
  ),
}));

import { PostDetailPage } from '@/components/pages/PostDetailPage';
import { BriefDetailPage } from '@/components/pages/BriefDetailPage';
import { PlanPage } from '@/components/pages/PlanPage';
import { PostRefResolver } from '@/components/refs/PostRefResolver';
import { BriefRefResolver } from '@/components/refs/BriefRefResolver';
import { refOpenState } from '@/lib/entityRef';

// Mirror the App route table for the four entity routes so classic + pretty forms
// resolve exactly as they do in production.
function render(path: string, state?: unknown): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[state === undefined ? path : { pathname: path, state }]}>
      <Routes>
        <Route path="/posts/:postId" element={<PostDetailPage />} />
        <Route path="/p/:ref" element={<PostRefResolver />} />
        <Route path="/briefs/:briefId" element={<BriefDetailPage />} />
        <Route path="/b/:ref" element={<BriefRefResolver />} />
        <Route path="/plans/:planId" element={<PlanPage fallback="/notifications" />} />
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

  it('mounts the /p/:ref resolver: one loader, the detail page skeleton (no resolver spinner)', () => {
    const html = render('/p/gbl-1');
    expect(html).toContain('post-detail:resolving');
    expect(html).not.toContain('Loading post');
  });

  it('a card open carrying the id for this exact ref renders the post at once (no lookup)', () => {
    expect(render('/p/gbl-1', refOpenState('post', 'GBL', 1, 'p-1'))).toContain('post-detail:p-1');
    // State made for another ref is ignored: the resolver looks the ref up.
    expect(render('/p/gbl-2', refOpenState('post', 'GBL', 1, 'p-1'))).toContain(
      'post-detail:resolving',
    );
  });

  it('mounts the standalone /plans/:planId page (Activity plan rows)', () => {
    expect(render('/plans/plan1?item=i1')).toContain('plan-page');
  });

  it('App declares the /plans/:planId route exactly once', () => {
    const app = readFileSync(fileURLToPath(new URL('../../App.tsx', import.meta.url)), 'utf8');
    // Pages are lazy (React.lazy + Suspense), so the element is a named const.
    expect(app.split('path="/plans/:planId"').length - 1).toBe(1);
    expect(app).toContain('page(<PlanPage fallback="/notifications" />)');
  });

  it('mounts the /b/:ref resolver: one loader, the detail page skeleton', () => {
    const html = render('/b/gbl-1');
    expect(html).toContain('brief-detail:resolving');
    expect(html).not.toContain('Loading brief');
  });
});
