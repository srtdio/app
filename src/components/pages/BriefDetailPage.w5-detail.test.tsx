// @vitest-environment jsdom
// W5 Brief detail: a load failure shows LoadError ("Couldn't load this brief.")
// with Retry and never the server's text, and Retry re-reads; not-found is its
// own state; the header ⋯ menu is on every brief: Copy link always, Close
// brief (open, gated on brief.close or brief.close_own for the creator; it
// confirms and commits brief_close only after the Undo window) or Reopen brief
// (closed, any member; optimistic, commits brief_reopen after the Undo window);
// no KEY-N code anywhere; copy buttons; Created by skeleton; no helper text;
// Back pops in-app history or goes to /briefs.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, ToastViewport } from '@/components/ui/toast';
import {
  BriefDetailPage,
  briefBackTarget,
  briefCopyLink,
  canCloseBrief,
  reopenErrorCopy,
} from '@/components/pages/BriefDetailPage';
import { WORKSPACE_DATA_CHANGED_EVENT } from '@/lib/events';
import { UNDO_WINDOW_MS } from '@/lib/use-undoable-action';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  getBrief: vi.fn(),
  getBriefGallery: vi.fn(),
  briefClose: vi.fn(),
  reopenBrief: vi.fn(),
  caps: {} as Record<string, boolean>,
  members: { loading: false },
  viewer: 'u1',
}));

