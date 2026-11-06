// @vitest-environment jsdom
// Bank meets Plan on the Item screen: the Buckets card (picks autosave through
// plan_item_buckets_set with the full set; the add chip creates a bucket and
// picks it; a client reads Tags only), the Who can see this card on a bank
// idea (Team only / Client can see, Hide behind the Undo strip), the More menu
// per kind (planned concept, bank idea, client: none), Move to bank (the
// screen goes back at once, the write waits for the strip), and Plan it's
// past-day copy through the shared usePlanIt flow. Reads and writes are stubbed.

import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { PlanBundle, PlanItemRead, PlanItemRow } from '@/lib/chat/plans';
import type { Result } from '@srtdio/rpc';

const env = vi.hoisted(() => ({
  bucketWrites: [] as string[][],
  toBank: 0,
  flagWrites: [] as unknown[],
  created: 0,
  read: null as unknown,
  plans: [] as unknown[],
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
vi.mock('@/lib/workspace-members', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-members')>()),
  useWorkspaceMembers: () => ({
    rows: [{ user_id: 'a1', role: 'client', active: true }],
    profiles: new Map([['a1', { displayName: 'Asha' }]]),
  }),
}));
vi.mock('@/components/chat/PostPicker', () => ({ PostPicker: () => null }));
vi.mock('@/components/chat/AssetPicker', () => ({ AssetPicker: () => null }));
vi.mock('@/components/chat/PlanCardsProvider', () => ({ usePlanCards: () => null }));
vi.mock('@/components/media/Thumbnail', () => ({ Thumbnail: () => null }));
vi.mock('@/components/ui/LinkPreviewCard', () => ({ LinkPreviewCard: () => null }));
vi.mock('@/components/pages/PostDetailPage', () => ({ PostDetailPage: () => null }));
vi.mock('@/components/chat/IdeaShareFlow', () => ({
  IdeaShareFlow: (props: { idea: { id: string } | null }) =>
    props.idea !== null ? <div data-test-share={props.idea.id} /> : null,
}));
vi.mock('@/lib/chat/use-chat-attachments', () => ({
  useCommentAttachments: () => ({ canAttach: false, uploadFile: undefined }),
}));
vi.mock('@srtdio/rpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@srtdio/rpc')>()),
  planItemBucketsSet: async (_c: unknown, args: { p_bucket_ids: string[] }) => {
    env.bucketWrites.push(args.p_bucket_ids);
    return { ok: true, data: undefined };
  },
  planItemToBank: async () => {
    env.toBank += 1;
    return { ok: true, data: undefined };
  },
}));
vi.mock('@/lib/buckets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/buckets')>()),
  createBucket: async (_c: unknown, _ws: string, name: string) => {
    env.created += 1;
    return {
      ok: true,
      data: { id: 'new', name, colorHex: `${String.fromCharCode(35)}000000`, position: 9 },
    };
  },
}));
vi.mock('@/components/pages/plan-tab/use-bank-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/pages/plan-tab/use-bank-data')>()),
  useBankBuckets: () => ({
    buckets: [
      { id: 'b1', name: 'Launch', colorHex: `${String.fromCharCode(35)}000000`, position: 0 },
      {
        id: 'b2',
        name: 'Behind the scenes',
        colorHex: `${String.fromCharCode(35)}000000`,
        position: 1,
      },
    ],
    set: () => undefined,
  }),
  setBankFlags: async (_c: unknown, _idea: unknown, change: unknown) => {
    env.flagWrites.push(change);
  },
  readPlansForPlanIt: async () => ({ ok: true, data: env.plans }),
}));
vi.mock('@/lib/chat/plans', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/plans')>()),
  readItemScreen: async () => ({ ok: true, data: { comments: [], files: [], names: {} } }),
  readItemBuckets: async () => ({ ok: true, data: {} }),
  planItemRead: async () => env.read,
}));

