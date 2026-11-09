// @vitest-environment jsdom
// The Bank's select bar (ui/SelectBar): Cancel, "N selected", All, then every
// row the card's old ⋮ menu held. Open, Plan it and Send to chat show for one
// idea only; Show / Hide, Star / Unstar, Archive / Unarchive follow the
// selection; Delete is last in bad ink.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BankIdea } from '@/lib/chat/plans';
import { BankSelectBar, bankSelectActions, type BankSelectHandlers } from './BankSelectBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function idea(id: string, over: Partial<BankIdea> = {}): BankIdea {
  return {
    id,
    plan_id: null,
    kind: 'concept',
    position: 0,
    title: id,
    description: null,
    post_id: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    target_date: null,
    show_to_client: false,
    archived_at: null,
    starred_at: null,
    last_active_at: '2026-10-01T00:00:00Z',
    came_from_plan_title: null,
    bucket_ids: [],
    comment_count: 0,
    file_count: 0,
    thumb: null,
    format: null,
    ...over,
  };
}

const STARRED = '2026-10-02T00:00:00Z';

let root: Root;
let host: HTMLDivElement;
const calls = {
  onCancel: vi.fn(),
  onAll: vi.fn(),
  onOpen: vi.fn(),
  onPlanIt: vi.fn(),
  onSend: vi.fn(),
  onShow: vi.fn(),
  onHide: vi.fn(),
  onStar: vi.fn(),
  onArchive: vi.fn(),
  onDelete: vi.fn(),
};
const handlers: BankSelectHandlers = calls;

function render(picked: BankIdea[]): void {
  act(() => root.render(<BankSelectBar picked={picked} {...calls} />));
}

const q = (sel: string): HTMLButtonElement => {
  const el = host.querySelector<HTMLButtonElement>(sel);
  if (el === null) throw new Error(sel);
  return el;
};
const actionIds = (): string[] =>
  [...host.querySelectorAll('[data-select-bar-action]')].map(
    (el) => el.getAttribute('data-select-bar-action') ?? '',
  );

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  for (const fn of Object.values(calls)) fn.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('BankSelectBar', () => {
  it('is the shared SelectBar: "N selected", Cancel and All wired', () => {
    render([idea('a'), idea('b'), idea('c')]);
    expect(host.querySelector('[data-bank-select-bar]')).not.toBeNull();
    expect(q('[data-select-bar]').getAttribute('aria-label')).toBe('Selected ideas');
    expect(q('[data-select-bar-count]').textContent).toBe('3 selected');
    act(() => q('[data-select-bar-cancel]').click());
    act(() => q('[data-bank-select-all]').click());
    expect(calls.onCancel).toHaveBeenCalledTimes(1);
    expect(calls.onAll).toHaveBeenCalledTimes(1);
  });

  it('one idea: every old menu row, Delete last', () => {
    render([idea('a')]);
    expect(actionIds()).toEqual([
      'open',
      'plan-it',
      'send-to-chat',
      'show',
      'star',
      'archive',
      'delete',
    ]);
    expect(host.querySelector('[data-bank-select-select]')).toBeNull();
  });

  it('several ideas: Open, Plan it and Send to chat leave the bar', () => {
    render([idea('a'), idea('b')]);
    expect(actionIds()).toEqual(['show', 'star', 'archive', 'delete']);
  });

  it('the one-idea rows run on the ticked idea', () => {
    const a = idea('a');
    render([a]);
    act(() => q('[data-bank-select-open]').click());
    act(() => q('[data-bank-select-plan-it]').click());
    act(() => q('[data-bank-select-send]').click());
    expect(calls.onOpen).toHaveBeenCalledWith(a);
    expect(calls.onPlanIt).toHaveBeenCalledWith(a);
    expect(calls.onSend).toHaveBeenCalledWith(a);
  });

  it('Archive and Delete run on every ticked idea; Delete in bad ink', () => {
    const list = [idea('a'), idea('b')];
    render(list);
    act(() => q('[data-bank-select-archive]').click());
    act(() => q('[data-bank-select-delete]').click());
    expect(calls.onArchive).toHaveBeenCalledWith(list, true);
    expect(calls.onDelete).toHaveBeenCalledWith(list);
    expect(q('[data-bank-select-delete]').className).toContain('text-bad');
    expect(q('[data-bank-select-delete]').getAttribute('aria-label')).toBe('Delete');
  });
});

describe('bankSelectActions: the toggles follow the selection', () => {
  const byId = (picked: BankIdea[], id: string) =>
    bankSelectActions(picked, handlers).find((a) => a.id === id);

  beforeEach(() => {
    for (const fn of Object.values(calls)) fn.mockClear();
  });

  it('every idea starred reads Unstar; else Star, which stars only the rest', () => {
    const s1 = idea('s1', { starred_at: STARRED });
    const s2 = idea('s2', { starred_at: STARRED });
    const u = idea('u');
    expect(byId([s1, s2], 'unstar')?.label).toBe('Unstar');
    expect(byId([s1, s2], 'star')).toBeUndefined();
    byId([s1, s2], 'unstar')?.onSelect();
    expect(calls.onStar).toHaveBeenLastCalledWith([s1, s2], false);
    expect(byId([s1, u], 'star')?.label).toBe('Star');
    byId([s1, u], 'star')?.onSelect();
    expect(calls.onStar).toHaveBeenLastCalledWith([u], true);
  });

  it('every idea shown reads Hide from client; else Show to client for the rest', () => {
    const shown = idea('s', { show_to_client: true });
    const team = idea('t');
    expect(byId([shown], 'hide')?.label).toBe('Hide from approvers');
    byId([shown], 'hide')?.onSelect();
    expect(calls.onHide).toHaveBeenCalledWith([shown]);
    expect(byId([shown, team], 'show')?.label).toBe('Show to approvers');
    byId([shown, team], 'show')?.onSelect();
    expect(calls.onShow).toHaveBeenCalledWith([team]);
  });

  it('every idea archived reads Unarchive; else Archive for the live ones', () => {
    const old = idea('o', { archived_at: STARRED });
    const live = idea('l');
    expect(byId([old], 'unarchive')?.label).toBe('Unarchive');
    byId([old], 'unarchive')?.onSelect();
    expect(calls.onArchive).toHaveBeenLastCalledWith([old], false);
    byId([old, live], 'archive')?.onSelect();
    expect(calls.onArchive).toHaveBeenLastCalledWith([live], true);
  });

  it('marks Open, Plan it and Send to chat single; nothing reads Select', () => {
    const actions = bankSelectActions([idea('a')], handlers);
    expect(actions.filter((a) => a.single === true).map((a) => a.id)).toEqual([
      'open',
      'plan-it',
      'send-to-chat',
    ]);
    expect(actions.map((a) => a.label)).not.toContain('Select');
    expect(actions[actions.length - 1]?.id).toBe('delete');
  });
});
