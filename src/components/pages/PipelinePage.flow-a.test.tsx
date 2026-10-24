// @vitest-environment jsdom
// Post flow A: /pipeline?new=1&brief=<id> opens the New post sheet on that
// brief (fix 23), and a saved post lands on its own page (fix 24).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreatedOutcome } from '@/components/pages/CreatePostSheet';

interface SheetProps {
  open: boolean;
  workspaceId: string | null;
  initialBriefId?: string;
  onClose: () => void;
  onCreated: (postId: string, outcome?: CreatedOutcome) => void;
}

const h = vi.hoisted(() => ({
  params: new URLSearchParams(),
  setParams: vi.fn(),
  navigate: vi.fn(),
  sheet: null as SheetProps | null,
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => h.navigate,
  useSearchParams: () => [h.params, h.setParams],
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1', workspaceKey: 'KITE', workspaces: [] }),
}));
vi.mock('@/lib/session-context', () => ({ useSession: () => ({ session: null }) }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => true }));
vi.mock('@/lib/workspace-context-capability', () => ({ useWorkspaceCapability: () => true }));
vi.mock('@/lib/use-sort', () => ({ useSort: () => ({ value: '', setValue: () => {} }) }));
vi.mock('@/lib/use-workspace-data-changed', () => ({ useWorkspaceDataChanged: () => {} }));
vi.mock('@/lib/shared-presign', () => ({ appPresignCache: () => ({}) }));
vi.mock('@/components/induction/InductionProvider', () => ({
  useInductionPostPreset: () => undefined,
}));
vi.mock('@/lib/use-undoable-action', async (orig) => ({
  ...(await orig<typeof import('@/lib/use-undoable-action')>()),
  useUndoableAction: () => ({ run: () => {} }),
}));
vi.mock('@srtdio/posts', async (orig) => ({
  ...(await orig<typeof import('@srtdio/posts')>()),
  listPosts: async () => ({ ok: true, data: [] }),
}));
vi.mock('@/components/pages/pipeline/PipelineBoard', () => ({ PipelineBoard: () => null }));
vi.mock('@/components/pages/pipeline/PipelineFeed', () => ({ PipelineFeed: () => null }));
vi.mock('@/components/pages/pipeline/MoveSheet', () => ({ MoveSheet: () => null }));
vi.mock('@/components/pages/pipeline/StageChips', () => ({ StageChips: () => null }));
vi.mock('@/components/pages/pipeline/PipelineSortControl', () => ({
  PipelineSortControl: () => null,
  PipelineFilterControl: () => null,
  PipelineDateControl: () => null,
  customRangeLabel: () => '',
}));
vi.mock('@/components/pages/pipeline/use-workspace-people', () => ({
  useWorkspacePeople: () => ({ approverFirstNames: [], names: new Map() }),
}));
vi.mock('@/components/pages/CreatePostSheet', () => ({
  CreatePostSheet: (props: SheetProps) => {
    h.sheet = props;
    return null;
  },
}));

import { PipelinePage } from '@/components/pages/PipelinePage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  h.params = new URLSearchParams();
  h.setParams.mockReset();
  h.navigate.mockReset();
  h.sheet = null;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = '';
});

async function renderPage(): Promise<void> {
  await act(async () => {
    root!.render(<PipelinePage />);
  });
}

describe('PipelinePage flow A', () => {
  it('fix 23: ?new=1&brief=b1 opens the New post sheet on that brief and drops the query', async () => {
    h.params = new URLSearchParams('stage=draft&new=1&brief=b1');
    await renderPage();
    expect(h.sheet?.open).toBe(true);
    expect(h.sheet?.initialBriefId).toBe('b1');
    expect(h.setParams).toHaveBeenCalled();
    const [next, opts] = h.setParams.mock.calls[0] as [URLSearchParams, { replace: boolean }];
    expect(next.get('new')).toBeNull();
    expect(next.get('brief')).toBeNull();
    expect(next.get('stage')).toBe('draft');
    expect(opts).toEqual({ replace: true });
  });

  it('fix 23: without ?new the sheet stays closed and has no brief', async () => {
    await renderPage();
    expect(h.sheet?.open).toBe(false);
    expect(h.sheet?.initialBriefId).toBeUndefined();
  });

  it('fix 23: the Create event opens the sheet with no brief', async () => {
    await renderPage();
    await act(async () => {
      window.dispatchEvent(new Event('sorted:create-post'));
    });
    expect(h.sheet?.open).toBe(true);
    expect(h.sheet?.initialBriefId).toBeUndefined();
  });

  it("fix 24: a saved post closes the sheet and lands on the outcome's path", async () => {
    h.params = new URLSearchParams('new=1');
    await renderPage();
    expect(h.sheet?.open).toBe(true);
    await act(async () => h.sheet?.onCreated('p1', { stage: 'draft', path: '/p/kite-12' }));
    expect(h.navigate).toHaveBeenCalledWith('/p/kite-12');
    expect(h.sheet?.open).toBe(false);
  });

  it('fix 24: the first-post preset (no outcome) stays on the pipeline', async () => {
    h.params = new URLSearchParams('new=1');
    await renderPage();
    await act(async () => h.sheet?.onCreated('p1'));
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.sheet?.open).toBe(false);
  });
});
