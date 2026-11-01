// @vitest-environment jsdom
// The Plan item screen (U1, U2, U3, U4, U5, U9, U10): a concept lists Files
// first (tiles are buttons named "Open {name}", the name under each; an image
// opens the gallery of every image at it, a PDF the file viewer), then the
// description card (links as in chat), then Date/Approvers, then Comments; a
// failed read shows the files copy with Retry; a post item lists its plan
// notes under the post (nothing when there are none); the comment box is the
// shared Textarea with chat's send rule. Reads, writes and viewers are stubbed.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { ItemScreenData, PlanBundle, PlanItemRow } from '@/lib/chat/plans';
import type { Result } from '@srtdio/rpc';

const env = vi.hoisted(() => ({
  laptop: true,
  coarse: false,
  reads: 0,
  result: null as unknown,
  comment: vi.fn(async () => ({ ok: true, data: 'cm-new' })),
}));

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
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
  useIsLaptop: () => env.laptop,
  useCoarsePointer: () => env.coarse,
}));
vi.mock('@/components/chat/PostPicker', () => ({ PostPicker: () => null }));
vi.mock('@/components/chat/AssetPicker', () => ({ AssetPicker: () => null }));
vi.mock('@/components/chat/PlanCardsProvider', () => ({ usePlanCards: () => null }));
vi.mock('@/components/media/Thumbnail', () => ({ Thumbnail: () => null }));
vi.mock('@/components/ui/LinkPreviewCard', () => ({
  LinkPreviewCard: (p: { url: string }) => <div data-test-link-card={p.url} />,
}));
vi.mock('@/lib/chat/use-chat-attachments', () => ({
  useCommentAttachments: () => ({ canAttach: false, uploadFile: undefined }),
}));
vi.mock('@/components/pages/PostDetailPage', () => ({
  PostDetailPage: () => <div data-test-post-detail="" />,
}));
vi.mock('@/components/ui/ImageLightbox', () => ({
  ImageLightbox: (p: { images: Array<{ assetId: string }>; index: number }) => (
    <div data-test-lightbox={p.images.map((i) => i.assetId).join(',')} data-test-index={p.index} />
  ),
}));
vi.mock('@/components/ui/FileViewer', () => ({
  remoteFileSource: (_cache: unknown, versionId: string) => ({ versionId }),
  FileViewer: (p: { name: string; kind: string; source: { versionId: string } }) => (
    <div data-test-file-viewer={p.source.versionId} data-test-kind={p.kind}>
      {p.name}
    </div>
  ),
}));
vi.mock('@srtdio/rpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@srtdio/rpc')>()),
  planItemCommentCreate: env.comment,
}));
vi.mock('@/lib/chat/plans', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/plans')>()),
  readItemScreen: async () => {
    env.reads += 1;
    return env.result;
  },
}));

import { PlanItemScreen } from '@/components/chat/PlanItemScreen';
import { CONCEPT_FILES_READ_FAILED } from '@/components/chat/ConceptSheet';
import { ToastProvider } from '@/components/ui/toast';
import { resetHistorySteps } from '@/lib/chat/use-history-step';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONCEPT: PlanItemRow = {
  id: 'c1',
  plan_id: 'plan',
  kind: 'concept',
  position: 0,
  title: 'Plant tour reel',
  description: 'Reference: https://example.com/ref',
  post_id: null,
  created_at: '2026-10-09T10:00:00Z',
  target_date: '2026-10-13',
};
const POST: PlanItemRow = { ...CONCEPT, id: 'p1', kind: 'post', post_id: 'post-1', title: null };

const BUNDLE: PlanBundle = {
  plan: {
    id: 'plan',
    workspace_id: 'ws',
    title: 'Week of 12 Oct',
    starts_on: '2026-10-12',
    ends_on: '2026-10-18',
    audience: 'client',
    created_by: 'u2',
  },
  items: [CONCEPT, POST],
  reviews: [],
  postStages: { 'post-1': 'review' },
  postInfo: { 'post-1': { title: 'Launch post' } },
};

