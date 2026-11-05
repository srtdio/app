// @vitest-environment jsdom
// G2 Plan screen fixes (F6 to F15), mounted with stubbed reads and writes;
// nothing touches a database. F6 the picker's Done adds and its dismiss adds
// nothing; F8 autosave: a move or a remove from a row's ⋯ menu paints at once,
// writes nothing behind its Undo strip, then one fresh read and one plan_save
// with the rebuilt op (a "no longer available" retries once, a second failure
// puts the row back); F9 No date's Add puts posts on No date; F13 delete plan
// rides useUndoableAction; F14 Retry shows loading and a failed re-read
// toasts; F15 close resets the outside day sheets, the footer Retry keeps the
// failed send's mode, and every outside day is tried.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { PlanBundle, PlanItemRow } from '@/lib/chat/plans';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/chat/plan-live', () => ({ subscribePlanLive: () => () => undefined }));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws', workspaces: [] }),
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'me' } } }),
}));
vi.mock('@/lib/chat/viewer-role', () => ({
  useViewerSide: () => ({ side: 'agency', ready: true }),
}));
vi.mock('@/lib/assets', () => ({ fetchMemberRole: async () => 'owner' }));
vi.mock('@/lib/chat-reads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat-reads')>()),
  readProfiles: async () => ({ ok: true, data: [] }),
}));
vi.mock('@/components/chat/PlanItemScreen', () => ({ PlanItemScreen: () => null }));
vi.mock('@/components/chat/AssetPicker', () => ({ AssetPicker: () => null }));
vi.mock('@/components/chat/PlanCardsProvider', () => ({ usePlanCards: () => null }));
vi.mock('@/lib/chat/use-chat-attachments', () => ({
  useCommentAttachments: () => ({ canAttach: false, uploadFile: undefined }),
}));

const h = vi.hoisted(() => {
  const item = (id: string, target_date: string | null, position: number): PlanItemRow => ({
    id,
    plan_id: 'plan',
    kind: 'concept',
    position,
    title: id,
    description: null,
    post_id: null,
    created_at: '2026-10-09T10:00:00Z',
    target_date,
  });
  const bundleOf = (items: PlanItemRow[], audience: 'team' | 'client' = 'team'): PlanBundle => ({
    plan: {
      id: 'plan',
      workspace_id: 'ws',
      title: 'Week of 12 Oct',
      starts_on: '2026-10-12',
      ends_on: '2026-10-18',
      audience,
      created_by: 'me',
    },
    items,
    reviews: [],
    postStages: {},
    postInfo: {},
  });
  const BUNDLE = bundleOf([item('alpha', '2026-10-13', 0), item('beta', '2026-10-14', 1)]);
  type ScreenResult = { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  const screenOk = (bundle: PlanBundle): ScreenResult => ({
    ok: true,
    data: { bundle, commentCounts: {}, thumbs: {}, conceptThumbs: {} },
  });
  const state: {
    /** Each Plan screen read takes the next answer; the last one repeats. */
    screens: Array<() => Promise<ScreenResult>>;
    screenCalls: number;
    /** Each Save changes fresh read takes the next bundle; the last one repeats. */
    fresh: PlanBundle[];
    picker: {
      open?: boolean;
      onClose?: () => void;
      onDone?: () => void;
      onToggle?: (post: unknown) => void;
    };
  } = { screens: [], screenCalls: 0, fresh: [], picker: {} };
  return {
    item,
    bundleOf,
    BUNDLE,
    screenOk,
    state,
    planSave: vi.fn(),
    planPostsAdd: vi.fn(),
    planDelete: vi.fn(),
    postUpdate: vi.fn(),
    sharePlanToChannel: vi.fn(),
    readPlanBundles: vi.fn(),
  };
});

vi.mock('@srtdio/rpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@srtdio/rpc')>()),
  planSave: h.planSave,
  planPostsAdd: h.planPostsAdd,
  planDelete: h.planDelete,
}));
vi.mock('@srtdio/posts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@srtdio/posts')>()),
  postUpdate: h.postUpdate,
}));
vi.mock('@/lib/chat/share-plan', () => ({ sharePlanToChannel: h.sharePlanToChannel }));
vi.mock('@/components/chat/PostPicker', () => ({
  PostPicker: (props: typeof h.state.picker) => {
    h.state.picker = props;
    return null;
  },
}));
vi.mock('@/lib/chat/plans', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/plans')>()),
  readPlanScreen: () => {
    const at = Math.min(h.state.screenCalls, h.state.screens.length - 1);
    h.state.screenCalls += 1;
    const next = h.state.screens[at];
    return next !== undefined ? next() : Promise.resolve(h.screenOk(h.BUNDLE));
  },
  readPlanBundles: h.readPlanBundles,
}));