import { PlanItemScreen } from '@/components/chat/PlanItemScreen';
import { usePlanIt } from '@/components/pages/plan-tab/BankList';
import { ToastProvider, ToastViewport } from '@/components/ui/toast';
import { resetSessionReads } from '@/lib/session-read';
import { resetHistorySteps } from '@/lib/chat/use-history-step';
import type { BankIdea } from '@/lib/chat/plans';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLANNED: PlanItemRow = {
  id: 'c1',
  plan_id: 'plan',
  kind: 'concept',
  position: 0,
  title: 'Plant tour reel',
  description: null,
  post_id: null,
  created_at: '2026-10-09T10:00:00Z',
  target_date: '2026-10-13',
  bucket_ids: ['b1'],
};

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
  items: [PLANNED],
  reviews: [],
  postStages: {},
  postInfo: {},
};

const IDEA: PlanItemRow = {
  id: '0192f000-0000-7000-8000-000000000009',
  plan_id: null,
  kind: 'concept',
  position: 0,
  title: 'Monsoon reel',
  description: null,
  post_id: null,
  created_at: '2026-11-06T00:00:00Z',
  target_date: null,
  show_to_client: false,
  archived_at: null,
  starred_at: null,
  came_from_plan_title: null,
  bucket_ids: [],
};

function readOf(item: PlanItemRow): Result<PlanItemRead> {
  return {
    ok: true,
    data: { item, screen: { comments: [], files: [], names: {} }, postStages: {}, postInfo: {} },
  };
}

let root: Root | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => act(async () => wait(60));
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const text = () => document.body.textContent ?? '';

beforeEach(() => {
  env.bucketWrites = [];
  env.toBank = 0;
  env.flagWrites = [];
  env.created = 0;
  env.plans = [];
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  resetSessionReads();
  resetHistorySteps();
});

async function render(node: ReactElement): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <ToastProvider>
          {node}
          <ToastViewport />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
  await settle();
  await settle();
}

async function click(el: HTMLElement | null): Promise<void> {
  if (el === null) throw new Error('missing element');
  await act(async () => el.click());
  await settle();
}

function menuItem(label: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) =>
      (e.textContent ?? '').includes(label),
    ) ?? null
  );
}

function menuLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((e) =>
    (e.textContent ?? '').trim(),
  );
}

