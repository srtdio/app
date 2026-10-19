// @vitest-environment jsdom
// X3 / FB4 (V3 path): the New plan screen under a parent that owns its history
// step the way ChatConnected does (useHistoryStep(planCompose, close)). System
// Back on a half-built plan shows "Discard this plan?", the parent's close
// callback never runs, Keep editing keeps the title and items, and Discard
// closes through the parent with no stray history entry.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { useState } from 'react';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/components/chat/AssetPicker', () => ({ AssetPicker: () => null }));
vi.mock('@/components/chat/PostPicker', () => ({ PostPicker: () => null }));
vi.mock('@/lib/chat/use-chat-attachments', () => ({
  useCommentAttachments: () => ({ canAttach: false, uploadFile: undefined }),
}));
vi.mock('@/lib/use-media-query', () => ({
  LAPTOP_QUERY: '(min-width: 768px)',
  useMediaQuery: () => false,
}));

import { PlanComposeScreen } from '@/components/chat/PlanComposeScreen';
import { ToastProvider } from '@/components/ui/toast';
import { BACK_GUARD_STEP_KEY } from '@/lib/back-guard';
import {
  HISTORY_STEP_KEYS,
  resetHistorySteps,
  stepMarkerOf,
  useHistoryStep,
} from '@/lib/chat/use-history-step';
import { DUR_BASE_MS } from '@/lib/motion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const parentClose = vi.fn();
let setOpenOuter: ((open: boolean) => void) | null = null;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// jsdom traverses history on a queued task and fires popstate when it lands.
const settle = () => act(async () => wait(80));

/** ChatConnected's wiring: the compose layer is one history step whose Back closes it. */
function Parent(): ReactElement {
  const [open, setOpen] = useState(true);
  setOpenOuter = setOpen;
  useHistoryStep(open, HISTORY_STEP_KEYS.planCompose, () => {
    parentClose();
    setOpen(false);
  });
  return (
    <ToastProvider>
      <PlanComposeScreen
        open={open}
        workspaceId="ws"
        timeZone="UTC"
        onClose={() => setOpen(false)}
        onCreated={() => undefined}
      />
    </ToastProvider>
  );
}

// jsdom keeps one history across the file's tests, so the entry each test
// starts on is tagged: landing back on it means every step entry was popped.
let baseTag = 0;
async function mount(): Promise<void> {
  baseTag += 1;
  window.history.replaceState({ testBase: baseTag }, '', window.location.href);
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Parent />);
  });
  await settle();
}
const atBase = (): boolean =>
  (window.history.state as { testBase?: number } | null)?.testBase === baseTag;

const screen = () => document.querySelector<HTMLElement>('[data-plan-page="compose"]');
const confirm = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const titleField = () => document.querySelector<HTMLInputElement>('[data-plan-title]');
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);
const guarded = () => stepMarkerOf(window.history.state, BACK_GUARD_STEP_KEY) !== null;
const composeStep = () =>
  stepMarkerOf(window.history.state, HISTORY_STEP_KEYS.planCompose) !== null;

async function type(value: string): Promise<void> {
  const field = titleField();
  if (field === null) throw new Error('no title field');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

async function pressBack(): Promise<void> {
  await act(async () => {
    window.history.back();
    await wait(80);
  });
}

beforeEach(() => {
  resetHistorySteps();
  parentClose.mockReset();
});

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  setOpenOuter = null;
  document.body.innerHTML = '';
  // Let every pop an unmount issued land before the next test tags its base.
  await settle();
  await settle();
  resetHistorySteps();
});

describe('New plan: system Back under a real planCompose step', () => {
  it('an empty plan places no guard: Back closes through the parent', async () => {
    await mount();
    expect(composeStep()).toBe(true);
    expect(guarded()).toBe(false);
    await pressBack();
    expect(parentClose).toHaveBeenCalledTimes(1);
  });

  it('with a title typed, Back asks "Discard this plan?" and the parent close never runs', async () => {
    await mount();
    await type('Diwali week');
    expect(guarded()).toBe(true);
    await pressBack();
    expect(parentClose).not.toHaveBeenCalled();
    expect(screen()).not.toBeNull();
    const dialog = confirm();
    expect(dialog?.textContent).toContain('Discard this plan?');
    expect(button('Keep editing')).toBeDefined();
    expect(button('Discard')).toBeDefined();
    // The guard's entry is back on top: the next Back asks again.
    expect(guarded()).toBe(true);
  });

  it('Keep editing keeps the title; Back asks again', async () => {
    await mount();
    await type('Diwali week');
    await pressBack();
    await act(async () => {
      button('Keep editing')?.click();
      await wait(DUR_BASE_MS + 40);
    });
    expect(confirm()).toBeNull();
    expect(titleField()?.value).toBe('Diwali week');
    expect(parentClose).not.toHaveBeenCalled();
    await pressBack();
    expect(confirm()).not.toBeNull();
    expect(titleField()?.value).toBe('Diwali week');
  });

  it('Discard releases the guard and closes: the guard entry goes, nothing reopens', async () => {
    await mount();
    await type('Diwali week');
    await pressBack();
    await act(async () => button('Discard')?.click());
    await settle();
    await settle();
    // The guard's own entry was popped before the close; the screen is gone
    // and the chat's step callback never ran (the close came from onClose).
    expect(guarded()).toBe(false);
    expect(parentClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-plan-page="compose"]')).toBeNull();
    // The compose step pops its own entry right behind the guard's. jsdom
    // resolves two queued back() calls against the same index (a browser
    // steps twice), so the landing is checked one Back later: it is the
    // base entry, and nothing reopens.
    if (!atBase()) await pressBack();
    await settle();
    expect(atBase()).toBe(true);
    expect(composeStep()).toBe(false);
    expect(parentClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-plan-page="compose"]')).toBeNull();
  });

  it('closing the screen another way while clean leaves no entry', async () => {
    await mount();
    expect(composeStep()).toBe(true);
    await act(async () => setOpenOuter?.(false));
    await settle();
    await settle();
    expect(composeStep()).toBe(false);
    expect(guarded()).toBe(false);
    expect(atBase()).toBe(true);
  });
});
