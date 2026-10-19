// @vitest-environment jsdom
// X3 / FN25: the Concept sheet's footer Cancel goes through the discard guard:
// dirty asks "Discard this concept?", Keep editing keeps the form, Discard
// closes; a clean sheet closes at once.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/components/chat/AssetPicker', () => ({ AssetPicker: () => null }));

import { ConceptSheet, EMPTY_CONCEPT, type ConceptForm } from '@/components/chat/ConceptSheet';
import { ToastProvider } from '@/components/ui/toast';
import { resetHistorySteps } from '@/lib/chat/use-history-step';
import { DUR_BASE_MS } from '@/lib/motion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => act(async () => wait(60));

async function mount(form: ConceptForm) {
  const onClose = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <ToastProvider>
        <ConceptSheet
          open
          mode="add"
          form={form}
          onChange={() => undefined}
          onSubmit={() => undefined}
          onClose={onClose}
          range={{ startsOn: '2026-10-12', endsOn: '2026-10-18' }}
          today="2026-10-13"
        />
      </ToastProvider>,
    );
  });
  await settle();
  return { onClose };
}

const cancel = () => document.querySelector<HTMLButtonElement>('[data-plan-concept-cancel]');
const confirm = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);

beforeEach(() => resetHistorySteps());

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  await settle();
  resetHistorySteps();
});

describe('Concept sheet: footer Cancel through the guard', () => {
  it('a clean sheet closes at once', async () => {
    const { onClose } = await mount(EMPTY_CONCEPT);
    await act(async () => cancel()?.click());
    expect(confirm()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a dirty sheet asks; Keep editing keeps it open; Discard closes', async () => {
    const { onClose } = await mount({ ...EMPTY_CONCEPT, title: 'Plant tour reel' });
    await act(async () => cancel()?.click());
    expect(onClose).not.toHaveBeenCalled();
    expect(confirm()?.textContent).toContain('Discard this concept?');
    expect(confirm()?.textContent).toContain('Your concept will be lost.');
    await act(async () => {
      button('Keep editing')?.click();
      await wait(DUR_BASE_MS + 40);
    });
    expect(confirm()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('[data-plan-concept-title]')?.value).toBe(
      'Plant tour reel',
    );
    await act(async () => cancel()?.click());
    await act(async () => button('Discard')?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
