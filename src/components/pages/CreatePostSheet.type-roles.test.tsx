// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Type roles on the New post sheet (design rules, 24 Oct 2026): the sheet
// title is lg/600, row titles base/500, meta sm fg-3 and the caption counter
// is meta. Mocks mirror CreatePostSheet.render.test.tsx.

vi.mock('@/lib/workspace-context-platform', () => ({
  useWorkspacePlatform: (id: string | null) => (id === 'ws-1' ? 'instagram' : null),
}));
vi.mock('@/lib/workspace-context', () => ({ useWorkspace: () => ({ workspaceName: 'Kite' }) }));
vi.mock('@/lib/session-context', () => ({ useSession: () => ({ session: null }) }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/buckets', () => ({ listBuckets: async () => ({ ok: true, data: [] }) }));
vi.mock('@srtdio/briefs', () => ({ listBriefs: async () => ({ ok: true, data: [] }) }));
vi.mock('@/components/pages/pcs/use-post-members', () => ({
  usePostMembers: () => ({ options: [] }),
}));
vi.mock('@/components/pages/create/AttachmentsField', () => ({
  AttachmentsField: () => <span data-attachments-stub="" />,
  isMediaItem: (item: { kind: string }) => item.kind === 'image',
  attachmentVersionIds: () => [],
}));
vi.mock('@/components/ui/DatePicker', () => ({ DatePicker: () => null }));
vi.mock('@srtdio/rpc', () => ({
  postCreate: vi.fn(),
  gallerySet: vi.fn(),
  stageTransition: vi.fn(),
}));

import {
  CreatePostSheet,
  MORE_OPTIONS_HINT,
  MORE_OPTIONS_LABEL,
} from '@/components/pages/CreatePostSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = '';
});

async function renderSheet(): Promise<void> {
  root = createRoot(host!);
  await act(async () => {
    root!.render(
      <CreatePostSheet open workspaceId="ws-1" onClose={() => {}} onCreated={() => {}} />,
    );
  });
}

/** The deepest element whose trimmed text is exactly `text`. */
function byText(text: string): HTMLElement {
  const matches = [...document.body.querySelectorAll<HTMLElement>('*')].filter(
    (el) => el.textContent?.trim() === text,
  );
  const el = matches[matches.length - 1];
  if (el === undefined) throw new Error(`no element with text "${text}"`);
  return el;
}

function classes(el: Element | null): string[] {
  return (el?.getAttribute('class') ?? '').split(/\s+/);
}

describe('CreatePostSheet type roles', () => {
  it('sheet title: text-lg font-semibold', async () => {
    await renderSheet();
    expect(classes(byText('New post'))).toEqual(
      expect.arrayContaining(['text-lg', 'font-semibold']),
    );
  });

  it('row titles: text-base font-medium (Format, More options)', async () => {
    await renderSheet();
    for (const label of ['Format', MORE_OPTIONS_LABEL]) {
      const cls = classes(byText(label));
      expect(cls).toEqual(expect.arrayContaining(['text-base', 'font-medium']));
      expect(cls).not.toContain('font-semibold');
    }
  });

  it('meta: the More options hint and the format pill sit at text-sm', async () => {
    await renderSheet();
    expect(classes(byText(MORE_OPTIONS_HINT))).toEqual(
      expect.arrayContaining(['text-sm', 'text-fg-3']),
    );
    expect(classes(document.querySelector('[data-format-pill]'))).toContain('text-sm');
    expect(classes(document.querySelector('[data-format-source]'))).toEqual(
      expect.arrayContaining(['text-sm', 'text-fg-3']),
    );
  });

  it('the caption counter is meta: text-sm text-fg-3', async () => {
    await renderSheet();
    expect(classes(document.querySelector('[data-caption-count]'))).toEqual(
      expect.arrayContaining(['text-sm', 'text-fg-3']),
    );
  });

  it('renders no off-scale type classes', async () => {
    await renderSheet();
    expect(document.body.innerHTML).not.toMatch(
      /text-legacy-|text-\[\d|leading-\[\d|font-bold|font-\[/,
    );
  });
});
