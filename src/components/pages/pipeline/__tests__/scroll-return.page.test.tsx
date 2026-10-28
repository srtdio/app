// @vitest-environment jsdom
// B4, Back from a post to Pipeline: the board's kept scroll position is in
// place in the FIRST committed frame (a layout effect, before the browser
// paints), not after the quiet refresh, covers or images land. A probe's
// layout effect, which runs after the page's in the same commit and before
// paint, reads the shell scroller.
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
import type { PipelinePost } from '@srtdio/posts';

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

import { PipelinePage } from '@/components/pages/PipelinePage';
import { keptViewKey } from '@/lib/kept-view';
import { primeRead, resetSessionReads } from '@/lib/session-read';
import { x5Post } from './x5-fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let main: HTMLElement;
let firstFrameTop: number | null = null;

const POSTS: PipelinePost[] = [x5Post({ id: 'p1', title: 'One', stage: 'review' })];
const SCROLL_KEY = keptViewKey('u1', 'ws-1', 'pipeline:scroll');

function FirstFrameProbe() {
  useLayoutEffect(() => {
    if (firstFrameTop === null) firstFrameTop = main.scrollTop;
  }, []);
  return null;
}

async function visit(): Promise<void> {
  const host = document.createElement('div');
  main.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <>
        <PipelinePage />
        <FirstFrameProbe />
      </>,
    );
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
  main.innerHTML = '';
}

beforeEach(() => {
  resetSessionReads();
  h.boards = [];
  h.listPosts.mockReset();
  firstFrameTop = null;
  main = document.createElement('main');
  let top = 0;
  Object.defineProperty(main, 'scrollTop', {
    get: () => top,
    set: (next: number) => {
      top = next;
    },
  });
  document.body.appendChild(main);
});

afterEach(() => {
  leave();
  document.body.innerHTML = '';
});

describe('Pipeline Back restores the scroll in the first committed frame', () => {
  it('kept posts and a kept position: scrollTop is set before the first paint', async () => {
    h.listPosts.mockResolvedValue({ ok: true, data: POSTS });
    await visit();
    leave();
    primeRead(SCROLL_KEY, 1_240);
    firstFrameTop = null;
    // The quiet refresh is held: the restore must not wait for it.
    h.listPosts.mockImplementation(() => new Promise(() => {}));
    main.scrollTop = 0;
    await visit();
    expect(document.querySelector('[data-posts-skeleton]')).toBeNull();
    expect(firstFrameTop).toBe(1_240);
  });

  it('nothing kept: the first frame stays at the top', async () => {
    h.listPosts.mockImplementation(() => new Promise(() => {}));
    await visit();
    expect(firstFrameTop).toBe(0);
  });
});
