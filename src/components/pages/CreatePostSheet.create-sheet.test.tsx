// @vitest-environment jsdom
// The New post sheet (A. Create sheet): Title first and required, the header's
// save buttons, the 4,000 caption cap, the discard prompt only with changes,
// and the draft strip's Undo.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToastOptions } from '@/components/ui/toast/types';

const h = vi.hoisted(() => ({
  postCreate: vi.fn(),
  gallerySet: vi.fn(),
  stage: vi.fn(),
  softDelete: vi.fn(),
  toastShow: vi.fn(),
}));

vi.mock('@/lib/workspace-context-platform', () => ({
  useWorkspacePlatform: (id: string | null) => (id === 'ws-1' ? 'instagram' : null),
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceName: 'Kite', workspaceKey: null }),
}));
vi.mock('@/lib/session-context', () => ({ useSession: () => ({ session: null }) }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/buckets', () => ({
  BUCKET_NAME_MAX: 40,
  listBuckets: async () => ({ ok: true, data: [] }),
  createBucket: vi.fn(),
}));
vi.mock('@srtdio/briefs', () => ({ listBriefs: async () => ({ ok: true, data: [] }) }));
vi.mock('@/components/pages/create/AttachmentsField', () => ({
  AttachmentsField: () => <span data-attachments="" />,
  isMediaItem: () => false,
  attachmentVersionIds: () => [],
}));
vi.mock('@/components/ui/DatePicker', () => ({ DatePicker: () => null }));
vi.mock('@srtdio/rpc', () => ({
  postCreate: (...args: unknown[]) => h.postCreate(...args),
  gallerySet: (...args: unknown[]) => h.gallerySet(...args),
  stageTransition: (...args: unknown[]) => h.stage(...args),
  postSoftDelete: (...args: unknown[]) => h.softDelete(...args),
}));
vi.mock('@/components/ui/toast', async (orig) => ({
  ...(await orig<typeof import('@/components/ui/toast')>()),
  useOptionalToast: () => ({ show: h.toastShow, dismiss: () => {} }),
}));

import {
  CREATE_POST_DISCARD_TITLE,
  CreatePostSheet,
  DRAFT_UNDO_MS,
  TITLE_PLACEHOLDER,
  firstErrorField,
  requiredFieldErrors,
  serverFieldError,
  undoSavedDraft,
} from '@/components/pages/CreatePostSheet';
import { REASON_COPY } from '@/lib/error-copy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const onClose = vi.fn();
const onCreated = vi.fn();

beforeEach(() => {
  for (const m of [h.postCreate, h.gallerySet, h.stage, h.softDelete, h.toastShow]) m.mockReset();
  onClose.mockReset();
  onCreated.mockReset();
  h.postCreate.mockResolvedValue({ ok: true, data: 'p1' });
  h.stage.mockResolvedValue({ ok: true, data: null });
  h.softDelete.mockResolvedValue({ ok: true, data: 'p1' });
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = '';
});

function Where() {
  const location = useLocation();
  return <span data-path={location.pathname} />;
}

