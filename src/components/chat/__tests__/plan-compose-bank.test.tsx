// @vitest-environment jsdom
// New plan: flat rows and Add from bank. The bank sheet is stubbed to tick
// ideas through its many-pick `multi` prop; the post picker to tick a post.
// Create sends one planCreateWithItems call carrying p_bank ({ item_id,
// target_date }, null for No date, [] when no idea), and every moved idea
// leaves the kept Bank pages through PLAN_CHANGED_EVENT (a BankChange `out`).
// The Add from bank row is the agency's only.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const h = vi.hoisted(() => ({
  side: 'agency' as 'agency' | 'client',
  create: vi.fn(),
}));

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/components/chat/AssetPicker', () => ({ AssetPicker: () => null }));
vi.mock('@/lib/chat/use-chat-attachments', () => ({
  useCommentAttachments: () => ({ canAttach: false, uploadFile: undefined }),
}));
vi.mock('@/lib/chat/viewer-role', () => ({
  useViewerSide: () => ({ side: h.side, ready: true }),
}));
vi.mock('@srtdio/rpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@srtdio/rpc')>()),
  planCreateWithItems: (...args: unknown[]) => h.create(...args) as unknown,
}));
vi.mock('@/components/chat/PostPicker', () => ({
  PostPicker: (props: { open: boolean; onToggle: (post: unknown) => void }) =>
    props.open ? (
      <button
        type="button"
        data-fake-post=""
        onClick={() =>
          props.onToggle({ id: 'post1', title: 'Teaser', stage: 'review', target_date: null })
        }
      />
    ) : null,
}));
vi.mock('@/components/pages/plan-tab/BankPickSheet', () => ({
  BankPickSheet: (props: {
    open: boolean;
    multi?: { selected: ReadonlySet<string>; onToggle: (idea: unknown) => void };
  }) =>
    props.open && props.multi !== undefined ? (
      <div data-fake-bank="">
        {['idea1', 'idea2'].map((id) => (
          <button
            key={id}
            type="button"
            data-fake-idea={id}
            data-ticked={props.multi?.selected.has(id) === true ? 'on' : 'off'}
            onClick={() =>
              props.multi?.onToggle({
                id,
                title: `Idea ${id}`,
                thumb: null,
                file_count: 0,
                comment_count: 0,
                format: null,
              })
            }
          />
        ))}
      </div>
    ) : null,
}));

import {
  COMPOSE_NO_ITEMS,
  ADD_FROM_BANK_LABEL,
  PlanComposeScreen,
  composeBankArgs,
  composeBankFrom,
  recheckNewPlanItems,
  type NewPlanItem,
} from '@/components/chat/PlanComposeScreen';
import { ToastProvider } from '@/components/ui/toast';
import { PLAN_CHANGED_EVENT, bankChangeOf, type BankChange, type BankIdea } from '@/lib/chat/plans';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RANGE = { startsOn: '2026-11-16', endsOn: '2026-11-22' };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => act(async () => wait(80));
const q = <T extends Element = HTMLElement>(sel: string): T | null =>
  document.querySelector<T>(sel);

let root: Root | null = null;

function Screen(): ReactElement {
  return (
    <ToastProvider>
      <PlanComposeScreen
        open
        workspaceId="ws1"
        timeZone="UTC"
        initialRange={RANGE}
        onClose={() => undefined}
        onCreated={() => undefined}
      />
    </ToastProvider>
  );
}

async function mount(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Screen />));
  await settle();
}

async function click(sel: string): Promise<void> {
  const el = q(sel);
  if (el === null) throw new Error(`missing ${sel}`);
  await act(async () => el.click());
  await settle();
}

async function typeTitle(value: string): Promise<void> {
  const field = q<HTMLInputElement>('[data-plan-title]');
  if (field === null) throw new Error('no title field');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

type CreateArgs = { p_bank: Array<{ item_id: string; target_date: string | null }> } & Record<
  string,
  unknown
>;
const sent = (): CreateArgs => h.create.mock.calls[0]?.[1] as CreateArgs;

beforeEach(() => {
  h.side = 'agency';
  h.create.mockReset();
  h.create.mockResolvedValue({ ok: true, data: 'plan9' });
});

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  await settle();
});

