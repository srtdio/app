// @vitest-environment jsdom
// A bank idea (a concept with no plan) in the Item screen with no bundle:
// header "Idea", subline "Bank" ("Bank · archived"), a "Came from" line, Date
// "No date"; no Approvers row, no plan menu (Move, Remove), no review actions,
// no Edit, no "Concept 1 of 3". Files, the title card, the Post row and the
// comments stay. The /plan/bank route paints the screen from planItemRead and
// goes Back to the Plan tab on the Bank chip. Reads and writes are stubbed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { PlanItemRead, PlanItemRow } from '@/lib/chat/plans';
import type { Result } from '@srtdio/rpc';

const env = vi.hoisted(() => ({
  reads: 0,
  result: null as unknown,
}));

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/device-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/device-cache')>()),
  put: () => undefined,
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws', workspaces: [] }),
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'me' } } }),
}));
vi.mock('@/lib/chat/viewer-role', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/viewer-role')>()),
  useViewerSide: () => ({ side: 'agency', ready: true }),
}));
vi.mock('@/lib/chat-reads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat-reads')>()),
  readProfiles: async () => ({ ok: true, data: [] }),
}));
vi.mock('@/lib/people-names', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/people-names')>()),
  resolvePeople: async () => undefined,
}));
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => false,
  useCoarsePointer: () => true,
}));
vi.mock('@/components/chat/PostPicker', () => ({ PostPicker: () => null }));
vi.mock('@/components/chat/AssetPicker', () => ({ AssetPicker: () => null }));
vi.mock('@/components/chat/PlanCardsProvider', () => ({ usePlanCards: () => null }));
vi.mock('@/components/media/Thumbnail', () => ({ Thumbnail: () => null }));
vi.mock('@/components/ui/LinkPreviewCard', () => ({ LinkPreviewCard: () => null }));
vi.mock('@/lib/chat/use-chat-attachments', () => ({
  useCommentAttachments: () => ({ canAttach: false, uploadFile: undefined }),
}));
vi.mock('@/components/pages/PostDetailPage', () => ({ PostDetailPage: () => null }));
vi.mock('@/components/chat/IdeaShareFlow', () => ({ IdeaShareFlow: () => null }));
vi.mock('@/lib/chat/plans', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/plans')>()),
  planItemRead: async () => {
    env.reads += 1;
    return env.result;
  },
}));

import {
  BANK_BACK_LABEL,
  PlanItemScreen,
  bankBundleOf,
  bankSubline,
  cameFromLine,
} from '@/components/chat/PlanItemScreen';
import { PlanBankItemPage, planBankBack, planBankItemRoute } from '@/components/pages/PlanPage';
import { ToastProvider } from '@/components/ui/toast';
import { resetSessionReads } from '@/lib/session-read';
import { resetHistorySteps } from '@/lib/chat/use-history-step';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEM_ID = '0192f000-0000-7000-8000-000000000001';

const IDEA: PlanItemRow = {
  id: ITEM_ID,
  plan_id: null,
  kind: 'concept',
  position: 0,
  title: 'Monsoon reel',
  description: 'Rain on the farm',
  post_id: null,
  created_at: '2026-11-06T00:00:00Z',
  target_date: null,
  linked_post_id: null,
  show_to_client: false,
  archived_at: null,
  starred_at: null,
  last_active_at: '2026-11-06T00:00:00Z',
  came_from_plan_title: 'Week of 2 Nov',
  bucket_ids: [],
};

function readOf(item: PlanItemRow): Result<PlanItemRead> {
  return {
    ok: true,
    data: {
      item,
      screen: { comments: [], files: [], names: {} },
      postStages: {},
      postInfo: {},
    },
  };
}

let root: Root | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => act(async () => wait(60));

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  env.reads = 0;
  resetSessionReads();
  resetHistorySteps();
});

async function render(node: React.ReactElement): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(node);
  });
  await settle();
  await settle();
}

const text = (): string => document.body.textContent ?? '';
const $ = (sel: string): HTMLElement | null => document.querySelector<HTMLElement>(sel);

describe('pure helpers', () => {
  it('subline, came-from line and the stand-in bundle', () => {
    expect(bankSubline(IDEA)).toBe('Bank');
    expect(bankSubline({ archived_at: '2026-11-06T00:00:00Z' })).toBe('Bank · archived');
    expect(cameFromLine(IDEA)).toBe('Came from Week of 2 Nov');
    expect(cameFromLine({ came_from_plan_title: null })).toBeNull();
    expect(cameFromLine({ came_from_plan_title: '  ' })).toBeNull();
    const team = bankBundleOf(IDEA);
    expect(team.items).toEqual([IDEA]);
    expect(team.reviews).toEqual([]);
    expect(team.plan.audience).toBe('team');
    expect(bankBundleOf({ ...IDEA, show_to_client: true }).plan.audience).toBe('client');
  });

  it('the bank route and its Back', () => {
    expect(planBankItemRoute('i1')).toBe('/plan/bank?item=i1');
    expect(planBankItemRoute('i1', 'c1')).toBe('/plan/bank?item=i1&comment=c1');
    expect(planBankBack()).toBe('/plan?week=bank');
  });
});

