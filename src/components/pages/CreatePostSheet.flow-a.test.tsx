// @vitest-environment jsdom
// Post flow A: New post sheet fixes, one regression per fix number.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostPlatform } from '@srtdio/posts';
import type { Client, Result } from '@srtdio/rpc';
import type { Json } from '@srtdio/schemas';
import type { AttachmentItem } from '@/components/pages/create/AttachmentsField';

const h = vi.hoisted(() => ({
  platform: 'instagram' as PostPlatform,
  workspaceKey: null as string | null,
  number: null as number | null,
  postCreate: vi.fn(),
  gallerySet: vi.fn(),
  stage: vi.fn(),
  listBriefs: vi.fn(),
  toastShow: vi.fn(),
  captured: {
    onChange: null as ((items: AttachmentItem[]) => void) | null,
    onPendingChange: null as ((n: number) => void) | null,
    onFailedChange: null as ((n: number) => void) | null,
    onPickDone: null as ((items: AttachmentItem[]) => void) | null,
  },
}));

vi.mock('@/lib/workspace-context-platform', () => ({
  useWorkspacePlatform: (id: string | null) => (id === 'ws-1' ? h.platform : null),
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceName: 'Kite', workspaceKey: h.workspaceKey }),
}));
vi.mock('@/lib/session-context', () => ({ useSession: () => ({ session: null }) }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
// The new post's number reads back for its pretty link.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { number: h.number }, error: null }) }),
      }),
    }),
  },
}));
vi.mock('@/lib/buckets', () => ({
  BUCKET_NAME_MAX: 40,
  listBuckets: async () => ({ ok: true, data: [] }),
  createBucket: vi.fn(),
}));
vi.mock('@srtdio/briefs', () => ({
  listBriefs: (...args: unknown[]) => h.listBriefs(...args),
}));
vi.mock('@/components/pages/create/AttachmentsField', () => ({
  AttachmentsField: (props: {
    onChange: (items: AttachmentItem[]) => void;
    onPendingChange?: (n: number) => void;
    onFailedChange?: (n: number) => void;
    onPickDone?: (items: AttachmentItem[]) => void;
  }) => {
    h.captured.onChange = props.onChange;
    h.captured.onPendingChange = props.onPendingChange ?? null;
    h.captured.onFailedChange = props.onFailedChange ?? null;
    h.captured.onPickDone = props.onPickDone ?? null;
    return <span data-attachments="" />;
  },
  isMediaItem: (item: AttachmentItem) =>
    item.kind === 'image' || item.mime?.startsWith('video/') === true,
  attachmentVersionIds: (items: AttachmentItem[]) => items.map((i) => i.versionId),
}));
vi.mock('@/components/ui/DatePicker', () => ({ DatePicker: () => null }));
vi.mock('@srtdio/rpc', () => ({
  postCreate: (...args: unknown[]) => h.postCreate(...args),
  gallerySet: (...args: unknown[]) => h.gallerySet(...args),
  stageTransition: (...args: unknown[]) => h.stage(...args),
}));
vi.mock('@/components/ui/toast', async (orig) => ({
  ...(await orig<typeof import('@/components/ui/toast')>()),
  useOptionalToast: () => ({ show: h.toastShow, dismiss: () => {} }),
}));

import {
  BRIEF_HELPER,
  CreatePostSheet,
  FAILED_UPLOAD_FOOTER,
  MORE_OPTIONS_HINT,
  MORE_OPTIONS_LABEL,
  TITLE_HELPER,
  clearFieldError,
  createPostDiscard,
  createdPostPath,
  createdStripTitle,
  formatSourceLine,
  postCreateErrorMessage,
  requiredFieldErrors,
  submitCreatePost,
  type CreatedOutcome,
} from '@/components/pages/CreatePostSheet';
import { supabase } from '@/lib/supabase';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const onClose = vi.fn();
const onCreated = vi.fn<(postId: string, outcome?: CreatedOutcome) => void>();