import { PlanScreen } from '@/components/chat/PlanScreen';
import { ToastProvider, ToastViewport } from '@/components/ui/toast';
import { SEND_FAILED } from '@/components/chat/plan-card';
import { dispatchPlanChanged } from '@/lib/chat/plans';
import { resetHistorySteps } from '@/lib/chat/use-history-step';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => act(async () => wait(80));
const ok = <T,>(data: T) => ({ ok: true as const, data });
const err = (message: string) => ({ ok: false as const, error: { code: 'unknown', message } });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type ChatProp = Parameters<typeof PlanScreen>[0]['chat'];

async function mount(opts: { chat?: ChatProp } = {}) {
  const onClose = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const render = (open: boolean) =>
    root?.render(
      <MemoryRouter>
        <ToastProvider>
          <PlanScreen
            open={open}
            planId="plan"
            onClose={onClose}
            {...(opts.chat !== undefined ? { chat: opts.chat } : {})}
          />
          <ToastViewport />
        </ToastProvider>
      </MemoryRouter>,
    );
  await act(async () => render(true));
  await settle();
  await settle();
  return {
    onClose,
    rerender: async (open: boolean) => {
      await act(async () => render(open));
      await settle();
      await settle();
    },
  };
}

const q = <T extends HTMLElement>(selector: string): T | null =>
  document.querySelector<T>(selector);
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    (b.textContent ?? '').includes(label),
  );
const rows = () =>
  [...document.querySelectorAll<HTMLElement>('button[data-plan-row]')].map((el) =>
    el.getAttribute('data-plan-row'),
  );
const click = async (el: HTMLElement | null | undefined) => {
  await act(async () => el?.click());
  await settle();
};
const sheet = (title: string) => q<HTMLElement>(`[role="dialog"][aria-label="${title}"]`);

async function openPicker(addSelector: string): Promise<void> {
  await click(q(addSelector));
  await click(button('Pick a post'));
  expect(h.state.picker.open).toBe(true);
}
async function toggle(post: Record<string, unknown>): Promise<void> {
  await act(async () => h.state.picker.onToggle?.(post));
}
async function rowMenu(id: string, label: string): Promise<void> {
  await click(q(`[data-plan-row-wrap="${id}"] button[aria-label="More actions"]`));
  await click(button(label));
}
async function moveAlphaTo14(): Promise<void> {
  await rowMenu('alpha', 'Move to another day');
  await click(q('[data-plan-day-tile="2026-10-14"]'));
}
/** The page goes hidden: the pending Undo strip commits at once. */
async function flushUndo(): Promise<void> {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  try {
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await wait(40);
    });
  } finally {
    Reflect.deleteProperty(document, 'visibilityState');
  }
  await settle();
}

const POST_IN = { id: 'post-in', title: 'Post in', platform: null, format: null, stage: 'draft' };

beforeEach(() => {
  resetHistorySteps();
  h.state.screens = [];
  h.state.screenCalls = 0;
  h.state.fresh = [h.BUNDLE];
  h.state.picker = {};
  for (const fn of [
    h.planSave,
    h.planPostsAdd,
    h.planDelete,
    h.postUpdate,
    h.sharePlanToChannel,
    h.readPlanBundles,
  ]) {
    fn.mockReset();
  }
  h.planSave.mockResolvedValue(ok(undefined));
  h.planPostsAdd.mockResolvedValue(ok(1));
  h.planDelete.mockResolvedValue(ok(undefined));
  h.postUpdate.mockResolvedValue(ok('post'));
  let freshAt = 0;
  h.readPlanBundles.mockImplementation(async () => {
    const bundle = h.state.fresh[Math.min(freshAt, h.state.fresh.length - 1)] ?? h.BUNDLE;
    freshAt += 1;
    return ok(new Map([['plan', bundle]]));
  });
});

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  await settle();
  resetHistorySteps();
});