describe('the Item screen with no bundle', () => {
  it('hides the plan parts and keeps Files, title card, Post row and comments', async () => {
    env.result = readOf(IDEA);
    await render(
      <MemoryRouter>
        <ToastProvider>
          <PlanItemScreen open item={IDEA} side="agency" onClose={() => {}} />
        </ToastProvider>
      </MemoryRouter>,
    );
    const subline = $('[data-plan-page-subtitle]');
    expect(subline?.textContent).toBe('Bank');
    expect(text()).toContain('Idea');
    expect(text()).not.toMatch(/Concept \d+ of \d+/);
    expect($('[data-plan-came-from]')?.textContent).toBe('Came from Week of 2 Nov');
    expect($('[data-plan-item-date]')?.textContent).toBe('No date');
    expect($('[data-plan-item-date]')?.getAttribute('data-plan-item-date')).toBe('none');
    expect(text()).not.toContain('Approvers');
    expect(text()).not.toContain('Creators');
    // The bank idea's own More menu (Plan it, Send to chat, ...), never Move or Remove.
    expect($('[data-plan-item-more]')).not.toBeNull();
    expect($('[data-plan-remove-row]')).toBeNull();
    expect($('[data-plan-approve]')).toBeNull();
    expect($('[data-plan-ask]')).toBeNull();
    expect($('[data-plan-edit-concept]')).toBeNull();
    expect($('[data-plan-edit-date]')).toBeNull();
    expect(text()).not.toContain('Back to plan');
    // What stays.
    expect($('[data-plan-files]')).not.toBeNull();
    expect($('[data-plan-description-card]')?.textContent).toContain('Monsoon reel');
    expect($('[data-plan-status-post]')).not.toBeNull();
    expect($('[data-plan-comment-input]')).not.toBeNull();
    expect(text()).toContain('Comments show up here.');
  });

  it('an archived idea reads "Bank · archived"; one made in the bank has no came-from line', async () => {
    const archived = { ...IDEA, archived_at: '2026-11-06T00:00:00Z', came_from_plan_title: null };
    env.result = readOf(archived);
    await render(
      <MemoryRouter>
        <ToastProvider>
          <PlanItemScreen open item={archived} side="agency" onClose={() => {}} />
        </ToastProvider>
      </MemoryRouter>,
    );
    expect($('[data-plan-page-subtitle]')?.textContent).toBe('Bank · archived');
    expect($('[data-plan-came-from]')).toBeNull();
  });
});

function Where(): React.ReactElement {
  const loc = useLocation();
  return <div data-test-where={`${loc.pathname}${loc.search}`} />;
}

describe('/plan/bank', () => {
  it('opens the idea from planItemRead (one read) and Back lands on the Bank chip', async () => {
    env.result = readOf(IDEA);
    await render(
      <MemoryRouter initialEntries={[`/plan/bank?item=${ITEM_ID}`]}>
        <ToastProvider>
          <Routes>
            <Route path="/plan/bank" element={<PlanBankItemPage />} />
            <Route path="/plan" element={<Where />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>,
    );
    expect($('[data-plan-page-subtitle]')?.textContent).toBe('Bank');
    expect($('[data-plan-description-card]')?.textContent).toContain('Monsoon reel');
    // The route and the screen share one read.
    expect(env.reads).toBe(1);
    const back = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.getAttribute('aria-label') === BANK_BACK_LABEL || b.textContent === BANK_BACK_LABEL,
    );
    expect(back).toBeDefined();
    await act(async () => back?.click());
    expect($('[data-test-where]')?.getAttribute('data-test-where')).toBe('/plan?week=bank');
  });

  it('a malformed or unreadable id shows Plan not available, never a blank page', async () => {
    env.result = { ok: false, error: { code: 'unknown', message: 'plan_item_not_found' } };
    await render(
      <MemoryRouter initialEntries={[`/plan/bank?item=${ITEM_ID}`]}>
        <ToastProvider>
          <Routes>
            <Route path="/plan/bank" element={<PlanBankItemPage />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>,
    );
    expect(text()).toContain('not available');
  });

  it('App routes /plan/bank statically inside the Plan tab layout, before /plan/:planId', () => {
    const app = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
    const bank = app.indexOf('path="/plan/bank"');
    expect(bank).toBeGreaterThan(app.indexOf('<Route path="/plan" />'));
    expect(bank).toBeLessThan(app.indexOf('path="/plan/:planId"'));
    expect(app).toContain('m.PlanBankItemPage');
  });
});