async function renderSheet(opts: { router?: boolean } = {}): Promise<void> {
  root = createRoot(host!);
  const sheet = <CreatePostSheet open workspaceId="ws-1" onClose={onClose} onCreated={onCreated} />;
  await act(async () => {
    root!.render(
      opts.router === true ? (
        <MemoryRouter initialEntries={['/posts/p1']}>
          <Routes>
            <Route
              path="*"
              element={
                <>
                  <Where />
                  {sheet}
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      ) : (
        sheet
      ),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const title = (): HTMLInputElement => document.querySelector<HTMLInputElement>('#post-title')!;
const caption = (): HTMLTextAreaElement =>
  document.querySelector<HTMLTextAreaElement>('#post-caption')!;
const header = (): HTMLElement => document.querySelector<HTMLElement>('[data-composer-header]')!;
const draftButton = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('button[data-submit="draft"]')!;
const reviewButton = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('button[data-submit="review"]')!;
const closeButton = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
const text = (): string => document.body.textContent ?? '';
function buttonByText(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => (b.textContent ?? '').trim() === label,
  );
}

describe('New post sheet: Title', () => {
  it('Title is the first field, always visible, required, focused on open, with the placeholder', async () => {
    await renderSheet();
    const fields = [...document.querySelectorAll('input, textarea, [data-attachments]')];
    expect(fields[0]).toBe(title());
    expect(title().getAttribute('placeholder')).toBe(TITLE_PLACEHOLDER);
    expect(TITLE_PLACEHOLDER).toBe('e.g. Monsoon drop, part one');
    expect(title().maxLength).toBe(200);
    const label = document.querySelector('label[for="post-title"]')!;
    expect(label.textContent).toBe('Title*');
    expect(document.activeElement).toBe(title());
  });

  it('a blank title blocks Save draft: nothing saves, the line shows, focus goes to Title, typing clears it', async () => {
    await renderSheet();
    await act(async () => setValue(caption(), 'Launch day'));
    caption().focus();
    await act(async () => draftButton().click());
    expect(h.postCreate).not.toHaveBeenCalled();
    expect(text()).toContain('Add a title to save.');
    expect(title().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(title());
    await act(async () => setValue(title(), 'M'));
    expect(text()).not.toContain('Add a title to save.');
    expect(title().hasAttribute('aria-invalid')).toBe(false);
  });

  it('a blank title blocks Send for review too, and the caption is never used as the title', async () => {
    await renderSheet();
    await act(async () => setValue(caption(), 'Launch day\nMore'));
    await act(async () => reviewButton().click());
    expect(h.postCreate).not.toHaveBeenCalled();
    expect(h.stage).not.toHaveBeenCalled();
    expect(text()).toContain('Add a title to save.');
  });

  it('the title counter shows from 180 characters', async () => {
    await renderSheet();
    await act(async () => setValue(title(), 'a'.repeat(179)));
    expect(document.querySelector('[data-title-count]')).toBeNull();
    await act(async () => setValue(title(), 'a'.repeat(180)));
    expect(document.querySelector('[data-title-count]')?.textContent).toBe('180 / 200');
  });

  it('a title_required refusal from the server shows on the Title field', async () => {
    h.postCreate.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unknown', message: 'title_required' },
    });
    await renderSheet();
    await act(async () => setValue(title(), 'Monsoon'));
    await act(async () => setValue(caption(), 'Launch day'));
    await act(async () => draftButton().click());
    expect(text()).toContain('Add a title to save.');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('New post sheet: header', () => {
  it('no footer; the header holds X, "New post", Save draft and Send for review in that order', async () => {
    await renderSheet();
    const head = header();
    const order = [...head.querySelectorAll('button, h2')].map(
      (el) => el.getAttribute('aria-label') ?? (el.textContent ?? '').trim(),
    );
    expect(order).toEqual(['Close', 'New post', 'Save draft', 'Send for review']);
    expect(draftButton().className).toContain('h-11');
    expect(reviewButton().className).toContain('bg-accent');
    expect(buttonByText('Cancel')).toBeUndefined();
  });

  it('Save draft in the header saves a draft', async () => {
    await renderSheet();
    await act(async () => setValue(title(), 'Monsoon drop'));
    await act(async () => setValue(caption(), 'Launch day'));
    await act(async () => draftButton().click());
    expect(h.postCreate).toHaveBeenCalledTimes(1);
    const args = h.postCreate.mock.calls[0]![1] as { p_payload: Record<string, unknown> };
    expect(args.p_payload).toMatchObject({ title: 'Monsoon drop', caption: 'Launch day' });
    expect(h.stage).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith('p1', { stage: 'draft', path: '/posts/p1' });
  });

  it('Send for review in the header saves and moves to review', async () => {
    await renderSheet();
    await act(async () => setValue(title(), 'Monsoon drop'));
    await act(async () => setValue(caption(), 'Launch day'));
    await act(async () => reviewButton().click());
    expect(h.postCreate).toHaveBeenCalledTimes(1);
    expect(h.stage.mock.calls[0]![1]).toMatchObject({ p_post_id: 'p1', p_to_stage: 'review' });
  });
});

describe('New post sheet: caption cap', () => {
  it('counts against 4,000 and refuses 4,001 characters with the line, no save', async () => {
    await renderSheet();
    const counter = (): HTMLElement => document.querySelector<HTMLElement>('[data-caption-count]')!;
    await act(async () => setValue(caption(), 'a'.repeat(142)));
    expect(counter().textContent).toBe('142 / 4,000');
    await act(async () => setValue(title(), 'Monsoon drop'));
    await act(async () => setValue(caption(), 'a'.repeat(4001)));
    expect(counter().textContent).toBe('4,001 / 4,000');
    expect(counter().hasAttribute('data-over')).toBe(true);
    await act(async () => draftButton().click());
    expect(h.postCreate).not.toHaveBeenCalled();
    expect(text()).toContain('Captions can be up to 4,000 characters.');
    expect(document.activeElement).toBe(caption());
  });

  it('exactly 4,000 characters saves', async () => {
    await renderSheet();
    await act(async () => setValue(title(), 'Monsoon drop'));
    await act(async () => setValue(caption(), 'a'.repeat(4000)));
    await act(async () => draftButton().click());
    expect(h.postCreate).toHaveBeenCalledTimes(1);
  });

  it('a caption_too_long refusal from the server shows on the caption', async () => {
    h.postCreate.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unknown', message: 'caption_too_long' },
    });
    await renderSheet();
    await act(async () => setValue(title(), 'Monsoon drop'));
    await act(async () => setValue(caption(), 'Launch day'));
    await act(async () => draftButton().click());
    expect(text()).toContain('Captions can be up to 4,000 characters.');
  });
});

describe('New post sheet: discard', () => {
  it('no changes: X closes at once, no prompt', async () => {
    await renderSheet();
    await act(async () => closeButton().click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain(CREATE_POST_DISCARD_TITLE);
  });

  it('any change: X asks "Discard changes?" with Keep editing and Discard, no line under it', async () => {
    expect(CREATE_POST_DISCARD_TITLE).toBe('Discard changes?');
    await renderSheet();
    await act(async () => setValue(title(), 'M'));
    await act(async () => closeButton().click());
    expect(onClose).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="alertdialog"][aria-label="Discard changes?"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.querySelector('[data-confirm-message]')).toBeNull();
    expect(buttonByText('Keep editing')).toBeDefined();
    await act(async () => buttonByText('Discard')!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('New post sheet: draft Undo', () => {
  it('the draft strip reads "Saved as draft" with Undo for 4s; Undo deletes the post and returns to Pipeline', async () => {
    await renderSheet({ router: true });
    await act(async () => setValue(title(), 'Monsoon drop'));
    await act(async () => setValue(caption(), 'Launch day'));
    await act(async () => draftButton().click());
    const shown = h.toastShow.mock.calls[0]![0] as ToastOptions;
    expect(shown).toMatchObject({ title: 'Saved as draft', kind: 'undo', durationMs: 4000 });
    expect(DRAFT_UNDO_MS).toBe(4000);
    expect(shown.action?.label).toBe('Undo');
    await act(async () => {
      shown.action!.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(h.softDelete).toHaveBeenCalledTimes(1);
    expect(h.softDelete.mock.calls[0]![1]).toEqual({ p_post_id: 'p1', p_trace_id: 'trace-1' });
    expect(document.querySelector('[data-path]')?.getAttribute('data-path')).toBe('/pipeline');
  });

  it('Sent for review has no Undo', async () => {
    await renderSheet();
    await act(async () => setValue(title(), 'Monsoon drop'));
    await act(async () => setValue(caption(), 'Launch day'));
    await act(async () => reviewButton().click());
    const shown = h.toastShow.mock.calls[0]![0] as ToastOptions;
    expect(shown.title).toBe('Sent for review');
    expect(shown.action).toBeUndefined();
  });

  it('undoSavedDraft: deletes, refreshes, then navigates; a refusal stays and reports', async () => {
    const navigate = vi.fn();
    const onDeleted = vi.fn();
    const onFailed = vi.fn();
    const ok = await undoSavedDraft({
      postId: 'p1',
      softDelete: async () => ({ ok: true, data: 'p1' }),
      navigate,
      onDeleted,
      onFailed,
    });
    expect(ok).toBe(true);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/pipeline');
    expect(onFailed).not.toHaveBeenCalled();

    navigate.mockReset();
    const refused = await undoSavedDraft({
      postId: 'p1',
      softDelete: async () => ({ ok: false, error: { code: 'unknown', message: 'nope' } }),
      navigate,
      onDeleted,
      onFailed,
    });
    expect(refused).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledWith({ code: 'unknown', message: 'nope' });

    const thrown = await undoSavedDraft({
      postId: 'p1',
      softDelete: async () => {
        throw new TypeError('Failed to fetch');
      },
      navigate: null,
      onDeleted,
      onFailed,
    });
    expect(thrown).toBe(false);
  });
});

describe('New post sheet: pure helpers', () => {
  it('requiredFieldErrors: title, caption, and the 4,000 cap', () => {
    expect(requiredFieldErrors({ title: '', caption: 'Hi', format: 'text' })).toEqual({
      title: 'Add a title to save.',
    });
    expect(requiredFieldErrors({ title: ' ', caption: '', format: 'text' })).toEqual({
      title: 'Add a title to save.',
      caption: 'Write a caption',
    });
    expect(requiredFieldErrors({ title: 'T', caption: 'a'.repeat(4001), format: 'text' })).toEqual({
      caption: 'Captions can be up to 4,000 characters.',
    });
    expect(requiredFieldErrors({ title: 'T', caption: 'a'.repeat(4000), format: 'text' })).toEqual(
      {},
    );
  });

  it('serverFieldError maps the two server refusals through error-copy', () => {
    expect(serverFieldError('caption_too_long')).toEqual({
      key: 'caption',
      text: REASON_COPY.caption_too_long,
    });
    expect(serverFieldError({ code: 'unknown', message: 'title_required' })).toEqual({
      key: 'title',
      text: REASON_COPY.title_required,
    });
    expect(serverFieldError('boom')).toBeNull();
  });

  it('firstErrorField follows the form order', () => {
    expect(firstErrorField({ caption: 'x', title: 'y' })).toBe('title');
    expect(firstErrorField({ caption: 'x' })).toBe('caption');
    expect(firstErrorField({ briefId: 'x' })).toBeNull();
  });
});