describe('F6: the post picker Done adds, a dismiss adds nothing', () => {
  it('dismiss drops the ticked posts and writes nothing; Done adds them to the day', async () => {
    await mount();
    await openPicker('[data-plan-add="2026-10-13"]');
    await toggle(POST_IN);
    await act(async () => h.state.picker.onClose?.());
    await settle();
    expect(h.state.picker.open).toBe(false);
    expect(h.planPostsAdd).not.toHaveBeenCalled();
    // Reopened, the old selection is gone; Done adds the new tick on that day.
    await openPicker('[data-plan-add="2026-10-13"]');
    await toggle(POST_IN);
    await act(async () => h.state.picker.onDone?.());
    await settle();
    expect(h.planPostsAdd).toHaveBeenCalledTimes(1);
    expect(h.planPostsAdd.mock.calls[0]?.[1]).toMatchObject({
      p_post_ids: ['post-in'],
      p_target_date: '2026-10-13',
    });
  });
});

describe('F8: autosave, one op per write, rebuilt on one fresh read', () => {
  it('a move paints at once, writes nothing behind Undo, then one read and one plan_save', async () => {
    h.state.fresh = [
      h.bundleOf([
        h.item('alpha', '2026-10-13', 0),
        h.item('beta', '2026-10-14', 1),
        h.item('gamma', '2026-10-14', 2),
      ]),
    ];
    await mount();
    await moveAlphaTo14();
    expect(q('[data-plan-day="2026-10-14"] [data-plan-row="alpha"]')).not.toBeNull();
    expect(h.readPlanBundles).not.toHaveBeenCalled();
    expect(h.planSave).not.toHaveBeenCalled();
    await flushUndo();
    expect(h.readPlanBundles).toHaveBeenCalledTimes(1);
    expect(h.planSave).toHaveBeenCalledTimes(1);
    expect(h.planSave.mock.calls[0]?.[1].p_ops).toEqual([
      {
        op: 'move',
        item_id: 'alpha',
        target_date: '2026-10-14',
        item_ids: ['beta', 'alpha', 'gamma'],
        keep_reviews: false,
      },
    ]);
  });

  it('"no longer available": reads once more, rebuilds and retries once', async () => {
    h.state.fresh = [
      h.BUNDLE,
      // By the retry, beta was removed by someone else.
      h.bundleOf([h.item('alpha', '2026-10-13', 0)]),
    ];
    h.planSave.mockResolvedValueOnce(err('invalid_payload')).mockResolvedValueOnce(ok(undefined));
    await mount();
    await moveAlphaTo14();
    await flushUndo();
    expect(h.readPlanBundles).toHaveBeenCalledTimes(2);
    expect(h.planSave).toHaveBeenCalledTimes(2);
    expect(h.planSave.mock.calls[1]?.[1].p_ops[0].item_ids).toEqual(['alpha']);
  });

  it('a second failure puts the row back on its day', async () => {
    h.planSave.mockResolvedValue(err('invalid_payload'));
    await mount();
    await moveAlphaTo14();
    await flushUndo();
    expect(h.planSave).toHaveBeenCalledTimes(2);
    expect(q('[data-plan-day="2026-10-13"] [data-plan-row="alpha"]')).not.toBeNull();
  });

  it('Remove from plan: the row goes at once; the remove op is written after the strip', async () => {
    await mount();
    await rowMenu('beta', 'Remove from plan');
    expect(rows()).toEqual(['alpha']);
    expect(h.planSave).not.toHaveBeenCalled();
    await flushUndo();
    expect(h.planSave).toHaveBeenCalledTimes(1);
    expect(h.planSave.mock.calls[0]?.[1].p_ops).toEqual([{ op: 'remove', item_id: 'beta' }]);
  });
});

describe('F9: No date’s Add is an explicit No date target', () => {
  it('a post with a Pipeline date has its date cleared and is added with no day', async () => {
    await mount();
    await openPicker('[data-plan-add="none"]');
    await toggle({ ...POST_IN, target_date: '2026-10-15T12:00:00Z' });
    await act(async () => h.state.picker.onDone?.());
    await settle();
    expect(h.postUpdate).toHaveBeenCalledTimes(1);
    expect(h.postUpdate.mock.calls[0]?.[1]).toEqual({ postId: 'post-in', targetDate: null });
    expect(h.planPostsAdd).toHaveBeenCalledTimes(1);
    expect(h.planPostsAdd.mock.calls[0]?.[1]).not.toHaveProperty('p_target_date');
    // Never the header "+" path: no outside-day sheet.
    expect(sheet('Post in')).toBeNull();
  });
});

describe('F13: delete plan rides useUndoableAction', () => {
  it('closes at once, writes nothing yet, and commits when the page is hidden', async () => {
    const { onClose } = await mount();
    await click(q('[data-plan-title-menu]'));
    await click(q('[data-plan-menu-delete]'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.planDelete).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Plan deleted');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await wait(20);
      });
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
    expect(h.planDelete).toHaveBeenCalledTimes(1);
    expect(h.planDelete.mock.calls[0]?.[1]).toMatchObject({ p_plan_id: 'plan' });
  });
});

