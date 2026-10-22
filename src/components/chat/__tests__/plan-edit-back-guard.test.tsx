// @vitest-environment jsdom
// X3 item 5: the Plan screen in edit mode with queued changes. System Back
// asks "Discard changes?" (the screen stays, the parent's close never runs),
// Keep editing keeps the queue (the removed row stays gone, edit mode stays),
// Discard releases the guard and closes with no stray history entry. Reads
// and writes are stubbed; nothing touches a database.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { PlanBundle, PlanItemRow } from '@/lib/chat/plans';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws', workspaces: [] }),
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'me' } } }),
}));
vi.mock('@/lib/chat/viewer-role', () => ({
  useViewerSide: () => ({ side: 'agency', ready: true }),
}));
vi.mock('@/lib/assets', () => ({ fetchMemberRole: async () => 'agency' }));
vi.mock('@/lib/chat-reads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat-reads')>()),
  readProfiles: async () => ({ ok: true, data: [] }),
}));
vi.mock('@/components/chat/PlanItemScreen', () => ({ PlanItemScreen: () => null }));
vi.mock('@/components/chat/PostPicker', () => ({ PostPicker: () => null }));
vi.mock('@/components/chat/AssetPicker', () => ({ AssetPicker: () => null }));
vi.mock('@/components/chat/PlanCardsProvider', () => ({ usePlanCards: () => null }));
vi.mock('@/lib/chat/use-chat-attachments', () => ({
  useCommentAttachments: () => ({ canAttach: false, uploadFile: undefined }),
}));
vi.mock('@/lib/use-media-query', () => ({
  LAPTOP_QUERY: '(min-width: 768px)',
  useMediaQuery: () => false,
}));

// The stubbed read's plan (hoisted: the mock factory runs before this module's body).
const { BUNDLE } = vi.hoisted(() => {
  const item = (id: string, target_date: string, position: number): PlanItemRow => ({
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
  const BUNDLE: PlanBundle = {
    plan: {
      id: 'plan',
      workspace_id: 'ws',
      title: 'Week of 12 Oct',
      starts_on: '2026-10-12',
      ends_on: '2026-10-18',
      audience: 'team',
      created_by: 'me',
    },
    items: [item('alpha', '2026-10-13', 0), item('beta', '2026-10-14', 1)],
    reviews: [],
    postStages: {},
    postInfo: {},
  };
  return { BUNDLE };
});
vi.mock('@/lib/chat/plans', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/plans')>()),
  readPlanScreen: async () => ({
    ok: true,
    data: { bundle: BUNDLE, commentCounts: {}, thumbs: {}, conceptThumbs: {} },
  }),
}));

import { PlanScreen } from '@/components/chat/PlanScreen';
import { ToastProvider } from '@/components/ui/toast';
import { BACK_GUARD_STEP_KEY } from '@/lib/back-guard';
import { resetHistorySteps, stepMarkerOf } from '@/lib/chat/use-history-step';
import { DUR_BASE_MS } from '@/lib/motion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => act(async () => wait(80));

async function mount() {
  const onClose = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <ToastProvider>
          <PlanScreen open planId="plan" onClose={onClose} />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
  // The stubbed read lands; the list paints.
  await settle();
  await settle();
  return { onClose };
}

const q = <T extends HTMLElement>(selector: string): T | null =>
  document.querySelector<T>(selector);
const confirm = () => q<HTMLElement>('[role="alertdialog"]');
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);
const guarded = () => stepMarkerOf(window.history.state, BACK_GUARD_STEP_KEY) !== null;
const rows = () =>
  [...document.querySelectorAll<HTMLElement>('button[data-plan-row]')].map((el) =>
    el.getAttribute('data-plan-row'),
  );

async function pressBack(): Promise<void> {
  await act(async () => {
    window.history.back();
    await wait(80);
  });
}

