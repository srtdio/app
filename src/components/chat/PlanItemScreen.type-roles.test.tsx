// @vitest-environment jsdom
// Type roles on the Plan item screen: the screen header and the item title
// (15/20, 600), the Comments section label (12, 600, uppercase, .06em, fg-2),
// a comment's author as the card title (14, 500), its body (14, fg) and the
// meta lines (12, fg-3; the clock in sans tabular figures, not mono). Reads
// are stubbed; nothing touches a database.

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
vi.mock('@/lib/chat-reads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat-reads')>()),
  readProfiles: async () => ({ ok: true, data: [] }),
}));
vi.mock('@/lib/people-names', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/people-names')>()),
  resolvePeople: async () => undefined,
}));
vi.mock('@/components/chat/PostPicker', () => ({ PostPicker: () => null }));
vi.mock('@/components/chat/AssetPicker', () => ({ AssetPicker: () => null }));
vi.mock('@/components/chat/PlanCardsProvider', () => ({ usePlanCards: () => null }));
vi.mock('@/lib/chat/use-chat-attachments', () => ({
  useCommentAttachments: () => ({ canAttach: false, uploadFile: undefined }),
}));
vi.mock('@/lib/chat/plans', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/plans')>()),
  readItemScreen: async () => ({
    ok: true,
    data: {
      comments: [
        {
          id: 'cm1',
          item_id: 'c1',
          author_user_id: 'u2',
          body: 'Looks good to me',
          visibility: 'everyone',
          created_at: '2026-10-10T09:30:00Z',
        },
      ],
      files: [],
      names: { u2: 'Asha' },
    },
  }),
}));

import { PlanItemScreen } from '@/components/chat/PlanItemScreen';
import { ToastProvider } from '@/components/ui/toast';
import { resetHistorySteps } from '@/lib/chat/use-history-step';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEM: PlanItemRow = {
  id: 'c1',
  plan_id: 'plan',
  kind: 'concept',
  position: 0,
  title: 'Plant tour reel',
  description: 'A walk through the plant.',
  post_id: null,
  created_at: '2026-10-09T10:00:00Z',
  target_date: '2026-10-13',
};

const BUNDLE: PlanBundle = {
  plan: {
    id: 'plan',
    workspace_id: 'ws',
    title: 'Week of 12 Oct',
    starts_on: '2026-10-12',
    ends_on: '2026-10-18',
    audience: 'client',
    created_by: 'u2',
  },
  items: [ITEM],
  reviews: [],
  postStages: {},
  postInfo: {},
};

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
          <PlanItemScreen open bundle={BUNDLE} item={ITEM} side="client" onClose={() => {}} />
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

describe('Plan item screen type roles', () => {
  it('screen header: lg, 600', async () => {
    await mount();
    const header = document.querySelector('[data-plan-page-titles] h2');
    expect(header).not.toBeNull();
    expect(classes(header as Element)).toEqual(
      expect.arrayContaining(['text-lg', 'font-semibold']),
    );
    expect(classes(header as Element)).not.toContain('text-xl');
  });

  it('item title: lg, 600 (was 20px)', async () => {
    await mount();
    const title = byText('h3', 'Plant tour reel');
    expect(classes(title)).toEqual(expect.arrayContaining(['text-lg', 'font-semibold', 'text-fg']));
    expect(classes(title)).not.toContain('text-2xl');
  });

  it('section label: Comments is sm, 600, uppercase, .06em, fg-2', async () => {
    await mount();
    const label = byText('h4', 'Comments');
    expect(classes(label)).toEqual(
      expect.arrayContaining([
        'text-sm',
        'font-semibold',
        'uppercase',
        'tracking-[0.06em]',
        'text-fg-2',
      ]),
    );
  });

  it('card title and body: the comment author is base/500, its body base fg', async () => {
    await mount();
    const author = byText('span', 'Asha');
    expect(classes(author)).toEqual(expect.arrayContaining(['text-base', 'font-medium']));
    expect(classes(author)).not.toContain('font-semibold');
    const body = byText('p', 'Looks good to me');
    expect(classes(body)).toEqual(expect.arrayContaining(['text-base', 'text-fg']));
    expect(classes(body)).not.toContain('text-lg');
    const description = byText('p', 'A walk through the plant.');
    expect(classes(description)).toEqual(expect.arrayContaining(['text-base', 'text-fg-2']));
  });

  it('meta: the subtitle and the comment time are sm fg-3; the time is sans tabular', async () => {
    await mount();
    const subtitle = document.querySelector('[data-plan-page-subtitle]');
    expect(subtitle).not.toBeNull();
    expect(classes(subtitle as Element)).toEqual(expect.arrayContaining(['text-sm', 'text-fg-3']));
    const time = document.querySelector('time');
    expect(time).not.toBeNull();
    expect(classes(time as Element)).toEqual(
      expect.arrayContaining(['text-sm', 'text-fg-3', 'font-sans', 'tabular-nums']),
    );
    expect(classes(time as Element)).not.toContain('font-mono');
  });
});