describe('F14: Retry and a failed re-read', () => {
  it('Retry after a failed load shows the loading state right away', async () => {
    const second = deferred<ReturnType<typeof h.screenOk>>();
    h.state.screens = [() => Promise.resolve(err('boom')), () => second.promise];
    await mount();
    expect(document.body.textContent).toContain("Couldn't load. Try again.");
    await act(async () => button('Retry')?.click());
    expect(q('[aria-label="Loading plan"]')).not.toBeNull();
    await act(async () => {
      second.resolve(h.screenOk(h.BUNDLE));
      await wait(20);
    });
  });

  it('a re-read that fails while the plan is shown toasts the load-failure copy with Retry', async () => {
    h.state.screens = [
      () => Promise.resolve(h.screenOk(h.BUNDLE)),
      () => Promise.resolve(err('boom')),
      () => Promise.resolve(h.screenOk(h.BUNDLE)),
    ];
    await mount();
    await act(async () => dispatchPlanChanged(window, 'plan'));
    await settle();
    // The plan stays, and the failure is said, never silence.
    expect(rows()).toEqual(['alpha', 'beta']);
    expect(document.body.textContent).toContain("Couldn't load. Try again.");
    const retry = button('Retry');
    expect(retry).toBeDefined();
    await click(retry);
    expect(h.state.screenCalls).toBe(3);
  });
});

describe('F15: close resets, the footer Retry, every outside day', () => {
  it('a header "+" day sheet and its notes never come back on the next open', async () => {
    const { rerender } = await mount();
    await openPicker('[data-plan-add-header]');
    await toggle({ ...POST_IN, id: 'a', title: 'Post A', target_date: '2026-11-30T12:00:00Z' });
    await toggle({ ...POST_IN, id: 'b', title: 'Post B', target_date: '2026-11-30T12:00:00Z' });
    await act(async () => h.state.picker.onDone?.());
    await settle();
    expect(sheet('Post A')).not.toBeNull();
    // Skipping A leaves its note and B's sheet up.
    await click(sheet('Post A')?.querySelector<HTMLElement>('[aria-label="Close"]'));
    await settle();
    expect(q('[data-plan-skipped-notes]')).not.toBeNull();
    expect(sheet('Post B')).not.toBeNull();
    await rerender(false);
    await settle();
    await rerender(true);
    expect(sheet('Post B')).toBeNull();
    expect(q('[data-plan-skipped-notes]')).toBeNull();
  });

  it('the footer Retry sends the same way as the failed plain send (plain send error)', async () => {
    h.state.screens = [() => Promise.resolve(h.screenOk(h.bundleOf(h.BUNDLE.items, 'client')))];
    h.sharePlanToChannel.mockResolvedValue({
      ok: false,
      reason: 'record',
      message: 'boom',
      copy: '',
    });
    await mount({
      chat: {
        channelId: 'ch',
        name: 'Acme',
        hasClient: true,
        cardPlanIds: [],
        onSent: () => undefined,
        onGoToCard: () => undefined,
      },
    });
    await click(q('[data-plan-primary="send"]'));
    expect(q('[data-plan-send-error]')?.textContent).toBe(SEND_FAILED);
    await click(q('[data-plan-primary="retry"]'));
    expect(h.sharePlanToChannel).toHaveBeenCalledTimes(2);
    expect(q('[data-plan-send-error]')?.textContent).toBe(SEND_FAILED);
  });

  it('every outside day is tried; any failure is one error toast and no success toast', async () => {
    h.planPostsAdd.mockResolvedValueOnce(err('boom')).mockResolvedValueOnce(ok(1));
    await mount();
    await openPicker('[data-plan-add-header]');
    await toggle({ ...POST_IN, id: 'a', title: 'Post A', target_date: '2026-11-30T12:00:00Z' });
    await toggle({ ...POST_IN, id: 'b', title: 'Post B', target_date: '2026-11-30T12:00:00Z' });
    await act(async () => h.state.picker.onDone?.());
    await settle();
    await click(sheet('Post A')?.querySelector<HTMLElement>('[data-plan-day-tile="2026-10-13"]'));
    await settle();
    await click(sheet('Post B')?.querySelector<HTMLElement>('[data-plan-day-tile="2026-10-14"]'));
    await settle();
    expect(h.planPostsAdd).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Couldn't add. Try again.");
    expect(document.body.textContent).not.toContain('Added to');
  });
});