const FILES: ItemScreenData['files'] = [
  { versionId: 'img1', name: 'Hero shot', mimeType: 'image/jpeg', kind: 'image' },
  { versionId: 'pdf1', name: 'Brief.pdf', mimeType: 'application/pdf', kind: 'document' },
  { versionId: 'img2', name: 'Detail', mimeType: 'image/png', kind: 'image' },
];

const NOTE = {
  id: 'cm1',
  item_id: 'p1',
  author_user_id: 'u2',
  body: 'Not OK: swap the cover',
  visibility: 'everyone' as const,
  created_at: '2026-10-10T09:30:00Z',
};

function ready(data: Partial<ItemScreenData>): Result<ItemScreenData> {
  return { ok: true, data: { comments: [], files: [], names: {}, ...data } };
}

let root: Root | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => act(async () => wait(60));

async function mount(item: PlanItemRow, side: 'agency' | 'client' = 'client'): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <ToastProvider>
          <PlanItemScreen open bundle={BUNDLE} item={item} side={side} onClose={() => {}} />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
  await settle();
  await settle();
}

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  document.querySelector<T>(sel);

/** Type into a React-controlled field. */
function type(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function key(el: HTMLElement, init: KeyboardEventInit): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

beforeEach(() => {
  resetHistorySteps();
  env.laptop = true;
  env.coarse = false;
  env.reads = 0;
  env.result = ready({ files: FILES });
  env.comment.mockClear();
});

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  await settle();
  resetHistorySteps();
});

