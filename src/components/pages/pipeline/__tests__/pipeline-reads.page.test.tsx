// @vitest-environment jsdom
// Pipeline reads, page level: each read the page owns runs once per load and is
// shared by every consumer. listPosts once; the cover request once per id set
// (a re-sort or a plain re-render never asks again); the members read once,
// with the board and the move sheet handed the page's approvers instead of
// each reading their own.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
import type { PipelinePost } from '@srtdio/posts';

const h = vi.hoisted(() => ({
  params: new URLSearchParams('stage=all'),
  sort: '',
  posts: [] as PipelinePost[],
  listPosts: vi.fn(),
  requestPostCovers: vi.fn(async (): Promise<void> => {}),
  people: {
    approverFirstNames: ['Riya'],
    names: new Map<string, string>([['u2', 'Riya Menon']]),
    approvers: [{ userId: 'u2', name: 'Riya Menon' }],
  },
  peopleCalls: 0,
  boardApprovers: [] as unknown[],
  sheetApprovers: [] as unknown[],
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => () => {},
  useSearchParams: () => [h.params, () => {}],
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1', workspaceKey: 'KITE', workspaces: [] }),
}));
vi.mock('@/lib/session-context', () => ({ useSession: () => ({ session: null }) }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/workspace-context-capability', () => ({ useWorkspaceCapability: () => true }));
vi.mock('@/lib/use-sort', () => ({ useSort: () => ({ value: h.sort, setValue: () => {} }) }));
vi.mock('@/lib/use-workspace-data-changed', () => ({ useWorkspaceDataChanged: () => {} }));
vi.mock('@/lib/shared-presign', () => ({ appPresignCache: () => ({}) }));
vi.mock('@/lib/chat/post-covers', () => ({
  usePostCovers: () => () => undefined,
  requestPostCovers: h.requestPostCovers,
}));
vi.mock('@/components/pages/pipeline/use-workspace-people', () => ({
  useWorkspacePeople: () => {
    h.peopleCalls += 1;
    return h.people;
  },
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
  PipelineBoard: (props: { approvers?: unknown }) => {
    h.boardApprovers.push(props.approvers);
    return null;
  },
}));
vi.mock('@/components/pages/pipeline/PipelineFeed', () => ({ PipelineFeed: () => null }));
vi.mock('@/components/pages/pipeline/MoveSheet', () => ({
  MoveSheet: (props: { approvers?: unknown }) => {
    h.sheetApprovers.push(props.approvers);
    return null;
  },
}));
vi.mock('@/components/pages/pipeline/StageChips', () => ({ StageChips: () => null }));
vi.mock('@/components/pages/pipeline/PipelineSortControl', () => ({
  PipelineSortControl: () => null,
  PipelineFilterControl: () => null,
  PipelineDateControl: () => null,
  customRangeLabel: () => '',
}));
vi.mock('@/components/pages/CreatePostSheet', () => ({ CreatePostSheet: () => null }));

import { PipelinePage, coverIdsKey } from '@/components/pages/PipelinePage';
import { x5Post } from './x5-fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const POSTS = [
  x5Post({ id: 'b', title: 'Recap reel', updated_at: '2026-01-02T00:00:00Z' }),
  x5Post({ id: 'a', title: 'Launch teaser', updated_at: '2026-01-03T00:00:00Z' }),
  x5Post({ id: 'c', title: 'Behind the scenes', updated_at: '2026-01-01T00:00:00Z' }),
];

beforeEach(() => {
  h.sort = '';
  h.posts = POSTS;
  h.listPosts.mockReset();
  h.listPosts.mockImplementation(async () => ({ ok: true, data: h.posts }));
  h.requestPostCovers.mockClear();
  h.peopleCalls = 0;
  h.boardApprovers = [];
  h.sheetApprovers = [];
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

async function render(): Promise<void> {
  await act(async () => {
    root!.render(<PipelinePage />);
  });
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('coverIdsKey', () => {
  it('is the distinct ids, sorted: display order never changes it', () => {
    expect(coverIdsKey([{ id: 'b' }, { id: 'a' }, { id: 'b' }])).toBe('a,b');
    expect(coverIdsKey([{ id: 'a' }, { id: 'b' }])).toBe(coverIdsKey([{ id: 'b' }, { id: 'a' }]));
    expect(coverIdsKey([])).toBe('');
  });
});

describe('pipeline reads: once per load, shared by every consumer', () => {
  it('reads the posts once and asks for the covers once, for every id', async () => {
    await render();
    expect(h.listPosts).toHaveBeenCalledTimes(1);
    expect(h.requestPostCovers).toHaveBeenCalledTimes(1);
    const ids = h.requestPostCovers.mock.calls[0] as unknown as [unknown, string, string[]];
    expect(ids[1]).toBe('ws-1');
    expect([...ids[2]].sort()).toEqual(['a', 'b', 'c']);
  });

  it('a re-sort or a plain re-render never asks for the covers again', async () => {
    await render();
    expect(h.requestPostCovers).toHaveBeenCalledTimes(1);
    // Same posts, new display order.
    h.sort = 'oldest';
    await render();
    await render();
    expect(h.requestPostCovers).toHaveBeenCalledTimes(1);
    expect(h.listPosts).toHaveBeenCalledTimes(1);
  });

  it('the board and the move sheet get the page approvers (one members read, not three)', async () => {
    await render();
    // The page is the only reader of the members (the mocked hook stands in for
    // the one listMembers + readProfiles pair).
    expect(h.peopleCalls).toBeGreaterThan(0);
    expect(h.boardApprovers.length).toBeGreaterThan(0);
    expect(h.sheetApprovers.length).toBeGreaterThan(0);
    for (const approvers of [...h.boardApprovers, ...h.sheetApprovers]) {
      expect(approvers).toBe(h.people.approvers);
    }
  });
});
