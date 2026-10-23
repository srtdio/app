// @vitest-environment jsdom
// W5 FB1: the New brief sheet never loses work silently. Dirty (any text, a
// file, an upload in flight or failed) makes Esc, X, backdrop and system Back
// ask "Discard this brief?"; while Create is in flight every close path,
// footer Cancel included, does nothing. Create waits for uploads and is
// blocked by a failed one. Required fields error inline, never disable Create.
import { act, useEffect, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateBriefSheet } from '@/components/pages/CreateBriefSheet';
import { resetHistorySteps } from '@/lib/chat/use-history-step';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A controllable AttachmentsField: the test sets how many uploads are pending
// and whether a failed row (the real field's Dismiss button) is showing.
const uploads = vi.hoisted(() => ({
  pending: 0,
  failed: false,
  listeners: new Set<() => void>(),
  set(next: { pending?: number; failed?: boolean }): void {
    if (next.pending !== undefined) this.pending = next.pending;
    if (next.failed !== undefined) this.failed = next.failed;
    this.listeners.forEach((listener) => listener());
  },
}));

vi.mock('@/components/pages/create/AttachmentsField', () => ({
  attachmentVersionIds: (items: { versionId: string }[]) => items.map((item) => item.versionId),
  AttachmentsField: ({ onPendingChange }: { onPendingChange?: (count: number) => void }) => {
    const snap = useSyncExternalStore(
      (listener) => {
        uploads.listeners.add(listener);
        return () => uploads.listeners.delete(listener);
      },
      () => `${uploads.pending}:${String(uploads.failed)}`,
    );
    const [pending, failed] = snap.split(':');
    useEffect(() => {
      onPendingChange?.(Number(pending));
    }, [pending, onPendingChange]);
    return failed === 'true' ? (
      <ul>
        <li>
          photo.png <button aria-label="Dismiss photo.png">x</button>
        </li>
      </ul>
    ) : null;
  },
}));
vi.mock('@/components/ui/Select', () => ({ Select: () => null }));
vi.mock('@/components/ui/DatePicker', () => ({ DatePicker: () => null }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/workspace-context-platform', () => ({ useWorkspacePlatform: () => 'instagram' }));
const { briefCreate } = vi.hoisted(() => ({ briefCreate: vi.fn() }));
vi.mock('@srtdio/rpc', () => ({ briefCreate: (...args: unknown[]) => briefCreate(...args) }));
vi.mock('@srtdio/comments', () => ({
  createComment: vi.fn(async () => ({ ok: true, data: 'c' })),
}));

let root: Root | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => act(async () => wait(60));

async function mount() {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CreateBriefSheet open workspaceId="w1" onClose={onClose} onCreated={onCreated} />,
    );
  });
  await settle();
  return { onClose, onCreated };
}

const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]');
const confirm = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );
const createButton = () =>
  document.querySelector<HTMLButtonElement>('[data-induction="brief-sheet-create"]') ??
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    /Create brief|Uploading|Creating/.test(b.textContent ?? ''),
  );