describe('concept: files, order, links (U1, U2, U3, U9)', () => {
  it('Files first under its label, then the description card with the link card, then Date/Approvers, then Comments', async () => {
    await mount(CONCEPT);
    const files = $('[data-plan-files]');
    const card = $('[data-plan-description-card]');
    const status = $('[data-plan-status]');
    const comments = $('section[aria-label="Comments"]');
    expect(files?.querySelector('h4')?.textContent).toBe('Files');
    expect(files?.querySelector('h4')?.className).toContain('uppercase');
    const order = [files, card, status, comments].map((el) => {
      expect(el).not.toBeNull();
      return el as Element;
    });
    for (let i = 1; i < order.length; i += 1) {
      const prev = order[i - 1] as Element;
      expect(
        prev.compareDocumentPosition(order[i] as Element) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    // The link preview sits inside the description card, below the text.
    expect(card?.querySelector('[data-test-link-card]')).not.toBeNull();
  });

  it('each file tile is a button named "Open {name}" with its name under it (title for hover)', async () => {
    await mount(CONCEPT);
    const tiles = [...document.querySelectorAll<HTMLButtonElement>('[data-plan-file]')];
    expect(tiles.map((t) => t.getAttribute('aria-label'))).toEqual([
      'Open Hero shot',
      'Open Brief.pdf',
      'Open Detail',
    ]);
    expect(tiles.every((t) => t.tagName === 'BUTTON')).toBe(true);
    expect(tiles.every((t) => t.className.includes('min-h-[44px]'))).toBe(true);
    expect(tiles.map((t) => t.querySelector('[data-plan-file-name]')?.textContent)).toEqual([
      'Hero shot',
      'Brief.pdf',
      'Detail',
    ]);
    expect(tiles[1]?.getAttribute('title')).toBe('Brief.pdf');
  });

  it('an image opens the gallery of every image at the tapped one; a PDF opens the file viewer', async () => {
    await mount(CONCEPT);
    expect($('[data-test-lightbox]')).toBeNull();
    await act(async () => $<HTMLButtonElement>('[data-plan-file="img2"]')?.click());
    await settle();
    const box = $('[data-test-lightbox]');
    expect(box?.getAttribute('data-test-lightbox')).toBe('img1,img2');
    expect(box?.getAttribute('data-test-index')).toBe('1');
    await act(async () => $<HTMLButtonElement>('[data-plan-file="pdf1"]')?.click());
    await settle();
    const viewer = $('[data-test-file-viewer]');
    expect(viewer?.getAttribute('data-test-file-viewer')).toBe('pdf1');
    expect(viewer?.getAttribute('data-test-kind')).toBe('pdf');
  });

  it('the description renders its links like chat (tappable, new tab, no scheme)', async () => {
    await mount(CONCEPT);
    const link = $<HTMLAnchorElement>('[data-plan-description] a[data-msg-link]');
    expect(link?.getAttribute('href')).toBe('https://example.com/ref');
    expect(link?.textContent).toBe('example.com/ref');
    expect($('[data-plan-description]')?.className).toContain('whitespace-pre-wrap');
  });
});

describe('a failed read (U4)', () => {
  it('shows the files copy with Retry (never an endless shimmer); Retry reads again', async () => {
    env.result = { ok: false, error: { code: 'unknown', message: 'boom' } };
    await mount(CONCEPT);
    const failed = $('[data-plan-media="failed"]');
    expect(failed?.textContent).toContain(CONCEPT_FILES_READ_FAILED);
    const before = env.reads;
    env.result = ready({ files: FILES });
    await act(async () => $<HTMLButtonElement>('[data-plan-media-retry]')?.click());
    await settle();
    expect(env.reads).toBe(before + 1);
    expect($('[data-plan-media="files"]')).not.toBeNull();
  });
});

describe('post items: Plan notes (U5)', () => {
  it('the post paints, and its notes list below it under "Plan notes"', async () => {
    env.result = ready({ comments: [NOTE], names: { u2: 'Asha' } });
    await mount(POST);
    const post = $('[data-test-post-detail]');
    const notes = $('[data-plan-notes]');
    expect(post).not.toBeNull();
    expect(notes?.querySelector('h4')?.textContent).toBe('Plan notes');
    expect(notes?.textContent).toContain('Not OK: swap the cover');
    expect(
      (post as Element).compareDocumentPosition(notes as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('no notes: no label, nothing', async () => {
    env.result = ready({ comments: [] });
    await mount(POST);
    expect($('[data-test-post-detail]')).not.toBeNull();
    expect($('[data-plan-notes]')).toBeNull();
    expect(document.body.textContent).not.toContain('Plan notes');
  });
});

describe('the comment box (U10)', () => {
  it('is the shared Textarea; Enter sends on a fine pointer, Shift+Enter does not; it keeps focus', async () => {
    await mount(CONCEPT);
    const box = $<HTMLTextAreaElement>('[data-plan-comment-input]') as HTMLTextAreaElement;
    expect(box.tagName).toBe('TEXTAREA');
    expect($('[data-plan-comment-hint]')?.textContent).toBe(
      'Enter to send · Shift+Enter for a new line',
    );
    box.focus();
    await act(async () => type(box, 'Line one'));
    await act(async () => key(box, { key: 'Enter', shiftKey: true }));
    expect(env.comment).not.toHaveBeenCalled();
    await act(async () => key(box, { key: 'Enter' }));
    await settle();
    expect(env.comment).toHaveBeenCalledTimes(1);
    expect(box.value).toBe('');
    expect(document.activeElement).toBe(box);
  });

  it('on a coarse pointer Return never sends and the hint is hidden', async () => {
    env.coarse = true;
    await mount(CONCEPT);
    const box = $<HTMLTextAreaElement>('[data-plan-comment-input]') as HTMLTextAreaElement;
    await act(async () => type(box, 'Note'));
    await act(async () => key(box, { key: 'Enter' }));
    await settle();
    expect(env.comment).not.toHaveBeenCalled();
    expect($('[data-plan-comment-hint]')).toBeNull();
  });

  it('phone: no hint', async () => {
    env.laptop = false;
    await mount(CONCEPT);
    expect($('[data-plan-comment-hint]')).toBeNull();
  });
});
