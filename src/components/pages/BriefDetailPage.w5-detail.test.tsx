// @vitest-environment jsdom
// W5 Brief detail: a load failure shows LoadError ("Couldn't load this brief.")
// with Retry and never the server's text, and Retry re-reads; not-found is its
// own state; Close lives only in the header ⋯ menu, gated on brief.close or
// brief.close_own for the creator, confirms, and commits brief_close only after
// the Undo window; copy buttons; Created by skeleton; the approver hint rule;
// Back pops in-app history or goes to /briefs.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, ToastViewport } from '@/components/ui/toast';
import {
  BriefDetailPage,
  briefBackTarget,
  canCloseBrief,
} from '@/components/pages/BriefDetailPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  getBrief: vi.fn(),
  getBriefGallery: vi.fn(),
  briefClose: vi.fn(),
  caps: {} as Record<string, boolean>,
  members: { loading: false },
  viewer: 'u1',
}));

vi.mock('@srtdio/briefs', () => ({
  getBrief: (...args: unknown[]) => h.getBrief(...args),
  getBriefGallery: (...args: unknown[]) => h.getBriefGallery(...args),
}));
vi.mock('@srtdio/rpc', () => ({ briefClose: (...args: unknown[]) => h.briefClose(...args) }));
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: h.viewer } } }),
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({
    workspaceId: 'w1',
    workspaceKey: 'ACME',
    workspaces: [{ id: 'w1', timezone: 'UTC', week_start_day: 1 }],
  }),
}));
vi.mock('@/lib/workspace-context-capability', () => ({
  useWorkspaceCapability: (key: string) => h.caps[key] ?? false,
}));
vi.mock('@/components/pages/pcs/use-post-members', () => ({
  usePostMembers: () => ({
    options: h.members.loading ? [] : [{ userId: 'u1', displayName: 'Asha Rao' }],
    loading: h.members.loading,
    error: null,
  }),
}));
vi.mock('@/components/comments/Comments', () => ({ Comments: () => <div>comments</div> }));
vi.mock('@/components/pages/pcs/PostGallery', () => ({ PostGallery: () => <div>gallery</div> }));
vi.mock('@/components/refs/EntityRefChip', () => ({ EntityRefChip: () => null }));

function detail(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      linked_posts_count: 2,
      brief: {
        id: 'b1',
        workspace_id: 'w1',
        number: 3,
        title: 'Festive drop',
        objective: 'Build hype for the drop',
        brand_requirements: 'Gold logo only',
        legacy_author_name: null,
        status: 'open',
        target_date: '2026-10-08',
        reference_links: null,
        mentions: null,
        format_requested: 'carousel',
        closed_at: null,
        closed_by: null,
        created_by: 'u1',
        created_via: 'manual',
        created_at: '2026-10-01T10:00:00Z',
        updated_at: '2026-10-01T10:00:00Z',
        deleted_at: null,
        row_version: 1,
        ...over,
      },
    },
  };
}

let root: Root | null = null;
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/briefs/b1']}>
          <Routes>
            <Route path="/briefs/:briefId" element={<BriefDetailPage />} />
          </Routes>
        </MemoryRouter>
        <ToastViewport />
      </ToastProvider>,
    );
  });
  await flush();
}

const text = () => document.body.textContent ?? '';
const byLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );

beforeEach(() => {
  h.getBrief.mockReset();
  h.getBriefGallery.mockReset().mockResolvedValue({ ok: true, data: [] });
  h.briefClose.mockReset().mockResolvedValue({ ok: true, data: null });
  h.caps = {};
  h.members.loading = false;
  h.viewer = 'u1';
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Brief detail load failure', () => {
  it('shows "Couldn\'t load this brief." with Retry, no raw text; Retry re-reads', async () => {
    h.getBrief
      .mockResolvedValueOnce({ ok: false, error: { code: 'unknown', message: 'JWT expired' } })
      .mockResolvedValue(detail());
    await mount();
    expect(text()).toContain("Couldn't load this brief.");
    expect(text()).not.toContain('JWT expired');
    expect(text()).not.toContain('Brief not found');
    await act(async () => button('Retry')?.click());
    await flush();
    expect(h.getBrief).toHaveBeenCalledTimes(2);
    expect(h.getBrief.mock.calls[1]?.[1]).toBe('b1');
    expect(text()).toContain('Festive drop');
  });

  it('a missing brief is its own not-found state, never a load error', async () => {
    h.getBrief.mockResolvedValue({ ok: true, data: null });
    await mount();
    expect(text()).toContain('Brief not found');
    expect(text()).not.toContain("Couldn't load");
    expect(button('Retry')).toBeUndefined();
  });
});