async function enterEditAndRemoveAlpha(): Promise<void> {
  await act(async () => q<HTMLButtonElement>('[data-plan-edit]')?.click());
  expect(q('[data-plan-editing-title]')).not.toBeNull();
  expect(guarded()).toBe(false);
  await act(async () =>
    q<HTMLButtonElement>('[data-plan-row-wrap="alpha"] [data-plan-row-remove-edit]')?.click(),
  );
  await settle();
}

beforeEach(() => resetHistorySteps());

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  await settle();
  resetHistorySteps();
});

describe('Plan screen edit mode and the Back guard', () => {
  it('view mode shows Edit, no grip; edit mode shows the fields, grips and chips, no footer', async () => {
    await mount();
    expect(rows()).toEqual(['alpha', 'beta']);
    expect(q('[data-plan-edit]')).not.toBeNull();
    expect(q('[data-plan-grip]')).toBeNull();
    expect(q('[data-plan-footer]')).not.toBeNull();
    await act(async () => q<HTMLButtonElement>('[data-plan-edit]')?.click());
    expect(q('[data-plan-editing-title]')?.textContent).toBe('Editing plan');
    expect(q<HTMLInputElement>('[data-plan-edit-title]')?.value).toBe('Week of 12 Oct');
    expect(document.querySelectorAll('[data-plan-grip]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-plan-row-day-chip]')).toHaveLength(2);
    expect(q('[data-plan-footer]')).toBeNull();
    // PLAN shows as read-only text in edit mode: no switch, no pill.
    expect(q('[data-plan-control="switch"]')).toBeNull();
    expect(q('[data-plan-control="pill"]')).toBeNull();
    expect(q('[data-plan-control="text"][data-plan-slot-readonly]')).not.toBeNull();
    expect(button('Save changes')).toBeDefined();
    expect(button('Cancel')).toBeDefined();
    // No changes: no guard, and Cancel leaves edit mode at once.
    expect(guarded()).toBe(false);
    await act(async () => button('Cancel')?.click());
    expect(q('[data-plan-editing-title]')).toBeNull();
    expect(q('[data-plan-edit]')).not.toBeNull();
  });

  it('a queued remove paints at once and arms the guard; Back asks, the screen stays', async () => {
    const { onClose } = await mount();
    await enterEditAndRemoveAlpha();
    expect(rows()).toEqual(['beta']);
    expect(guarded()).toBe(true);
    await pressBack();
    expect(onClose).not.toHaveBeenCalled();
    expect(q('[data-plan-page="plan"]')).not.toBeNull();
    expect(confirm()?.textContent).toContain('Discard changes?');
    expect(confirm()?.textContent).toContain('Your edits to this plan will be lost.');
    expect(button('Keep editing')).toBeDefined();
    expect(button('Discard')).toBeDefined();
    expect(guarded()).toBe(true);
  });

  it('Keep editing keeps edit mode and the queue; Back asks again', async () => {
    const { onClose } = await mount();
    await enterEditAndRemoveAlpha();
    await pressBack();
    await act(async () => {
      button('Keep editing')?.click();
      await wait(DUR_BASE_MS + 40);
    });
    expect(confirm()).toBeNull();
    expect(q('[data-plan-editing-title]')).not.toBeNull();
    expect(rows()).toEqual(['beta']);
    expect(onClose).not.toHaveBeenCalled();
    await pressBack();
    expect(confirm()).not.toBeNull();
  });

  it('Discard releases the guard and closes the screen; no guard entry is left', async () => {
    const { onClose } = await mount();
    await enterEditAndRemoveAlpha();
    await pressBack();
    await act(async () => button('Discard')?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    await settle();
    expect(guarded()).toBe(false);
  });

  it('Cancel with queued changes asks too; Discard there only leaves edit mode', async () => {
    const { onClose } = await mount();
    await enterEditAndRemoveAlpha();
    await act(async () => button('Cancel')?.click());
    expect(confirm()?.textContent).toContain('Discard changes?');
    await act(async () => button('Discard')?.click());
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(q('[data-plan-editing-title]')).toBeNull();
    // The queue is dropped: the row is back.
    expect(rows()).toEqual(['alpha', 'beta']);
    expect(guarded()).toBe(false);
  });
});
