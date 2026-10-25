// @vitest-environment jsdom
// Type roles on the Plan screen: the page title (28/34, 600, tight), the
// section label (12, 600, uppercase, .06em, fg-2), the row title (14, 500)
// and the row meta (12, fg-3). Reads are stubbed; nothing touches a database.

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

const { BUNDLE } = vi.hoisted(() => {
  const item = (id: string, description: string | null, position: number): PlanItemRow => ({
    id,
    plan_id: 'plan',
    kind: 'concept',
    position,
    title: id,
    description,
    post_id: null,
    created_at: '2026-10-09T10:00:00Z',
    target_date: '2026-10-13',
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
    items: [item('alpha', 'Walk the floor', 0), item('beta', null, 1)],
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
import { resetHistorySteps } from '@/lib/chat/use-history-step';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => act(async () => wait(80));

async function mount(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <ToastProvider>
          <PlanScreen open planId="plan" onClose={() => undefined} />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
  await settle();
  await settle();
}

/** The first element matching `selector` whose trimmed text is exactly `text`. */
function byText(selector: string, text: string): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>(selector)].find(
    (e) => (e.textContent ?? '').trim() === text,
  );
  if (el === undefined) throw new Error(`no ${selector} reading "${text}"`);
  return el;
}

const classes = (el: Element): string[] => el.className.split(/\s+/);

beforeEach(() => resetHistorySteps());

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  await settle();
  resetHistorySteps();
});

describe('Plan screen type roles', () => {
  it('page title: 3xl, 600, tight tracking, never bold', async () => {
    await mount();
    const title = byText('h2', 'Week of 12 Oct');
    expect(classes(title)).toEqual(
      expect.arrayContaining(['text-3xl', 'font-semibold', 'tracking-tight', 'text-fg']),
    );
    expect(title.className).not.toContain('font-bold');
    expect(title.className).not.toContain('tracking-[-0.02em]');
    expect(title.className).not.toMatch(/leading-\[/);
  });

  it('section label: the progress box label is sm, 600, uppercase, .06em, fg-2', async () => {
    await mount();
    const box = document.querySelector('[data-plan-screen-progress="plan"]');
    const label = box?.querySelector('span');
    expect(label?.textContent).toBe('PLAN');
    expect(classes(label as Element)).toEqual(
      expect.arrayContaining([
        'text-sm',
        'font-semibold',
        'uppercase',
        'tracking-[0.06em]',
        'text-fg-2',
      ]),
    );
    expect(classes(label as Element)).not.toContain('text-xs');
  });

  it('row title: base, 500', async () => {
    await mount();
    const title = byText('[data-plan-row-title]', 'alpha');
    expect(classes(title)).toEqual(expect.arrayContaining(['text-base', 'font-medium']));
    expect(classes(title)).not.toContain('text-lg');
    expect(classes(title)).not.toContain('font-semibold');
  });

  it('row meta: sm, fg-3', async () => {
    await mount();
    const meta = byText('[data-plan-row-meta]', 'Walk the floor');
    expect(classes(meta)).toEqual(expect.arrayContaining(['text-sm', 'text-fg-3']));
    expect(classes(meta)).not.toContain('text-md');
  });
});