beforeEach(() => {
  h.platform = 'instagram';
  h.workspaceKey = null;
  h.number = null;
  for (const m of [h.postCreate, h.gallerySet, h.stage, h.listBriefs, h.toastShow]) m.mockReset();
  onClose.mockReset();
  onCreated.mockReset();
  h.postCreate.mockResolvedValue({ ok: true, data: 'p1' });
  h.gallerySet.mockResolvedValue({ ok: true, data: 'g' });
  h.stage.mockResolvedValue({ ok: true, data: null });
  h.listBriefs.mockResolvedValue({ ok: true, data: [] });
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = '';
});

async function renderSheet(
  opts: { workspaceId?: string; initialBriefId?: string } = {},
): Promise<void> {
  root = createRoot(host!);
  await act(async () => {
    root!.render(
      <CreatePostSheet
        open
        workspaceId={opts.workspaceId ?? 'ws-1'}
        {...(opts.initialBriefId !== undefined ? { initialBriefId: opts.initialBriefId } : {})}
        onClose={onClose}
        onCreated={onCreated}
      />,
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

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => (b.textContent ?? '').trim() === text,
  );
}

const caption = (): HTMLTextAreaElement =>
  document.querySelector<HTMLTextAreaElement>('#post-caption')!;
const draftButton = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('button[data-submit="draft"]')!;
const reviewButton = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('button[data-submit="review"]')!;
const moreButton = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('button[data-more-options]')!;
const pill = (): string => document.querySelector('[data-format-pill]')?.textContent ?? '';
const sourceLine = (): string => document.querySelector('[data-format-source]')?.textContent ?? '';
const text = (): string => document.body.textContent ?? '';

async function typeCaption(value: string): Promise<void> {
  await act(async () => setValue(caption(), value));
}

async function openMoreOptions(): Promise<void> {
  if (moreButton().getAttribute('aria-expanded') !== 'true') {
    await act(async () => moreButton().click());
  }
}

/** True when a sits before b in the document. */
function before(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

const video: AttachmentItem = {
  versionId: 'v-video',
  kind: 'file',
  name: 'clip.mp4',
  mime: 'video/mp4',
};
const photo: AttachmentItem = {
  versionId: 'v-photo',
  kind: 'image',
  name: 'hero.jpg',
  mime: 'image/jpeg',
};
const doc = (id: string): AttachmentItem => ({
  versionId: id,
  kind: 'file',
  name: `${id}.pdf`,
  mime: 'application/pdf',
});

describe('CreatePostSheet flow A', () => {
  it('fix 10: Files, Format, Caption, then More options (Title, Bucket, Due date, Brief)', async () => {
    await renderSheet();
    const files = document.querySelector('[data-attachments]')!;
    const format = document.querySelector('[data-format-row]')!;
    expect(before(files, format)).toBe(true);
    expect(before(format, caption())).toBe(true);
    expect(before(caption(), moreButton())).toBe(true);
    expect(moreButton().textContent).toContain(MORE_OPTIONS_LABEL);
    expect(moreButton().textContent).toContain('Title, bucket, due date, brief');
    expect(MORE_OPTIONS_HINT).toBe('Title, bucket, due date, brief');
    expect(moreButton().getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('#post-title')).toBeNull();

    await openMoreOptions();
    expect(moreButton().getAttribute('aria-expanded')).toBe('true');
    const labels = [...document.querySelectorAll('#post-more-options label')].map((l) =>
      (l.textContent ?? '').trim(),
    );
    expect(labels).toEqual(['Title', 'Bucket', 'Due date', 'Brief']);
    expect(TITLE_HELPER).toBe("Left blank, it uses the caption's first line.");
    expect(text()).toContain(TITLE_HELPER);
  });

  it('fix 11: the first video sets Reel with "Set from your video" and the soft prompt stays quiet', async () => {
    expect(formatSourceLine('image')).toBe('Set from your photo');
    expect(formatSourceLine('video')).toBe('Set from your video');
    await renderSheet();
    expect(pill()).toBe('Single image');
    expect(sourceLine()).toBe('');
    await act(async () => h.captured.onChange?.([video]));
    expect(pill()).toBe('Reel');
    expect(sourceLine()).toBe('Set from your video');
    await act(async () => h.captured.onPickDone?.([video]));
    expect(text()).not.toContain('This format usually has');
  });

  it('fix 11: the first photo reads "Set from your photo"', async () => {
    await renderSheet();
    await act(async () => h.captured.onChange?.([photo]));
    expect(pill()).toBe('Single image');
    expect(sourceLine()).toBe('Set from your photo');
  });

  it('fix 11: picking a format by hand stops the auto-follow', async () => {
    await renderSheet();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Change format"]')!.click(),
    );
    const story = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (o) => o.textContent === 'Story',
    )!;
    await act(async () => story.click());
    expect(pill()).toBe('Story');
    await act(async () => h.captured.onChange?.([video]));
    expect(pill()).toBe('Story');
    expect(sourceLine()).toBe('');
  });

  it('fix 14: a failed file disables Save as draft and Send for review and says so', async () => {
    await renderSheet();
    await typeCaption('Hello');
    expect(draftButton().disabled).toBe(false);
    await act(async () => h.captured.onFailedChange?.(1));
    expect(draftButton().disabled).toBe(true);
    expect(reviewButton().disabled).toBe(true);
    expect(document.querySelector('[data-upload-failed-footer]')?.textContent).toBe(
      FAILED_UPLOAD_FOOTER,
    );
    expect(FAILED_UPLOAD_FOOTER).toBe("Retry or remove the file that didn't upload.");
    await act(async () => h.captured.onFailedChange?.(0));
    expect(draftButton().disabled).toBe(false);
    expect(reviewButton().disabled).toBe(false);
  });

  it('fix 15: the caption counter uses the platform limit and marks going over', async () => {
    h.platform = 'x';
    await renderSheet();
    const counter = (): HTMLElement => document.querySelector<HTMLElement>('[data-caption-count]')!;
    expect(counter().textContent).toBe('0 / 280');
    await typeCaption('Hello');
    expect(counter().textContent).toBe('5 / 280');
    expect(counter().hasAttribute('data-over')).toBe(false);
    await typeCaption('a'.repeat(281));
    expect(counter().textContent).toBe('281 / 280');
    expect(counter().hasAttribute('data-over')).toBe(true);
    // Over the limit still saves.
    expect(draftButton().disabled).toBe(false);
  });

  it('fix 16: a missing caption shows "Write a caption", focuses it, and typing clears it at once', async () => {
    expect(clearFieldError({ caption: 'Write a caption', title: 'x' }, 'caption')).toEqual({
      title: 'x',
    });
    const same = { title: 'x' };
    expect(clearFieldError(same, 'caption')).toBe(same);

    await renderSheet();
    caption().blur();
    await act(async () => draftButton().click());
    expect(text()).toContain('Write a caption');
    expect(document.activeElement).toBe(caption());
    expect(caption().getAttribute('aria-invalid')).toBe('true');
    expect(h.postCreate).not.toHaveBeenCalled();
    await typeCaption('H');
    expect(text()).not.toContain('Write a caption');
    expect(caption().hasAttribute('aria-invalid')).toBe(false);
  });

  it('fix 17: Send for review creates the post, then moves it to review', async () => {
    await renderSheet();
    expect(buttonByText('Cancel')).toBeDefined();
    expect(draftButton().textContent).toBe('Save as draft');
    expect(reviewButton().textContent).toBe('Send for review');
    await typeCaption('Launch day');
    await act(async () => reviewButton().click());
    expect(h.postCreate).toHaveBeenCalledTimes(1);
    expect(h.stage).toHaveBeenCalledTimes(1);
    expect(h.stage.mock.calls[0]![1]).toEqual({
      p_post_id: 'p1',
      p_to_stage: 'review',
      p_trace_id: 'trace-1',
    });
    expect(h.postCreate.mock.invocationCallOrder[0]!).toBeLessThan(
      h.stage.mock.invocationCallOrder[0]!,
    );
  });

  it('fix 17: Save as draft never moves the post', async () => {
    await renderSheet();
    await typeCaption('Launch day');
    await act(async () => draftButton().click());
    expect(h.postCreate).toHaveBeenCalledTimes(1);
    expect(h.stage).not.toHaveBeenCalled();
  });

  it('fix 18: the discard copy counts the files', () => {
    expect(createPostDiscard(2)).toEqual({
      title: 'Discard this post?',
      message: 'Your caption and 2 files will be removed.',
    });
    expect(createPostDiscard(1).message).toBe('Your caption and 1 file will be removed.');
  });

  it('fix 18: Cancel on a clean sheet closes without asking', async () => {
    await renderSheet();
    await act(async () => buttonByText('Cancel')!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain('Discard this post?');
  });

  it('fix 18: Cancel on a dirty sheet asks, with Keep editing and Discard', async () => {
    await renderSheet();
    await typeCaption('Draft words');
    await act(async () => h.captured.onChange?.([doc('d1'), doc('d2')]));
    await act(async () => buttonByText('Cancel')!.click());
    expect(onClose).not.toHaveBeenCalled();
    expect(text()).toContain('Discard this post?');
    expect(text()).toContain('Your caption and 2 files will be removed.');
    expect(buttonByText('Keep editing')).toBeDefined();
    await act(async () => buttonByText('Discard')!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fix 19: the pressed button says "Saving…" while the save runs', async () => {
    h.postCreate.mockImplementation(() => new Promise(() => {}));
    await renderSheet();
    await typeCaption('Launch day');
    await act(async () => draftButton().click());
    expect(draftButton().textContent).toBe('Saving…');
    expect(draftButton().disabled).toBe(true);
    expect(reviewButton().disabled).toBe(true);
  });

  it('fix 19: submitCreatePost with existingPostId skips post_create and only attaches', async () => {
    const client = {} as Client;
    const postCreate = vi.fn(async () => ({ ok: true, data: 'new' }) as Result<string>);
    const gallerySet = vi.fn(async () => ({ ok: true, data: 'g' }) as Result<string>);
    const onPostCreated = vi.fn();
    const base = {
      client,
      workspaceId: 'w1',
      payload: { title: 'T' } as Json,
      versionIds: ['v1'],
      newTrace: () => 'tr',
      postCreate,
      gallerySet,
      onPostCreated,
    };
    expect(await submitCreatePost({ ...base, existingPostId: 'kept' })).toEqual({
      ok: true,
      postId: 'kept',
    });
    expect(postCreate).not.toHaveBeenCalled();
    expect(onPostCreated).not.toHaveBeenCalled();
    expect(gallerySet).toHaveBeenCalledWith(client, {
      p_post_id: 'kept',
      p_asset_version_ids: ['v1'],
      p_trace_id: 'tr',
    });

    expect(await submitCreatePost(base)).toEqual({ ok: true, postId: 'new' });
    expect(onPostCreated).toHaveBeenCalledWith('new');
  });

  it('fix 19: a retry after a failed attach never creates a second post', async () => {
    h.gallerySet
      .mockResolvedValueOnce({ ok: false, error: { code: 'unknown', message: 'gallery blew up' } })
      .mockResolvedValue({ ok: true, data: 'g' });
    await renderSheet();
    await typeCaption('Launch day');
    await act(async () => h.captured.onChange?.([doc('d1')]));
    await act(async () => draftButton().click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't save the post. Try again.",
    );
    expect(onCreated).not.toHaveBeenCalled();
    await act(async () => draftButton().click());
    expect(h.postCreate).toHaveBeenCalledTimes(1);
    expect(h.gallerySet).toHaveBeenCalledTimes(2);
    expect(h.gallerySet.mock.calls[1]![1]).toMatchObject({
      p_post_id: 'p1',
      p_asset_version_ids: ['d1'],
    });
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated.mock.calls[0]![0]).toBe('p1');
  });

  it('fix 21: no side preview; the 340px layout; the chip slot is there from the first paint', async () => {
    // The platform has not resolved yet: the slot still holds its row.
    await renderSheet({ workspaceId: 'ws-pending' });
    const slot = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('[data-preview-chip-slot]');
    expect(slot()).not.toBeNull();
    expect(slot()!.className).toContain('min-h-[44px]');
    expect(slot()!.querySelector('button')).toBeNull();
    act(() => root?.unmount());
    root = null;

    await renderSheet();
    expect(document.querySelector('[data-composer-preview]')).toBeNull();
    expect(document.querySelector('[data-create-layout]')?.className).toContain(
      'lg:grid-cols-[340px_minmax(0,1fr)]',
    );
    expect(slot()!.querySelector('button')?.textContent).toBe('Instagram preview');
  });

  it('fix 22: the brief list is this workspace, open only, with its helper', async () => {
    await renderSheet();
    expect(h.listBriefs).toHaveBeenCalledWith(supabase, { workspaceId: 'ws-1', status: 'open' });
    await openMoreOptions();
    expect(BRIEF_HELPER).toBe('Open briefs in this workspace.');
    expect(text()).toContain(BRIEF_HELPER);
  });

  it('fix 23: opened from a brief, More options is open with that brief chosen and the sheet is clean', async () => {
    h.listBriefs.mockResolvedValue({ ok: true, data: [{ id: 'b1', title: 'Festive drop' }] });
    await renderSheet({ initialBriefId: 'b1' });
    expect(moreButton().getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('#post-title')).not.toBeNull();
    expect(document.querySelector('button[aria-label="Brief"]')?.textContent).toContain(
      'Festive drop',
    );
    // The brief it opened with is not work to lose.
    await act(async () => buttonByText('Cancel')!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fix 24: the new post link and the strip title', () => {
    expect(createdPostPath('id-1', 'KITE', 12)).toBe('/p/kite-12');
    expect(createdPostPath('id-1', null, 12)).toBe('/posts/id-1');
    expect(createdPostPath('id-1', 'KITE', null)).toBe('/posts/id-1');
    expect(createdStripTitle('draft')).toBe('Saved as draft');
    expect(createdStripTitle('review')).toBe('Sent for review');
  });

  it('fix 24: a saved draft shows the undo strip and lands on /p/key-n', async () => {
    h.workspaceKey = 'KITE';
    h.number = 12;
    await renderSheet();
    await typeCaption('Launch day');
    await act(async () => draftButton().click());
    expect(h.toastShow).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Saved as draft', kind: 'undo' }),
    );
    expect(onCreated).toHaveBeenCalledWith('p1', { stage: 'draft', path: '/p/kite-12' });
  });

  it('fix 24: sent for review without a workspace key lands on /posts/:id', async () => {
    await renderSheet();
    await typeCaption('Launch day');
    await act(async () => reviewButton().click());
    expect(h.toastShow).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Sent for review', kind: 'undo' }),
    );
    expect(onCreated).toHaveBeenCalledWith('p1', { stage: 'review', path: '/posts/p1' });
  });

  it('fix 41: a failed save reads in plain words and never shows the server text', async () => {
    expect(postCreateErrorMessage('relation "posts" does not exist', 'instagram')).toBe(
      "Couldn't save the post. Try again.",
    );
    expect(postCreateErrorMessage('invalid_format', 'instagram')).toBe(
      'That format is not available on Instagram.',
    );
    h.postCreate.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unknown', message: 'relation "posts" does not exist' },
    });
    await renderSheet();
    await typeCaption('Launch day');
    await act(async () => draftButton().click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't save the post. Try again.",
    );
    expect(text()).not.toContain('does not exist');

    h.postCreate.mockResolvedValueOnce({
      ok: false,
      error: { code: 'forbidden_role', message: 'forbidden_role' },
    });
    await act(async () => draftButton().click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't save the post. You don't have access to do this.",
    );
    expect(text()).not.toContain('forbidden_role');
  });

  it('extra: requiredFieldErrors no longer returns a format error', () => {
    expect(requiredFieldErrors({ caption: '', format: '' })).toEqual({
      caption: 'Write a caption',
    });
    expect(requiredFieldErrors({ caption: 'Hi', format: '' })).toEqual({});
  });

  it('extra: Cmd/Ctrl+Enter in the full sheet sends for review', async () => {
    await renderSheet();
    await typeCaption('Launch day');
    await act(async () => {
      caption().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
      );
    });
    expect(h.postCreate).toHaveBeenCalledTimes(1);
    expect(h.stage.mock.calls[0]![1]).toMatchObject({ p_to_stage: 'review' });
  });

  it('extra: plain Enter in the caption does not submit', async () => {
    await renderSheet();
    await typeCaption('Launch day');
    await act(async () => {
      caption().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(h.postCreate).not.toHaveBeenCalled();
  });
});
