// @vitest-environment jsdom
// Pipeline tab return, page level: posts this session read inside the
// freshness window paint on the first render with no request; past the window
// (the stale guard) the board shows its skeleton and reads again, never the
// older posts. The first visit's read is one request.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
import type { PipelinePost, Stage } from '@srtdio/posts';

const h = vi.hoisted(() => ({
  listPosts: vi.fn(),
  boards: [] as Array<Record<string, unknown[]>>,
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => () => {},
  useSearchParams: () => [new URLSearchParams('stage=all'), () => {}],
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1', workspaceKey: 'KITE', workspaces: [] }),
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'u1' } } }),
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/workspace-context-capability', () => ({ useWorkspaceCapability: () => true }));
vi.mock('@/lib/use-sort', () => ({ useSort: () => ({ value: '', setValue: () => {} }) }));
vi.mock('@/lib/use-workspace-data-changed', () => ({ useWorkspaceDataChanged: () => {} }));
vi.mock('@/lib/shared-presign', () => ({ appPresignCache: () => ({}) }));
vi.mock('@/lib/chat/post-covers', () => ({
  usePostCovers: () => () => undefined,
  requestPostCovers: async () => {},
  primeCovers: () => {},
}));
vi.mock('@/components/pages/pipeline/use-workspace-people', () => ({
  useWorkspacePeople: () => ({ approverFirstNames: [], names: new Map(), approvers: [] }),
}));
vi.mock('@/components/induction/InductionProvider', () => ({
  useInductionPostPreset: () => undefined,
}));
vi.mock('@/lib/use-undoable-action', async (orig) => ({
  ...(await orig<typeof import('@/lib/use-undoable-action')>()),
  useUndoableAction: () => ({ run: () => {} }),
}));
vi.mock('@srtdio/posts', async (orig) => ({
  ...(await orig<typeof import('@srtdio/posts')>()),
  listPosts: h.listPosts,
}));
vi.mock('@/components/pages/pipeline/member-role', async (orig) => ({
  ...(await orig<typeof import('@/components/pages/pipeline/member-role')>()),
  readMemberRole: async () => ({ ok: true, role: 'agency' }),
}));
vi.mock('@/components/pages/pipeline/PipelineBoard', () => ({
  PipelineBoard: (props: { grouped: Record<string, unknown[]> }) => {
    h.boards.push(props.grouped);
    return null;
  },
}));
vi.mock('@/components/pages/pipeline/PipelineFeed', () => ({ PipelineFeed: () => null }));
vi.mock('@/components/pages/pipeline/MoveSheet', () => ({ MoveSheet: () => null }));
vi.mock('@/components/pages/pipeline/StageChips', () => ({ StageChips: () => null }));
vi.mock('@/components/pages/pipeline/PipelineSortControl', () => ({
  PipelineSortControl: () => null,
  PipelineFilterControl: () => null,
  PipelineDateControl: () => null,
  customRangeLabel: () => '',
}));
vi.mock('@/components/pages/CreatePostSheet', () => ({ CreatePostSheet: () => null }));

import { PipelinePage } from '@/components/pages/PipelinePage';
import { READ_FRESH_MS, resetSessionReads } from '@/lib/session-read';
import { x5Post } from './x5-fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

const OLD: PipelinePost[] = [x5Post({ id: 'old', title: 'Old title', stage: 'review' })];
const NEW: PipelinePost[] = [x5Post({ id: 'old', title: 'New title', stage: 'approved' })];

const skeleton = (): Element | null => document.querySelector('[data-posts-skeleton]');
const lastBoardIds = (): string[] => {
  const grouped = h.boards[h.boards.length - 1] ?? {};
  return Object.values(grouped).flatMap((list) => (list as PipelinePost[]).map((p) => p.id));
};
const lastBoardStage = (id: string): Stage | undefined => {
  const grouped = h.boards[h.boards.length - 1] ?? {};
  for (const [stage, list] of Object.entries(grouped)) {
    if ((list as PipelinePost[]).some((p) => p.id === id)) return stage as Stage;
  }
  return undefined;
};

async function visit(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<PipelinePage />);
  });
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function leave(): void {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-26T10:00:00Z'));
  resetSessionReads();
  h.boards = [];
  h.listPosts.mockReset();
});

afterEach(() => {
  leave();
  vi.useRealTimers();
});

describe('Pipeline tab return', () => {
  it('first visit: one posts request', async () => {
    h.listPosts.mockResolvedValue({ ok: true, data: OLD });
    await visit();
    expect(h.listPosts).toHaveBeenCalledTimes(1);
    expect(lastBoardIds()).toEqual(['old']);
  });

  it('inside the window: the kept posts paint at once, no request, no skeleton', async () => {
    h.listPosts.mockResolvedValue({ ok: true, data: OLD });
    await visit();
    leave();
    vi.setSystemTime(Date.now() + READ_FRESH_MS - 1_000);
    h.boards = [];
    await act(async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      root.render(<PipelinePage />);
    });
    expect(skeleton()).toBeNull();
    expect(lastBoardIds()).toEqual(['old']);
    expect(h.listPosts).toHaveBeenCalledTimes(1);
  });

  it('past the window: skeleton first, then the new read, never the older posts', async () => {
    h.listPosts.mockResolvedValue({ ok: true, data: OLD });
    await visit();
    leave();
    vi.setSystemTime(Date.now() + READ_FRESH_MS + 1_000);
    h.boards = [];
    let land: (value: unknown) => void = () => {};
    h.listPosts.mockImplementation(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    );
    await visit();
    expect(skeleton()).not.toBeNull();
    // The older posts never reached the board.
    expect(h.boards).toHaveLength(0);
    await act(async () => land({ ok: true, data: NEW }));
    expect(skeleton()).toBeNull();
    expect(lastBoardStage('old')).toBe('approved');
    expect(h.listPosts).toHaveBeenCalledTimes(2);
  });
});