describe('Buckets card', () => {
  it('a pick and an unpick each write the full set', async () => {
    await render(
      <PlanItemScreen open bundle={BUNDLE} item={PLANNED} side="agency" onClose={() => {}} />,
    );
    expect($('[data-plan-buckets]')).not.toBeNull();
    expect($('[data-plan-bucket="b1"]')?.getAttribute('aria-pressed')).toBe('true');
    await click($('[data-plan-bucket="b2"]'));
    expect(env.bucketWrites.at(-1)).toEqual(['b1', 'b2']);
    await click($('[data-plan-bucket="b1"]'));
    expect(env.bucketWrites.at(-1)).toEqual(['b2']);
    expect($('[data-plan-buckets-save]')?.textContent).toBe('Saved');
    // No Save button: the picks autosave.
    const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(buttons).not.toContain('Save');
  });

  it('the add chip turns into a field; Enter creates the bucket and picks it', async () => {
    await render(
      <PlanItemScreen open bundle={BUNDLE} item={PLANNED} side="agency" onClose={() => {}} />,
    );
    await click($('[data-plan-bucket-add]'));
    const input = $('[data-plan-bucket-new] input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, 'Recipes');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = $('[data-plan-bucket-new]') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(env.created).toBe(1);
    expect(env.bucketWrites.at(-1)).toEqual(['b1', 'new']);
  });

  it('a client reads the buckets as Tags, never chips', async () => {
    await render(
      <PlanItemScreen
        open
        bundle={{ ...BUNDLE, plan: { ...BUNDLE.plan, audience: 'client' } }}
        item={PLANNED}
        side="client"
        onClose={() => {}}
      />,
    );
    expect($('[data-plan-buckets]')?.textContent).toContain('Launch');
    expect($('[data-plan-bucket]')).toBeNull();
    expect($('[data-plan-bucket-add]')).toBeNull();
  });
});

describe('Who can see this (bank idea, agency)', () => {
  it('team only: the tag, the line and Show to client', async () => {
    env.read = readOf(IDEA);
    await render(<PlanItemScreen open item={IDEA} side="agency" onClose={() => {}} />);
    const card = $('[data-plan-who-can-see]');
    expect(card?.textContent).toContain('Team only');
    expect(card?.textContent).toContain(
      'The client sees it once it is in a shared plan, or when you show it.',
    );
    expect($('[data-plan-who-show]')).not.toBeNull();
  });

  it('client can see names the approvers; Hide waits behind the Undo strip', async () => {
    const shown = { ...IDEA, show_to_client: true };
    env.read = readOf(shown);
    await render(<PlanItemScreen open item={shown} side="agency" onClose={() => {}} />);
    expect($('[data-plan-who-can-see]')?.textContent).toContain('Client can see');
    expect($('[data-plan-who-line]')?.textContent).toBe('Asha see this idea and all its comments.');
    await click($('[data-plan-who-hide]'));
    expect($('[data-plan-who-can-see]')?.textContent).toContain('Team only');
    expect(text()).toContain('Idea hidden');
    expect(env.flagWrites).toEqual([]);
  });

  it('a planned concept has no Who can see card', async () => {
    await render(
      <PlanItemScreen open bundle={BUNDLE} item={PLANNED} side="agency" onClose={() => {}} />,
    );
    expect($('[data-plan-who-can-see]')).toBeNull();
  });
});

describe('More menu per kind', () => {
  it('a planned concept: Send to chat and Move to bank above Remove from plan', async () => {
    await render(
      <PlanItemScreen open bundle={BUNDLE} item={PLANNED} side="agency" onClose={() => {}} />,
    );
    await click($('[data-plan-item-more]'));
    const rows = menuLabels();
    const at = (l: string) => rows.findIndex((r) => r.includes(l));
    expect(at('Send to chat')).toBeGreaterThan(-1);
    expect(at('Move to bank')).toBeGreaterThan(at('Edit concept'));
    expect(at('Remove from plan')).toBe(rows.length - 1);
    expect(at('Move to bank')).toBe(rows.length - 2);
  });

  it('a bank idea: Plan it, Edit idea, Send to chat, Show, Star, Archive, Delete last', async () => {
    env.read = readOf(IDEA);
    await render(<PlanItemScreen open item={IDEA} side="agency" onClose={() => {}} />);
    await click($('[data-plan-item-more]'));
    const rows = menuLabels();
    expect(rows.map((r) => r.replace(/\s+/g, ' '))).toEqual([
      'Plan it',
      'Edit idea',
      'Send to chat',
      'Show to client',
      'Star',
      'Archive',
      'Delete',
    ]);
    await click(menuItem('Send to chat'));
    expect($(`[data-test-share="${IDEA.id}"]`)).not.toBeNull();
  });

  it('a client gets no More menu on a bank idea or a planned concept', async () => {
    env.read = readOf({ ...IDEA, show_to_client: true });
    await render(
      <PlanItemScreen
        open
        item={{ ...IDEA, show_to_client: true }}
        side="client"
        onClose={() => {}}
      />,
    );
    expect($('[data-plan-item-more]')).toBeNull();
    expect($('[data-plan-who-can-see]')).toBeNull();
  });
});

describe('Move to bank', () => {
  it('the screen goes back at once; the write waits for the Undo strip', async () => {
    const removed = vi.fn();
    await render(
      <PlanItemScreen
        open
        bundle={BUNDLE}
        item={PLANNED}
        side="agency"
        onClose={() => {}}
        onRemoved={removed}
      />,
    );
    await click($('[data-plan-item-more]'));
    await click(menuItem('Move to bank'));
    expect(removed).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Moved to bank');
    expect(env.toBank).toBe(0);
  });
});

describe('Plan it (usePlanIt)', () => {
  it('a past day says so', async () => {
    let run: ((idea: BankIdea, day: string) => Promise<void>) | null = null;
    function Harness(): ReactElement {
      const flow = usePlanIt({
        workspaceId: 'ws',
        today: '2026-11-06',
        getPlans: async () => ({ ok: true, data: [] }),
        onPlaced: () => {},
        onUnplaced: () => {},
      });
      run = flow.runFor;
      return flow.sheets;
    }
    await render(<Harness />);
    const idea = { ...IDEA, comment_count: 0, file_count: 0, thumb: null, format: null };
    await act(async () => {
      await run?.(idea, '2026-11-01');
    });
    await settle();
    expect(text()).toContain("Couldn't plan it. Past days can't be planned.");
  });
});