async function type(id: string, value: string): Promise<void> {
  const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function fillRequired(): Promise<void> {
  await type('brief-title', 'Diwali teaser');
  await type('brief-objective', 'Build hype for the drop');
}

async function press(key: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

beforeEach(() => {
  resetHistorySteps();
  uploads.pending = 0;
  uploads.failed = false;
  briefCreate.mockReset();
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

describe('CreateBriefSheet: dirty close paths ask first', () => {
  it('Esc with text asks "Discard this brief?" and keeps the sheet', async () => {
    const { onClose } = await mount();
    await type('brief-title', 'Draft');
    await press('Escape');
    expect(confirm()?.textContent).toContain('Discard this brief?');
    expect(confirm()?.textContent).toContain('Your brief and files will be lost.');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('the X with text asks', async () => {
    const { onClose } = await mount();
    await type('brief-objective', 'Something');
    await act(async () =>
      sheet()?.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click(),
    );
    expect(confirm()?.textContent).toContain('Discard this brief?');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a backdrop tap with text asks', async () => {
    const { onClose } = await mount();
    await type('brief-brand-requirements', 'Navy and gold only');
    await act(async () => {
      sheet()?.parentElement?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(confirm()?.textContent).toContain('Discard this brief?');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('system Back with text asks and the sheet stays', async () => {
    const { onClose } = await mount();
    await type('brief-initial-comment', 'Hi team');
    await settle();
    await act(async () => {
      window.history.back();
      await wait(60);
    });
    expect(sheet()).not.toBeNull();
    expect(confirm()?.textContent).toContain('Discard this brief?');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('an upload in flight alone makes the sheet dirty', async () => {
    const { onClose } = await mount();
    await act(async () => uploads.set({ pending: 1 }));
    await press('Escape');
    expect(confirm()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a clean sheet closes on Esc without asking', async () => {
    const { onClose } = await mount();
    await press('Escape');
    expect(confirm()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('CreateBriefSheet: every close path is blocked while submitting', () => {
  it('Esc, X, backdrop and Cancel do nothing until the create settles', async () => {
    let finish: (value: unknown) => void = () => {};
    briefCreate.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const { onClose, onCreated } = await mount();
    await fillRequired();
    await act(async () => createButton()?.click());
    expect(briefCreate).toHaveBeenCalledTimes(1);
    expect(createButton()?.textContent).toContain('Creating…');

    await press('Escape');
    await act(async () =>
      sheet()?.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click(),
    );
    await act(async () => {
      sheet()?.parentElement?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => button('Cancel')?.click());
    expect(onClose).not.toHaveBeenCalled();
    expect(confirm()).toBeNull();

    await act(async () => finish({ ok: true, data: 'brief-9' }));
    expect(onCreated).toHaveBeenCalledWith({ briefId: 'brief-9', noteFailed: false });
  });
});

describe('CreateBriefSheet: Create and uploads', () => {
  it('mid-upload, Create says "Uploading 2 files…", stays enabled, and does not submit', async () => {
    await mount();
    await fillRequired();
    await act(async () => uploads.set({ pending: 2 }));
    const create = createButton();
    expect(create?.textContent).toContain('Uploading 2 files…');
    expect(create?.disabled).toBe(false);
    await act(async () => create?.click());
    expect(briefCreate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Wait for 2 files to finish');
  });

  it('a failed upload blocks Create with "Remove or retry the failed file"', async () => {
    await mount();
    await fillRequired();
    await act(async () => uploads.set({ failed: true }));
    await settle();
    await act(async () => createButton()?.click());
    expect(briefCreate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Remove or retry the failed file');
  });

  it('Create is never disabled for missing fields: a tap shows inline required errors', async () => {
    await mount();
    const create = createButton();
    expect(create?.disabled).toBe(false);
    await act(async () => create?.click());
    expect(briefCreate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Title is required.');
    expect(document.body.textContent).toContain('Objective is required.');
  });

  it('a failed create shows plain copy, never the server text', async () => {
    briefCreate.mockResolvedValue({
      ok: false,
      error: { code: 'unknown', message: 'duplicate key value violates constraint' },
    });
    await mount();
    await fillRequired();
    await act(async () => createButton()?.click());
    expect(document.body.textContent).not.toContain('duplicate key');
    expect(document.body.textContent).toContain("Couldn't create the brief. Try again.");
  });
});

describe('CreateBriefSheet: fields', () => {
  it('orders the fields and labels the optional ones', async () => {
    await mount();
    const labels = [...document.querySelectorAll('label')].map((l) => l.textContent?.trim());
    expect(labels).toEqual([
      'Title*',
      'Objective*',
      'Brand requirements (optional)',
      'Format (optional)',
      'Target date (optional)',
      'Attachments',
      'Note to agency (optional)',
    ]);
    expect(document.body.textContent).toContain("Once sent, a brief can't be edited.");
    expect(document.body.textContent).not.toContain('Briefs are written by approvers');
  });

  it('Enter in Title moves focus to Objective; Title hints "next"', async () => {
    await mount();
    const title = document.getElementById('brief-title') as HTMLInputElement;
    expect(title.getAttribute('enterkeyhint')).toBe('next');
    await act(async () => {
      title.focus();
      title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(document.activeElement?.id).toBe('brief-objective');
  });

  it('sends brand requirements as brand_requirements', async () => {
    briefCreate.mockResolvedValue({ ok: true, data: 'brief-1' });
    await mount();
    await fillRequired();
    await type('brief-brand-requirements', 'Use the gold logo');
    await act(async () => createButton()?.click());
    const args = briefCreate.mock.calls[0]?.[1] as { p_payload: Record<string, unknown> };
    expect(args.p_payload.brand_requirements).toBe('Use the gold logo');
  });
});