describe('New plan: Add from bank', () => {
  it('the empty copy names bank ideas', async () => {
    expect(COMPOSE_NO_ITEMS).toBe('Concepts, posts, drafts and bank ideas you add show up here.');
    await mount();
    expect(document.body.textContent).toContain(COMPOSE_NO_ITEMS);
  });

  it('agency: a fourth plain Add row opens the bank sheet in many-pick mode', async () => {
    await mount();
    const row = q('[data-plan-add-bank]');
    expect(row?.textContent).toBe(ADD_FROM_BANK_LABEL);
    expect(q('[data-fake-bank]')).toBeNull();
    await click('[data-plan-add-bank]');
    expect(q('[data-fake-bank]')).not.toBeNull();
  });

  it('client side: no Add from bank row and no bank sheet', async () => {
    h.side = 'client';
    await mount();
    expect(q('[data-plan-add-bank]')).toBeNull();
    expect(document.body.textContent).not.toContain(ADD_FROM_BANK_LABEL);
    expect(q('[data-plan-add-concept]')).not.toBeNull();
  });

  it('picked ideas show in Items once each; a second tick takes it out', async () => {
    await mount();
    await click('[data-plan-add-bank]');
    await click('[data-fake-idea="idea1"]');
    await click('[data-fake-idea="idea2"]');
    expect(document.querySelectorAll('[data-plan-compose-item="bank"]')).toHaveLength(2);
    expect(q('[data-fake-idea="idea1"]')?.getAttribute('data-ticked')).toBe('on');
    await click('[data-fake-idea="idea2"]');
    expect(document.querySelectorAll('[data-plan-compose-item="bank"]')).toHaveLength(1);
    // A picked idea starts at No date, and remove works.
    expect(
      q('[data-plan-compose-item="bank"] [data-plan-day-button]')?.getAttribute(
        'data-plan-day-button',
      ),
    ).toBe('none');
    await click('[data-plan-compose-item="bank"] [data-plan-compose-remove]');
    expect(document.querySelectorAll('[data-plan-compose-item="bank"]')).toHaveLength(0);
  });

  it('create sends p_bank with each idea (a day, or null for No date) in one call', async () => {
    const changes: BankChange[] = [];
    const listen = (e: Event): void => {
      const c = bankChangeOf(e);
      if (c !== null) changes.push(c);
    };
    window.addEventListener(PLAN_CHANGED_EVENT, listen);
    await mount();
    await typeTitle('Diwali week');
    await click('[data-plan-add-bank]');
    await click('[data-fake-idea="idea1"]');
    await click('[data-fake-idea="idea2"]');
    // idea1 goes on Wed 18 Nov; idea2 stays No date.
    await click('[data-plan-compose-item="bank"] [data-plan-day-button]');
    await click('[data-plan-day-tile="2026-11-18"]');
    await click('[data-plan-create]');
    await settle();
    window.removeEventListener(PLAN_CHANGED_EVENT, listen);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(sent().p_bank).toEqual([
      { item_id: 'idea1', target_date: '2026-11-18' },
      { item_id: 'idea2', target_date: null },
    ]);
    expect(sent().p_concepts).toEqual([]);
    expect(sent().p_posts).toEqual([]);
    // The moved ideas leave the kept Bank pages: one `out` each, no read.
    expect(changes).toEqual([
      { kind: 'out', itemId: 'idea1' },
      { kind: 'out', itemId: 'idea2' },
    ]);
  });

  it('with no bank idea, p_bank is [] and nothing is dropped from the Bank', async () => {
    const changes: BankChange[] = [];
    const listen = (e: Event): void => {
      const c = bankChangeOf(e);
      if (c !== null) changes.push(c);
    };
    window.addEventListener(PLAN_CHANGED_EVENT, listen);
    await mount();
    await typeTitle('Diwali week');
    await click('[data-plan-add-posts]');
    await click('[data-fake-post]');
    await click('[data-plan-create]');
    await settle();
    window.removeEventListener(PLAN_CHANGED_EVENT, listen);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(sent().p_bank).toEqual([]);
    expect(sent().p_posts).toEqual([{ post_id: 'post1', target_date: null }]);
    expect(changes).toEqual([]);
  });

  it('a failed create drops nothing from the Bank', async () => {
    h.create.mockResolvedValue({ ok: false, error: { code: 'x', message: 'Failed to fetch' } });
    const changes: BankChange[] = [];
    const listen = (e: Event): void => {
      const c = bankChangeOf(e);
      if (c !== null) changes.push(c);
    };
    window.addEventListener(PLAN_CHANGED_EVENT, listen);
    await mount();
    await typeTitle('Diwali week');
    await click('[data-plan-add-bank]');
    await click('[data-fake-idea="idea1"]');
    await click('[data-plan-create]');
    await settle();
    window.removeEventListener(PLAN_CHANGED_EVENT, listen);
    expect(changes).toEqual([]);
    expect(q('[data-plan-share-error]')?.textContent).toContain("Couldn't create the plan.");
  });
});

describe('New plan: bank helpers (pure)', () => {
  const idea = (id: string): BankIdea => ({ id, title: `Idea ${id}` }) as unknown as BankIdea;

  it('composeBankArgs: each idea once, No date and a needed day are null; [] when none', () => {
    const items: NewPlanItem[] = [
      { ...composeBankFrom(idea('a')), day: '2026-11-17' },
      composeBankFrom(idea('b')),
      { ...composeBankFrom(idea('a')), day: '2026-11-19' },
    ];
    expect(composeBankArgs(items)).toEqual([
      { item_id: 'a', target_date: '2026-11-17' },
      { item_id: 'b', target_date: null },
    ]);
    expect(composeBankArgs([])).toEqual([]);
    expect(composeBankFrom(idea('c')).day).toBe('none');
  });

  it('a range change sends a bank day now outside back to needing one', () => {
    const items: NewPlanItem[] = [
      { ...composeBankFrom(idea('a')), day: '2026-11-17' },
      composeBankFrom(idea('b')),
    ];
    const next = recheckNewPlanItems(items, { startsOn: '2026-11-18', endsOn: '2026-11-24' });
    expect(next.map((i) => i.day)).toEqual([null, 'none']);
  });
});

describe('New plan: flat look (source)', () => {
  // jsdom gives import.meta.url a non-file scheme: read from the repo root.
  const src = readFileSync(
    join(process.cwd(), 'src/components/chat/PlanComposeScreen.tsx'),
    'utf8',
  );

  it('dates row and rows are hairline separated, no boxes; Add rows are plain PressableRows', () => {
    expect(src).toMatch(/data-plan-dates-row=""\s+className="[^"]*border-y border-border/);
    expect(src).not.toContain('rounded-xl bg-panel-2 pl-3 pr-1 lit-card-muted');
    expect(src).not.toContain('rounded-xl border p-3 lit-card-muted');
    expect(src).not.toContain('border-dashed border-border-strong text-accent');
    expect(src).toMatch(/<PressableRow\s+type="button"\s+flat\s+data-plan-add-bank=""/);
    expect(src.match(/planCreateWithItems\(/g)).toHaveLength(1);
  });
});