describe('Brief detail close', () => {
  it('no ⋯ menu and no Close anywhere without a close capability', async () => {
    h.getBrief.mockResolvedValue(detail());
    await mount();
    expect(byLabel('Brief actions')).toBeNull();
    expect(button('Close brief')).toBeUndefined();
  });

  it('brief.close: Close is in the ⋯ menu, confirms, then closes behind Undo', async () => {
    h.caps = { 'brief.close': true };
    h.getBrief.mockResolvedValue(detail());
    await mount();
    expect(button('Close brief')).toBeUndefined();
    await act(async () => byLabel('Brief actions')?.click());
    await act(async () => button('Close brief')?.click());
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('Close this brief?');
    expect(dialog?.textContent).toContain('It leaves Open but stays readable and commentable.');
    await act(async () =>
      [...(dialog?.querySelectorAll('button') ?? [])]
        .find((b) => b.textContent?.trim() === 'Close brief')
        ?.click(),
    );
    expect(text()).toContain('Brief closed');
    expect(text()).toContain('Closed');
    // The write waits for the Undo window.
    expect(h.briefClose).not.toHaveBeenCalled();
    await act(async () => button('Undo')?.click());
    expect(h.briefClose).not.toHaveBeenCalled();
    expect(byLabel('Brief actions')).not.toBeNull();
  });

  it('commits brief_close once the window is cut short (leaving the page)', async () => {
    h.caps = { 'brief.close': true };
    h.getBrief.mockResolvedValue(detail());
    await mount();
    await act(async () => byLabel('Brief actions')?.click());
    await act(async () => button('Close brief')?.click());
    const dialog = document.querySelector('[role="alertdialog"]');
    await act(async () =>
      [...(dialog?.querySelectorAll('button') ?? [])]
        .find((b) => b.textContent?.trim() === 'Close brief')
        ?.click(),
    );
    act(() => root?.unmount());
    root = null;
    expect(h.briefClose).toHaveBeenCalledTimes(1);
    expect(h.briefClose.mock.calls[0]?.[1]).toEqual({ p_brief_id: 'b1', p_trace_id: 'trace-1' });
  });

  it('brief.close_own shows the menu only to the creator', async () => {
    h.caps = { 'brief.close_own': true };
    h.getBrief.mockResolvedValue(detail({ created_by: 'u1' }));
    await mount();
    expect(byLabel('Brief actions')).not.toBeNull();
    act(() => root?.unmount());
    document.body.innerHTML = '';
    h.viewer = 'u2';
    await mount();
    expect(byLabel('Brief actions')).toBeNull();
  });

  it('canCloseBrief: close, or close_own for the creator only', () => {
    expect(canCloseBrief(true, false, 'u9', 'u1')).toBe(true);
    expect(canCloseBrief(false, true, 'u1', 'u1')).toBe(true);
    expect(canCloseBrief(false, true, 'u9', 'u1')).toBe(false);
    expect(canCloseBrief(null, null, 'u1', 'u1')).toBe(false);
    expect(canCloseBrief(false, true, 'u1', null)).toBe(false);
  });
});

describe('Brief detail content', () => {
  it('copies the objective and brand requirements with 44px buttons', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    h.getBrief.mockResolvedValue(detail());
    await mount();
    const copyObjective = byLabel('Copy objective');
    expect(copyObjective?.className).toContain('h-11 w-11');
    await act(async () => copyObjective?.click());
    await flush();
    expect(writeText).toHaveBeenCalledWith('Build hype for the drop');
    expect(text()).toContain('Copied');
    await act(async () => byLabel('Copy brand requirements')?.click());
    expect(writeText).toHaveBeenCalledWith('Gold logo only');
  });

  it('says "Couldn\'t copy" when the clipboard refuses', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
      configurable: true,
    });
    h.getBrief.mockResolvedValue(detail());
    await mount();
    await act(async () => byLabel('Copy objective')?.click());
    await flush();
    expect(text()).toContain("Couldn't copy");
  });

  it('Created by shows a skeleton until members load, never "Former member" early', async () => {
    h.members.loading = true;
    h.getBrief.mockResolvedValue(detail({ created_by: 'u404' }));
    await mount();
    expect(document.querySelector('[data-testid="created-by-skeleton"]')).not.toBeNull();
    expect(text()).not.toContain('Former member');
  });

  it('hides the "Reference images from the approvers" hint for approvers', async () => {
    const image = {
      assetAttachmentId: 'a1',
      assetVersionId: 'v1',
      assetId: 'as1',
      position: 0,
      filename: 'ref.png',
      mimeType: 'image/png',
      kind: 'image',
      width: 10,
      height: 10,
      durationMs: null,
      externalUrl: null,
    };
    h.getBriefGallery.mockResolvedValue({ ok: true, data: [image] });
    h.getBrief.mockResolvedValue(detail());
    h.caps = { 'brief.create': true };
    await mount();
    expect(text()).toContain('gallery');
    expect(text()).not.toContain('Reference images from the approvers');
    act(() => root?.unmount());
    document.body.innerHTML = '';
    h.caps = {};
    await mount();
    expect(text()).toContain('Reference images from the approvers');
  });

  it('the due date reads the picked day', async () => {
    h.getBrief.mockResolvedValue(detail({ target_date: '2026-10-08' }));
    await mount();
    expect(text()).toContain('Oct 8, 2026');
  });
});

describe('Brief detail Back', () => {
  it('pops in-app history when there is an entry below, else goes to /briefs', () => {
    expect(briefBackTarget({ idx: 2 })).toBe('pop');
    expect(briefBackTarget({ idx: 0 })).toBe('/briefs');
    expect(briefBackTarget(null)).toBe('/briefs');
  });

  it('uses the same chevron Back button as Post detail', async () => {
    h.getBrief.mockResolvedValue(detail());
    await mount();
    expect(byLabel('Back')?.querySelector('svg')).not.toBeNull();
  });
});
