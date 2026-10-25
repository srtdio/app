// @vitest-environment jsdom
// Post flow C, page level: a workspace switch never shows the old workspace's
// posts (skeleton until its own read lands, a late read of the old workspace
// is dropped), and the narrowing count plus the undated hint show only while a
// search or date filter is on. The board is stubbed to record what it is given.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
import type { PipelinePost, Result } from '@srtdio/posts';

interface PendingRead {
  workspaceId: string;
  resolve: (result: Result<PipelinePost[]>) => void;
}

const h = vi.hoisted(() => ({
  params: new URLSearchParams(),
  workspaceId: 'ws-1' as string | null,
  reads: [] as PendingRead[],
  /** The post ids the board was handed, one entry per board render. */
  boards: [] as string[][],
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => () => {},
  useSearchParams: () => [h.params, () => {}],
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: h.workspaceId, workspaceKey: 'KITE', workspaces: [] }),
}));
vi.mock('@/lib/session-context', () => ({ useSession: () => ({ session: null }) }));
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
  listPosts: (_client: unknown, input: { workspaceId: string }) =>
    new Promise<Result<PipelinePost[]>>((resolve) => {
      h.reads.push({ workspaceId: input.workspaceId, resolve });
    }),
}));
vi.mock('@/components/pages/pipeline/PipelineBoard', () => ({
  PipelineBoard: (props: { grouped: Record<string, PipelinePost[]> }) => {
    h.boards.push(
      Object.values(props.grouped)
        .flat()
        .map((post) => post.id),
    );
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
import { x5Post } from './x5-fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  h.params = new URLSearchParams();
  h.workspaceId = 'ws-1';
  h.reads = [];
  h.boards = [];
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
}

/** Resolve the pending read for a workspace with these posts. */
async function land(workspaceId: string, posts: PipelinePost[]): Promise<void> {
  const read = h.reads.find((r) => r.workspaceId === workspaceId);
  expect(read).toBeDefined();
  await act(async () => {
    read!.resolve({ ok: true, data: posts });
  });
}

function skeleton(): Element | null {
  return host!.querySelector('[data-posts-skeleton]');
}

const OLD = [x5Post({ id: 'old-1', workspace_id: 'ws-1', stage: 'review' })];
const NEW = [x5Post({ id: 'new-1', workspace_id: 'ws-2', stage: 'review' })];

describe('post flow C: workspace switch', () => {
  it('workspace switch: the old posts never render; the skeleton shows until the new read lands', async () => {
    await render();
    await land('ws-1', OLD);
    expect(h.boards.at(-1)).toEqual(['old-1']);

    const before = h.boards.length;
    h.workspaceId = 'ws-2';
    await render();
    // The new read is in flight: skeleton, and no board render since the switch.
    expect(h.reads.map((r) => r.workspaceId)).toEqual(['ws-1', 'ws-2']);
    expect(skeleton()).not.toBeNull();
    expect(h.boards.slice(before)).toEqual([]);

    await land('ws-2', NEW);
    expect(skeleton()).toBeNull();
    expect(h.boards.at(-1)).toEqual(['new-1']);
    expect(h.boards.slice(before).flat()).not.toContain('old-1');
  });

  it('workspace switch: a late read of the old workspace is dropped', async () => {
    await render();
    h.workspaceId = 'ws-2';
    await render();
    await land('ws-2', NEW);
    expect(h.boards.at(-1)).toEqual(['new-1']);
    // The first workspace's read lands after the switch: it never reaches the board.
    await land('ws-1', OLD);
    expect(h.boards.flat()).not.toContain('old-1');
    expect(h.boards.at(-1)).toEqual(['new-1']);
  });
});

describe('post flow C: the narrowing count line (page)', () => {
  function countLine(): string | null {
    return host!.querySelector('[data-posts-count]')?.textContent ?? null;
  }

  const POSTS = [
    x5Post({ id: 'a', title: 'Launch teaser', stage: 'review' }),
    x5Post({ id: 'b', title: 'Recap reel', stage: 'review' }),
  ];

  it('fix 7: no count line without a search or date filter (the chips carry the counts)', async () => {
    await render();
    await land('ws-1', POSTS);
    expect(countLine()).toBeNull();
    expect(host!.querySelector('[data-undated-hint]')).toBeNull();
  });

  it('fix 7: a search shows "{shown} of {total} posts"', async () => {
    h.params = new URLSearchParams('q=launch');
    await render();
    await land('ws-1', POSTS);
    expect(countLine()).toBe('1 of 2 posts');
  });

  it('fix 7: a date filter names the undated posts it hides, and Show them adds them back', async () => {
    h.params = new URLSearchParams('date=week');
    await render();
    await land('ws-1', POSTS);
    expect(countLine()).toBe('0 of 2 posts');
    const hint = host!.querySelector('[data-undated-hint]');
    expect(hint?.textContent).toContain('This week. 2 posts with no date are hidden.');
    const show = [...(hint?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Show them',
    );
    expect(show).toBeDefined();
    await act(async () => {
      show!.click();
    });
    expect(host!.querySelector('[data-undated-hint]')).toBeNull();
    expect(countLine()).toBe('2 of 2 posts');
    expect(h.boards.at(-1)).toEqual(['a', 'b']);
  });
});