vi.mock('@srtdio/briefs', () => ({
  getBrief: (...args: unknown[]) => h.getBrief(...args),
  getBriefGallery: (...args: unknown[]) => h.getBriefGallery(...args),
  reopenBrief: (...args: unknown[]) => h.reopenBrief(...args),
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

/** Open the header ⋯ menu. */
async function openMenu(): Promise<void> {
  await act(async () => byLabel('Brief actions')?.click());
}
/** The open menu's rows as [data-testid, label], in order. */
const menuRows = (): [string, string][] =>
  [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].map(
    (el): [string, string] => [el.dataset.testid ?? '', el.textContent?.trim() ?? ''],
  );
const menuRow = (testId: string) =>
  document.querySelector<HTMLButtonElement>(`[role="menuitem"][data-testid="${testId}"]`);
/** The status pill labels on the page (phone and desktop Details), deduplicated. */
const statusLabels = (): string[] => [
  ...new Set(
    [...document.querySelectorAll<HTMLElement>('[data-brief-status]')].map(
      (el) => el.textContent?.trim() ?? '',
    ),
  ),
];
/** Let a commit's promise chain run (works under fake timers: microtasks only). */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
/** A KEY-N code such as "ACME-3". */
const CODE = /\b[A-Z]{2,}-\d+\b/;

beforeEach(() => {
  h.getBrief.mockReset();
  h.getBriefGallery.mockReset().mockResolvedValue({ ok: true, data: [] });
  h.briefClose.mockReset().mockResolvedValue({ ok: true, data: null });
  h.reopenBrief.mockReset().mockResolvedValue({ ok: true, data: undefined });
  h.caps = {};
  h.members.loading = false;
  h.viewer = 'u1';
});

afterEach(() => {
  vi.useRealTimers();
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
  it('without a close capability the ⋯ menu offers Copy link only, no Close anywhere', async () => {
    h.getBrief.mockResolvedValue(detail());
    await mount();
    expect(byLabel('Brief actions')).not.toBeNull();
    expect(button('Close brief')).toBeUndefined();
    await openMenu();
    expect(menuRows()).toEqual([['brief-menu-copy-link', 'Copy link']]);
    expect(button('Close brief')).toBeUndefined();
    expect(button('Reopen brief')).toBeUndefined();
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
    expect(dialog?.textContent).toContain('Closed briefs stay readable and open to comments.');
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

  it('brief.close_own offers Close brief only to the creator', async () => {
    h.caps = { 'brief.close_own': true };
    h.getBrief.mockResolvedValue(detail({ created_by: 'u1' }));
    await mount();
    await openMenu();
    expect(menuRows().map(([id]) => id)).toEqual(['brief-menu-copy-link', 'brief-menu-close']);
    act(() => root?.unmount());
    document.body.innerHTML = '';
    h.viewer = 'u2';
    await mount();
    expect(byLabel('Brief actions')).not.toBeNull();
    await openMenu();
    expect(menuRows().map(([id]) => id)).toEqual(['brief-menu-copy-link']);
  });

  it('canCloseBrief: close, or close_own for the creator only', () => {
    expect(canCloseBrief(true, false, 'u9', 'u1')).toBe(true);
    expect(canCloseBrief(false, true, 'u1', 'u1')).toBe(true);
    expect(canCloseBrief(false, true, 'u9', 'u1')).toBe(false);
    expect(canCloseBrief(null, null, 'u1', 'u1')).toBe(false);
    expect(canCloseBrief(false, true, 'u1', null)).toBe(false);
  });
});

describe('Brief detail ⋯ menu rows', () => {
  it('an open brief with close rights: Copy link, then Close brief', async () => {
    h.caps = { 'brief.close': true };
    h.getBrief.mockResolvedValue(detail());
    await mount();
    await openMenu();
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe(
      'Brief actions',
    );
    expect(menuRows()).toEqual([
      ['brief-menu-copy-link', 'Copy link'],
      ['brief-menu-close', 'Close brief'],
    ]);
    expect(menuRow('brief-menu-reopen')).toBeNull();
  });

  it('an open brief without close rights: Copy link only', async () => {
    h.getBrief.mockResolvedValue(detail({ created_by: 'u9' }));
    await mount();
    await openMenu();
    expect(menuRows()).toEqual([['brief-menu-copy-link', 'Copy link']]);
  });

  it('a closed brief, member without close rights: Copy link, then Reopen brief', async () => {
    h.getBrief.mockResolvedValue(detail({ status: 'closed', created_by: 'u9' }));
    await mount();
    await openMenu();
    expect(menuRows()).toEqual([
      ['brief-menu-copy-link', 'Copy link'],
      ['brief-menu-reopen', 'Reopen brief'],
    ]);
    expect(menuRow('brief-menu-close')).toBeNull();
  });

  it('a closed brief never offers Close brief, even with close rights', async () => {
    h.caps = { 'brief.close': true, 'brief.close_own': true };
    h.getBrief.mockResolvedValue(detail({ status: 'closed' }));
    await mount();
    await openMenu();
    expect(menuRows().map(([id]) => id)).toEqual(['brief-menu-copy-link', 'brief-menu-reopen']);
  });

  it('every row is a 44px menu item and picking one closes the menu', async () => {
    h.getBrief.mockResolvedValue(detail({ status: 'closed' }));
    await mount();
    await openMenu();
    for (const el of document.querySelectorAll<HTMLElement>('[role="menuitem"]')) {
      expect(el.className).toContain('min-h-[44px]');
    }
    await act(async () => menuRow('brief-menu-copy-link')?.click());
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

describe('Brief detail Copy link', () => {
  it('copies the briefCopyLink output and says "Link copied"', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    h.getBrief.mockResolvedValue(detail());
    await mount();
    await openMenu();
    await act(async () => menuRow('brief-menu-copy-link')?.click());
    await flush();
    const expected = briefCopyLink(window.location.origin, 'ACME', 3, 'b1');
    expect(expected).toBe(`${window.location.origin}/b/acme-3`);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(expected);
    expect(text()).toContain('Link copied');
    expect(text()).not.toContain('Link copied.');
  });

  it('says "Couldn\'t copy" when the clipboard refuses', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
      configurable: true,
    });
    h.getBrief.mockResolvedValue(detail());
    await mount();
    await openMenu();
    await act(async () => menuRow('brief-menu-copy-link')?.click());
    await flush();
    expect(text()).toContain("Couldn't copy");
    expect(text()).not.toContain('Link copied');
  });

  it('briefCopyLink: the /b/key-n link, or /briefs/:id without a workspace key', () => {
    expect(briefCopyLink('https://app.example', 'ACME', 3, 'b1')).toBe(
      'https://app.example/b/acme-3',
    );
    expect(briefCopyLink('https://app.example', null, 3, 'b1')).toBe(
      'https://app.example/briefs/b1',
    );
  });
});

describe('Brief detail reopen', () => {
  async function reopen(): Promise<void> {
    await openMenu();
    await act(async () => menuRow('brief-menu-reopen')?.click());
  }

  it('flips to Open at once with a "Brief reopened" Undo, before any write', async () => {
    h.getBrief.mockResolvedValue(detail({ status: 'closed', created_by: 'u9' }));
    await mount();
    expect(statusLabels()).toEqual(['Closed']);
    await reopen();
    expect(statusLabels()).toEqual(['Open']);
    expect(text()).toContain('Brief reopened');
    expect(button('Undo')).toBeDefined();
    expect(h.reopenBrief).not.toHaveBeenCalled();
    // Now open: the menu offers no Reopen (and no Close without rights).
    await openMenu();
    expect(menuRows().map(([id]) => id)).toEqual(['brief-menu-copy-link']);
  });

  it('Undo puts Closed back and reopenBrief is never called', async () => {
    h.getBrief.mockResolvedValue(detail({ status: 'closed', created_by: 'u9' }));
    await mount();
    vi.useFakeTimers();
    await reopen();
    expect(statusLabels()).toEqual(['Open']);
    await act(async () => button('Undo')?.click());
    expect(statusLabels()).toEqual(['Closed']);
    act(() => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS * 2);
    });
    expect(h.reopenBrief).not.toHaveBeenCalled();
    // Leaving the page flushes nothing: the undone reopen is settled.
    act(() => root?.unmount());
    root = null;
    expect(h.reopenBrief).not.toHaveBeenCalled();
  });

  it('commits reopenBrief once the 4000 ms window passes, not at 3999 ms', async () => {
    h.getBrief
      .mockResolvedValueOnce(detail({ status: 'closed', created_by: 'u9' }))
      .mockResolvedValue(detail({ status: 'open', created_by: 'u9' }));
    await mount();
    expect(UNDO_WINDOW_MS).toBe(4000);
    const changed = vi.fn();
    window.addEventListener(WORKSPACE_DATA_CHANGED_EVENT, changed);
    try {
      vi.useFakeTimers();
      await reopen();
      act(() => {
        vi.advanceTimersByTime(3999);
      });
      expect(h.reopenBrief).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(h.reopenBrief).toHaveBeenCalledTimes(1);
      expect(h.reopenBrief.mock.calls[0]?.[1]).toEqual({ briefId: 'b1' });
      expect(h.reopenBrief.mock.calls[0]?.[2]).toBe('trace-1');
      await settle();
      expect(changed).toHaveBeenCalledTimes(1);
      // The page re-reads the brief after the commit.
      expect(h.getBrief).toHaveBeenCalledTimes(2);
      expect(statusLabels()).toEqual(['Open']);
    } finally {
      window.removeEventListener(WORKSPACE_DATA_CHANGED_EVENT, changed);
    }
  });

  it('a refused reopen puts Closed back and says so in plain words', async () => {
    h.reopenBrief.mockResolvedValue({
      ok: false,
      error: { code: 'invalid_payload', message: 'invalid_payload' },
    });
    h.getBrief.mockResolvedValue(detail({ status: 'closed', created_by: 'u9' }));
    await mount();
    vi.useFakeTimers();
    await reopen();
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    await settle();
    expect(h.reopenBrief).toHaveBeenCalledTimes(1);
    expect(statusLabels()).toEqual(['Closed']);
    expect(text()).toContain('This brief is already open.');
  });

  it('reopenErrorCopy: invalid_payload reads as already open, the rest via errorText', () => {
    expect(reopenErrorCopy({ code: 'invalid_payload', message: 'x' })).toBe(
      'This brief is already open.',
    );
    const member = { code: 'workspace_member_only', message: 'workspace_member_only' } as const;
    expect(reopenErrorCopy(member)).toBe(
      "Couldn't reopen the brief. You don't have access to do this.",
    );
    expect(reopenErrorCopy(member)).not.toBe('This brief is already open.');
  });
});

describe('Brief detail shows no KEY-N code', () => {
  it('an open brief: no code in the page text or the menu', async () => {
    h.caps = { 'brief.close': true };
    h.getBrief.mockResolvedValue(detail({ number: 3 }));
    await mount();
    expect(text()).toContain('Festive drop');
    expect(text()).not.toContain('ACME-3');
    expect(text()).not.toMatch(CODE);
    await openMenu();
    expect(text()).not.toMatch(CODE);
  });

  it('a closed brief: no code either', async () => {
    h.getBrief.mockResolvedValue(detail({ status: 'closed', number: 42 }));
    await mount();
    expect(text()).not.toMatch(CODE);
    const labels = [...document.querySelectorAll('[aria-label]')].map(
      (el) => el.getAttribute('aria-label') ?? '',
    );
    for (const label of labels) expect(label).not.toMatch(CODE);
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

  it('shows no "Reference images" helper text for anyone', async () => {
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
    for (const caps of [{ 'brief.create': true }, {}]) {
      h.caps = caps;
      await mount();
      expect(text()).toContain('gallery');
      expect(text()).not.toContain('Reference images from the approvers');
      expect(text()).not.toContain('read-only after creation');
      act(() => root?.unmount());
      root = null;
      document.body.innerHTML = '';
    }
  });

  it('the due date reads the picked day', async () => {
    h.getBrief.mockResolvedValue(detail({ target_date: '2026-10-08' }));
    await mount();
    // "8 Oct" in 2026, "8 Oct 2026" from a later year: both contain the day.
    expect(text()).toContain('8 Oct');
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

// Post flow A fix 23: a creator starts a post from an open brief.
function PipelineSpy() {
  const location = useLocation();
  return <div data-pipeline-at={`${location.pathname}${location.search}`} />;
}

async function mountWithPipeline() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/briefs/b1']}>
          <Routes>
            <Route path="/briefs/:briefId" element={<BriefDetailPage />} />
            <Route path="/pipeline" element={<PipelineSpy />} />
          </Routes>
        </MemoryRouter>
        <ToastViewport />
      </ToastProvider>,
    );
  });
  await flush();
}

describe('Brief detail New post from this brief', () => {
  it('fix 23: a creator on an open brief sees it, and it opens the sheet on this brief', async () => {
    h.caps = { 'post.create': true, 'brief.create': false };
    h.getBrief.mockResolvedValue(detail());
    await mountWithPipeline();
    const start = button('New post from this brief');
    expect(start).toBeDefined();
    await act(async () => start!.click());
    expect(document.querySelector('[data-pipeline-at]')?.getAttribute('data-pipeline-at')).toBe(
      '/pipeline?new=1&brief=b1',
    );
  });

  it('fix 23: hidden for approvers', async () => {
    h.caps = { 'post.create': true, 'brief.create': true };
    h.getBrief.mockResolvedValue(detail());
    await mount();
    expect(text()).toContain('Festive drop');
    expect(button('New post from this brief')).toBeUndefined();
  });

  it('fix 23: hidden on a closed brief', async () => {
    h.caps = { 'post.create': true };
    h.getBrief.mockResolvedValue(
      detail({ status: 'closed', closed_at: '2026-10-05T10:00:00Z', closed_by: 'u1' }),
    );
    await mount();
    expect(text()).toContain('Festive drop');
    expect(button('New post from this brief')).toBeUndefined();
  });

  it('fix 23: hidden without post.create', async () => {
    h.getBrief.mockResolvedValue(detail());
    await mount();
    expect(button('New post from this brief')).toBeUndefined();
  });
});

describe('Brief detail polish', () => {
  const phone = () => document.querySelector<HTMLElement>('[data-brief-details="phone"]');
  const desktop = () => document.querySelector<HTMLElement>('[data-brief-details="desktop"]');

  it('phone Details shows the same facts as desktop: Status, Due date, Format, Raised, Linked posts', async () => {
    h.getBrief.mockResolvedValue(detail());
    await mount();
    for (const section of [phone(), desktop()]) {
      const terms = [...(section?.querySelectorAll('dt') ?? [])].map((dt) => dt.textContent);
      expect(terms).toEqual(['Status', 'Due date', 'Format', 'Raised', 'Linked posts']);
      expect(section?.textContent).toContain('by Asha Rao');
      expect(section?.textContent).toContain('carousel');
    }
    expect(text()).not.toContain('Target date');
  });

  it('hides the Format row on both when no format is set', async () => {
    h.getBrief.mockResolvedValue(detail({ format_requested: null }));
    await mount();
    for (const section of [phone(), desktop()]) {
      const terms = [...(section?.querySelectorAll('dt') ?? [])].map((dt) => dt.textContent);
      expect(terms).toEqual(['Status', 'Due date', 'Raised', 'Linked posts']);
    }
  });

  it('Open is the accent pill with a dot; Closed is the grey pill with a lock and the closed line', async () => {
    h.getBrief.mockResolvedValue(detail());
    await mount();
    const open = document.querySelector<HTMLElement>('[data-brief-status="open"]');
    expect(open?.className).toContain('bg-accent-soft');
    expect(text()).not.toContain('Closed briefs stay readable and open to comments.');
    act(() => root?.unmount());
    document.body.innerHTML = '';
    h.getBrief.mockResolvedValue(detail({ status: 'closed' }));
    await mount();
    const closed = document.querySelector<HTMLElement>('[data-brief-status="closed"]');
    expect(closed?.className).toContain('bg-panel-3');
    expect(closed?.querySelector('svg rect')).not.toBeNull();
    expect(text()).toContain('Closed briefs stay readable and open to comments.');
  });

  it('one wrapping title at the post title size', async () => {
    h.getBrief.mockResolvedValue(detail());
    await mount();
    const titles = document.querySelectorAll('h1');
    expect(titles).toHaveLength(1);
    expect(titles[0]?.className).toContain('text-[28px]');
    expect(titles[0]?.className).toContain('break-words');
    expect(titles[0]?.className).toContain('min-w-0');
  });

  it('shows a detail-shaped skeleton while loading, never "Loading brief"', async () => {
    h.getBrief.mockReturnValue(new Promise(() => {}));
    await mount();
    expect(document.querySelector('[data-testid="brief-detail-skeleton"]')).not.toBeNull();
    expect(text()).not.toContain('Loading brief');
  });

  it('never shows the dead-end "Select a workspace" line', async () => {
    h.getBrief.mockResolvedValue(detail());
    await mount();
    expect(text()).not.toContain('Select a workspace to view comments.');
  });
});
