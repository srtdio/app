// @vitest-environment jsdom
// Add idea: the Description is a ui/WritingBox in field mode (a plain field at
// rest; focused, the Aa row and Emoji inside its bottom edge; no @), its
// label still names the textarea, and typing still lands in the form.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/chat/use-chat-attachments', () => ({
  useCommentAttachments: () => ({ uploadFile: vi.fn() }),
}));
vi.mock('./BankFilterSheet', () => ({ BucketChips: () => null }));
vi.mock('./use-bank-data', () => ({ addBankIdea: vi.fn() }));

import { BankAddSheet } from '@/components/pages/plan-tab/BankAddSheet';
import { ToastProvider } from '@/components/ui/toast';
import { resetHistorySteps } from '@/lib/chat/use-history-step';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));

beforeEach(() => {
  resetHistorySteps();
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  await settle();
  resetHistorySteps();
});

async function mount(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <ToastProvider>
        <BankAddSheet
          open
          onClose={() => undefined}
          workspaceId="w1"
          buckets={[]}
          writes={{} as never}
          onBuckets={() => undefined}
          onAdded={() => undefined}
        />
      </ToastProvider>,
    ),
  );
  await settle();
}

describe('BankAddSheet description: ui/WritingBox field mode', () => {
  it('a field-mode box named by its label; Aa row and Emoji on focus, no @', async () => {
    await mount();
    const area = document.querySelector<HTMLTextAreaElement>('[data-bank-add-description]');
    const box = area?.closest<HTMLElement>('[data-writing-box]');
    expect(box?.dataset.mode).toBe('field');
    expect(area?.labels?.[0]?.textContent).toBe('Description');
    expect(box?.querySelector('[aria-label="Bold"]')).toBeNull();
    await act(async () => area?.focus());
    expect(box?.querySelector('[aria-label="Bold"]')).not.toBeNull();
    expect(box?.querySelector('[aria-label="Emoji"]')).not.toBeNull();
    expect(box?.querySelector('[aria-label="Mention"]')).toBeNull();
  });

  it('typing still reaches the form', async () => {
    await mount();
    const area = document.querySelector<HTMLTextAreaElement>('[data-bank-add-description]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(area, 'A reel idea');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(area.value).toBe('A reel idea');
  });
});
