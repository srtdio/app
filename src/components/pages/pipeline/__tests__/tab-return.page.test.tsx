// @vitest-environment jsdom
// Pipeline tab return, page level: the posts this session last read or wrote
// paint on the first render at any age, with no skeleton. Inside the freshness
// window that is all (no request); past it the board refreshes quietly and the
// new posts land only while the person has not touched the board (else they
// are kept for the next visit). The board's own move updates the kept posts.
// The first visit shows the skeleton and reads once.
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
  onMovePost: null as null | ((postId: string, toStage: string) => void),
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
  PipelineBoard: (props: {
    grouped: Record<string, unknown[]>;
    onMovePost: (postId: string, toStage: string) => void;
  }) => {
    h.boards.push(props.grouped);
    h.onMovePost = props.onMovePost;
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

import { PipelinePage, shownPipelineQuery } from '@/components/pages/PipelinePage';
import type { PipelineQuery } from '@/components/pages/pipeline/pipeline-query';
import { keptPipelinePosts } from '@/lib/pipeline-posts';
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

  function holdNextRead(): (value: unknown) => void {
    let land: (value: unknown) => void = () => {};
    h.listPosts.mockImplementation(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    );
    return (value) => land(value);
  }

  it('first visit: the skeleton shows until the read lands', async () => {
    const land = holdNextRead();
    await visit();
    expect(skeleton()).not.toBeNull();
    await act(async () => land({ ok: true, data: OLD }));
    expect(skeleton()).toBeNull();
    expect(lastBoardIds()).toEqual(['old']);
  });

  it('past the window: the kept posts paint at once, then the quiet refresh lands', async () => {
    h.listPosts.mockResolvedValue({ ok: true, data: OLD });
    await visit();
    leave();
    vi.setSystemTime(Date.now() + READ_FRESH_MS + 1_000);
    h.boards = [];
    const land = holdNextRead();
    await visit();
    expect(skeleton()).toBeNull();
    expect(lastBoardStage('old')).toBe('review');
    await act(async () => land({ ok: true, data: NEW }));
    expect(skeleton()).toBeNull();
    expect(lastBoardStage('old')).toBe('approved');
    expect(h.listPosts).toHaveBeenCalledTimes(2);
  });

  it('a refresh that lands after a touch is held for the next visit', async () => {
    h.listPosts.mockResolvedValue({ ok: true, data: OLD });
    await visit();
    leave();
    vi.setSystemTime(Date.now() + READ_FRESH_MS + 1_000);
    const land = holdNextRead();
    await visit();
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    await act(async () => land({ ok: true, data: NEW }));
    // The view under the finger never moves.
    expect(lastBoardStage('old')).toBe('review');
    expect(keptPipelinePosts('u1', 'ws-1')?.[0]?.stage).toBe('approved');
    leave();
    h.boards = [];
    await visit();
    expect(lastBoardStage('old')).toBe('approved');
  });

  it('a failed quiet refresh keeps the kept posts, with no load error', async () => {
    h.listPosts.mockResolvedValue({ ok: true, data: OLD });
    await visit();
    leave();
    vi.setSystemTime(Date.now() + READ_FRESH_MS + 1_000);
    h.listPosts.mockResolvedValue({ ok: false, error: { code: 'unknown', message: 'boom' } });
    await visit();
    expect(document.querySelector('[data-posts-load-error]')).toBeNull();
    expect(lastBoardIds()).toEqual(['old']);
  });

  it("the board's own move updates the kept posts, never drops them", async () => {
    h.listPosts.mockResolvedValue({ ok: true, data: OLD });
    await visit();
    await act(async () => h.onMovePost?.('old', 'parked'));
    expect(lastBoardStage('old')).toBe('parked');
    expect(keptPipelinePosts('u1', 'ws-1')?.[0]?.stage).toBe('parked');
    leave();
    h.boards = [];
    await visit();
    expect(skeleton()).toBeNull();
    expect(lastBoardStage('old')).toBe('parked');
    // The move was kept as a fresh read: the return asked nothing.
    expect(h.listPosts).toHaveBeenCalledTimes(1);
  });
});

describe('shownPipelineQuery', () => {
  const kept: PipelineQuery = {
    stage: 'approved',
    search: 'launch',
    dateWindow: 'any',
    customRange: null,
  };

  it('a clean URL (a tab return) lands on the kept chip and filter, never the kept search', () => {
    expect(shownPipelineQuery(new URLSearchParams(''), kept)).toEqual({ ...kept, search: '' });
  });

  it('a URL that names a filter wins; nothing kept opens Review', () => {
    expect(shownPipelineQuery(new URLSearchParams('stage=parked'), kept).stage).toBe('parked');
    expect(shownPipelineQuery(new URLSearchParams(''), null).stage).toBe('review');
  });
});
