// @vitest-environment jsdom
// W5 Brief detail: a load failure shows LoadError ("Couldn't load this brief.")
// with Retry and never the server's text, and Retry re-reads; not-found is its
// own state; the header ⋯ menu is on every brief: Copy link always, Close
// brief (open, gated on brief.close or brief.close_own for the creator; no
// confirm, it commits brief_close only after the Undo window) or Reopen brief
// (closed, any member; optimistic, commits brief_reopen after the Undo window);
// no KEY-N code anywhere; Copy brief in the menu (no copy icons on section
// labels); Created by skeleton; no helper text; Back pops in-app history or goes
// to /briefs; the top bar status line; details as two lines; linked posts.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, ToastViewport } from '@/components/ui/toast';
import {
  BriefDetailPage,
  briefBackTarget,
  briefCopyLink,
  briefCopyText,
  briefFormatLabel,
  briefStatusLine,
  canCloseBrief,
  linkedPostsFor,
  LINKED_POSTS_SCAN,
  reopenErrorCopy,
} from '@/components/pages/BriefDetailPage';
import { WORKSPACE_DATA_CHANGED_EVENT } from '@/lib/events';
import { DUR_BASE_MS } from '@/lib/motion';
import { UNDO_WINDOW_MS } from '@/lib/use-undoable-action';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  getBrief: vi.fn(),
  getBriefGallery: vi.fn(),
  briefClose: vi.fn(),
  reopenBrief: vi.fn(),
  linkedPosts: vi.fn(),
  caps: {} as Record<string, boolean>,
  members: { loading: false },
  viewer: 'u1',
  laptop: false,
}));

vi.mock('@srtdio/briefs', () => ({
  getBrief: (...args: unknown[]) => h.getBrief(...args),
  getBriefGallery: (...args: unknown[]) => h.getBriefGallery(...args),
  reopenBrief: (...args: unknown[]) => h.reopenBrief(...args),
}));
vi.mock('@srtdio/rpc', () => ({ briefClose: (...args: unknown[]) => h.briefClose(...args) }));
// The linked-posts list is one posts read filtered on brief_id.
vi.mock('../../../packages/posts/src/reads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../packages/posts/src/reads')>()),
  listBriefLinkedPosts: (...args: unknown[]) => h.linkedPosts(...args),
}));
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
vi.mock('@/lib/workspace-members', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-members')>()),
  useWorkspaceMembers: () => ({
    options: h.members.loading ? [] : [{ userId: 'u1', displayName: 'Asha Rao' }],
    loading: h.members.loading,
    error: null,
  }),
}));
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => h.laptop,
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
  await act(async () => byLabel('More actions')?.click());
}
/** The ui/ActionMenu rows, keyed by the ids these specs have always used. */
const ROW_IDS: Record<string, string> = {
  'Copy link': 'brief-menu-copy-link',
  'Copy brief': 'brief-menu-copy-brief',
  'Close brief': 'brief-menu-close',
  'Reopen brief': 'brief-menu-reopen',
};
/** The open menu's rows as [id, label], in order. */
const menuRows = (): [string, string][] =>
  [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].map(
    (el): [string, string] => {
      const label = el.textContent?.trim() ?? '';
      return [ROW_IDS[label] ?? '', label];
    },
  );
const menuRow = (id: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (el) => ROW_IDS[el.textContent?.trim() ?? ''] === id,
  ) ?? null;
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
  h.linkedPosts.mockReset().mockResolvedValue({ ok: true, data: [] });
  h.caps = {};
  h.members.loading = false;
  h.viewer = 'u1';
  h.laptop = false;
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
    expect(byLabel('More actions')).not.toBeNull();
    expect(button('Close brief')).toBeUndefined();
    await openMenu();
    expect(menuRows()).toEqual([
      ['brief-menu-copy-link', 'Copy link'],
      ['brief-menu-copy-brief', 'Copy brief'],
    ]);
    expect(button('Close brief')).toBeUndefined();
    expect(button('Reopen brief')).toBeUndefined();
  });

  it('brief.close: Close is in the ⋯ menu and closes at once behind Undo, no confirm', async () => {
    h.caps = { 'brief.close': true };
    h.getBrief.mockResolvedValue(detail());
    await mount();
    expect(button('Close brief')).toBeUndefined();
    await act(async () => byLabel('More actions')?.click());
    await act(async () => menuRow('brief-menu-close')?.click());
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(text()).toContain('Brief closed');
    expect(text()).toContain('Closed');
    // The write waits for the Undo window.
    expect(h.briefClose).not.toHaveBeenCalled();
    await act(async () => button('Undo')?.click());
    expect(h.briefClose).not.toHaveBeenCalled();
    expect(byLabel('More actions')).not.toBeNull();
  });

  it('commits brief_close once the window is cut short (leaving the page)', async () => {
    h.caps = { 'brief.close': true };
    h.getBrief.mockResolvedValue(detail());
    await mount();
    await act(async () => byLabel('More actions')?.click());
    await act(async () => menuRow('brief-menu-close')?.click());
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
    expect(menuRows().map(([id]) => id)).toEqual([
      'brief-menu-copy-link',
      'brief-menu-copy-brief',
      'brief-menu-close',
    ]);
    act(() => root?.unmount());
    document.body.innerHTML = '';
    h.viewer = 'u2';
    await mount();
    expect(byLabel('More actions')).not.toBeNull();
    await openMenu();
    expect(menuRows().map(([id]) => id)).toEqual(['brief-menu-copy-link', 'brief-menu-copy-brief']);
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
  it('an open brief with close rights: Copy link, Copy brief, then Close brief', async () => {
    h.caps = { 'brief.close': true };
    h.getBrief.mockResolvedValue(detail());
    await mount();
    await openMenu();
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe(
      'Brief actions',
    );
    expect(menuRows()).toEqual([
      ['brief-menu-copy-link', 'Copy link'],
      ['brief-menu-copy-brief', 'Copy brief'],
      ['brief-menu-close', 'Close brief'],
    ]);
    expect(menuRow('brief-menu-reopen')).toBeNull();
  });

  it('an open brief without close rights: Copy link and Copy brief only', async () => {
    h.getBrief.mockResolvedValue(detail({ created_by: 'u9' }));
    await mount();
    await openMenu();
    expect(menuRows()).toEqual([
      ['brief-menu-copy-link', 'Copy link'],
      ['brief-menu-copy-brief', 'Copy brief'],
    ]);
  });

  it('a closed brief, member without close rights: Copy link, Copy brief, then Reopen brief', async () => {
    h.getBrief.mockResolvedValue(detail({ status: 'closed', created_by: 'u9' }));
    await mount();
    await openMenu();
    expect(menuRows()).toEqual([
      ['brief-menu-copy-link', 'Copy link'],
      ['brief-menu-copy-brief', 'Copy brief'],
      ['brief-menu-reopen', 'Reopen brief'],
    ]);
    expect(menuRow('brief-menu-close')).toBeNull();
  });

  it('a closed brief never offers Close brief, even with close rights', async () => {
    h.caps = { 'brief.close': true, 'brief.close_own': true };
    h.getBrief.mockResolvedValue(detail({ status: 'closed' }));
    await mount();
    await openMenu();
    expect(menuRows().map(([id]) => id)).toEqual([
      'brief-menu-copy-link',
      'brief-menu-copy-brief',
      'brief-menu-reopen',
    ]);
  });

  it('every row is a 44px menu item and picking one closes the menu', async () => {
    h.getBrief.mockResolvedValue(detail({ status: 'closed' }));
    await mount();
    await openMenu();
    for (const el of document.querySelectorAll<HTMLElement>('[role="menuitem"]')) {
      expect(el.className).toContain('min-h-[44px]');
    }
    await act(async () => menuRow('brief-menu-copy-link')?.click());
    // The phone Sheet stays mounted through its exit transition, then unmounts.
    await act(async () => {
      await new Promise((r) => setTimeout(r, DUR_BASE_MS + 50));
    });
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
    expect(menuRows().map(([id]) => id)).toEqual(['brief-menu-copy-link', 'brief-menu-copy-brief']);
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
  it('section labels carry no copy icons; Copy brief in the ⋯ menu copies title and sections', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    h.getBrief.mockResolvedValue(detail());
    await mount();
    expect(byLabel('Copy objective')).toBeNull();
    expect(byLabel('Copy brand requirements')).toBeNull();
    await openMenu();
    await act(async () => menuRow('brief-menu-copy-brief')?.click());
    await flush();
    expect(writeText).toHaveBeenCalledWith(
      'Festive drop\n\nObjective\nBuild hype for the drop\n\nBrand requirements\nGold logo only',
    );
    expect(text()).toContain('Copied');
  });

  it('Copy brief says "Couldn\'t copy" when the clipboard refuses', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
      configurable: true,
    });
    h.getBrief.mockResolvedValue(detail());
    await mount();
    await openMenu();
    await act(async () => menuRow('brief-menu-copy-brief')?.click());
    await flush();
    expect(text()).toContain("Couldn't copy");
  });

  it('briefCopyText leaves out an empty brand requirements section', () => {
    expect(briefCopyText({ title: 'T', objective: 'O', brand_requirements: '  ' })).toBe(
      'T\n\nObjective\nO',
    );
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

  it('phone: the action sits in a bar fixed to the bottom (no tab bar here), with IconPlus', async () => {
    h.caps = { 'post.create': true, 'brief.create': false };
    h.getBrief.mockResolvedValue(detail());
    await mount();
    const bar = document.querySelector<HTMLElement>('[data-brief-action-bar]');
    expect(bar?.className).toContain('fixed');
    expect(bar?.className).toContain('bottom-0');
    expect(bar?.className).toContain('pb-[max(12px,env(safe-area-inset-bottom))]');
    const start = bar?.querySelector('[data-new-post-from-brief="bar"]');
    expect(start?.textContent).toBe('New post from this brief');
    expect(start?.querySelector('svg')).not.toBeNull();
    expect(document.querySelector('[data-new-post-from-brief="top"]')).toBeNull();
    // The old full-width block under the title is gone.
    expect(document.querySelectorAll('[data-new-post-from-brief]')).toHaveLength(1);
    expect(
      document.querySelector('h1')?.parentElement?.querySelector('[data-new-post-from-brief]'),
    ).toBeNull();
  });

  it('laptop: the action sits at the right of the header, beside the ⋯; no bottom bar', async () => {
    h.laptop = true;
    h.caps = { 'post.create': true, 'brief.create': false };
    h.getBrief.mockResolvedValue(detail());
    await mount();
    expect(document.querySelector('[data-brief-action-bar]')).toBeNull();
    const top = document.querySelector<HTMLElement>('[data-new-post-from-brief="top"]');
    expect(top?.textContent).toBe('New post from this brief');
    const more = top?.nextElementSibling;
    expect(more?.querySelector('button[aria-label="More actions"]')).not.toBeNull();
  });

  it('fix 23: hidden for approvers', async () => {
    h.caps = { 'post.create': true, 'brief.create': true };
    h.getBrief.mockResolvedValue(detail());
    await mount();
    expect(text()).toContain('Festive drop');
    expect(button('New post from this brief')).toBeUndefined();
    expect(document.querySelector('[data-brief-action-bar]')).toBeNull();
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

  it('details are two lines on phone and desktop, with no Status or Due date cells', async () => {
    h.getBrief.mockResolvedValue(detail());
    await mount();
    for (const section of [phone(), desktop()]) {
      expect(section?.querySelectorAll('dt')).toHaveLength(0);
      // "1 Oct" in 2026, "1 Oct 2026" from a later year.
      expect(section?.querySelector('[data-brief-raised]')?.textContent).toMatch(
        /^Raised 1 Oct( 2026)? by Asha Rao$/,
      );
      expect(section?.querySelector('[data-brief-format]')?.textContent).toBe('Format Carousel');
      expect(section?.textContent).not.toContain('carousel');
      expect(section?.textContent).not.toContain('Status');
      expect(section?.textContent).not.toContain('Due date');
    }
    expect(text()).not.toContain('Target date');
  });

  it('hides the Format line on both when no format is set', async () => {
    h.getBrief.mockResolvedValue(detail({ format_requested: null }));
    await mount();
    for (const section of [phone(), desktop()]) {
      expect(section?.querySelector('[data-brief-format]')).toBeNull();
      expect(section?.querySelector('[data-brief-raised]')).not.toBeNull();
    }
  });

  it('briefFormatLabel proper-cases the requested format', () => {
    expect(briefFormatLabel('carousel')).toBe('Carousel');
    expect(briefFormatLabel('single_image')).toBe('Single image');
  });

  it('the top bar reads the status and due day with a 7px dot at 15px semibold', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-01T09:00:00Z'));
    h.getBrief.mockResolvedValue(detail({ target_date: '2026-08-14' }));
    await mount();
    const line = document.querySelector<HTMLElement>('[data-brief-status-line]');
    expect(line?.textContent).toBe('Open · Due 14 Aug');
    expect(line?.querySelector('[aria-hidden="true"]')?.className).toContain('h-[7px] w-[7px]');
    expect(line?.querySelector('.text-lg')?.className).toContain('font-semibold');
    expect(line?.querySelector('[data-brief-due]')?.className ?? '').not.toContain('text-bad');
  });

  it('past due: the due part reads overdue in text-bad', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T09:00:00Z'));
    h.getBrief.mockResolvedValue(detail({ target_date: '2026-08-14' }));
    await mount();
    const line = document.querySelector<HTMLElement>('[data-brief-status-line]');
    expect(line?.textContent).toBe('Open · Overdue 2 months');
    expect(line?.querySelector('[data-brief-due]')?.className).toContain('text-bad');
  });

  it('a closed brief reads "Closed" in the top bar, with the closed line under the title', async () => {
    h.getBrief.mockResolvedValue(detail({ status: 'closed' }));
    await mount();
    expect(document.querySelector('[data-brief-status-line]')?.textContent).toBe('Closed');
    expect(document.querySelector('[data-brief-due]')).toBeNull();
    expect(text()).toContain('Closed briefs stay readable and open to comments.');
  });

  it('briefStatusLine: due, overdue, no date, closed', () => {
    const now = new Date('2026-08-01T09:00:00Z');
    expect(briefStatusLine('open', '2026-08-14', 'UTC', now)).toEqual({
      status: 'Open',
      due: 'Due 14 Aug',
      overdue: false,
    });
    expect(briefStatusLine('open', '2026-08-01', 'UTC', now).overdue).toBe(false);
    expect(briefStatusLine('open', '2026-07-31', 'UTC', now)).toEqual({
      status: 'Open',
      due: 'Overdue · 31 Jul',
      overdue: true,
    });
    expect(briefStatusLine('open', null, 'UTC', now)).toEqual({
      status: 'Open',
      due: null,
      overdue: false,
    });
    expect(briefStatusLine('closed', '2026-07-31', 'UTC', now)).toEqual({
      status: 'Closed',
      due: null,
      overdue: false,
    });
  });

  it('one wrapping title at the post title size', async () => {
    h.getBrief.mockResolvedValue(detail());
    await mount();
    const titles = document.querySelectorAll('h1');
    expect(titles).toHaveLength(1);
    expect(titles[0]?.className).toContain('text-3xl');
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

describe('Brief detail linked posts', () => {
  const post = (id: string, briefId: string | null, createdAt: string) => ({
    id,
    title: `Post ${id}`,
    stage: 'review',
    created_at: createdAt,
    brief_id: briefId,
  });

  it('0 linked posts shows nothing', async () => {
    h.getBrief.mockResolvedValue({
      ...detail(),
      data: { ...detail().data, linked_posts_count: 0 },
    });
    await mount();
    expect(document.querySelector('[data-linked-posts]')).toBeNull();
    expect(text()).not.toContain('Linked posts');
  });

  it('reads the linked posts by brief_id beside the brief read (never a workspace scan)', async () => {
    let answerBrief: (value: unknown) => void = () => {};
    h.getBrief.mockReturnValue(
      new Promise((resolve) => {
        answerBrief = resolve;
      }),
    );
    await mount();
    // The brief has not answered, yet the linked read already went out.
    expect(h.linkedPosts).toHaveBeenCalledTimes(1);
    expect(h.linkedPosts.mock.calls[0]?.[1]).toEqual({ briefId: 'b1', limit: LINKED_POSTS_SCAN });
    answerBrief(detail());
    await flush();
    expect(h.linkedPosts).toHaveBeenCalledTimes(1);
  });

  it('holds the skeleton until the linked list lands (it never pops in under the page)', async () => {
    let answerLinked: (value: unknown) => void = () => {};
    h.linkedPosts.mockReturnValue(
      new Promise((resolve) => {
        answerLinked = resolve;
      }),
    );
    h.getBrief.mockResolvedValue(detail());
    await mount();
    expect(document.querySelector('[data-testid="brief-detail-skeleton"]')).not.toBeNull();
    answerLinked({ ok: true, data: [post('p1', 'b1', '2026-10-02T00:00:00Z')] });
    await flush();
    expect(document.querySelector('[data-testid="brief-detail-skeleton"]')).toBeNull();
    expect(document.querySelector('[data-linked-posts]')).not.toBeNull();
  });

  it('lists the linked posts as rows that open /posts/{id}, in the read order (newest first)', async () => {
    h.linkedPosts.mockResolvedValue({
      ok: true,
      data: [post('p2', 'b1', '2026-10-04T00:00:00Z'), post('p1', 'b1', '2026-10-02T00:00:00Z')],
    });
    h.getBrief.mockResolvedValue(detail());
    await mount();
    const rows = [
      ...document.querySelectorAll<HTMLAnchorElement>(
        '[data-brief-details="desktop"] ~ [data-linked-posts] a[data-linked-post]',
      ),
    ];
    expect(rows.map((a) => a.getAttribute('href'))).toEqual(['/posts/p2', '/posts/p1']);
    expect(rows[0]?.className).toContain('min-h-[44px]');
    expect(rows[0]?.textContent).toBe('Post p2');
  });

  it('keeps the count as a pipeline link when the read cannot list every post', async () => {
    h.linkedPosts.mockResolvedValue({ ok: true, data: [post('p1', 'b1', '2026-10-02T00:00:00Z')] });
    h.getBrief.mockResolvedValue(detail());
    await mount();
    const count = document.querySelector<HTMLAnchorElement>('[data-linked-posts-count]');
    expect(count?.getAttribute('href')).toBe('/pipeline');
    expect(count?.textContent).toBe('2');
    expect(document.querySelector('a[data-linked-post]')).toBeNull();
  });

  it('linkedPostsFor keeps this brief only, newest first', () => {
    expect(
      linkedPostsFor(
        [
          post('a', 'b1', '2026-01-01T00:00:00Z'),
          post('b', null, '2026-01-03T00:00:00Z'),
          post('c', 'b1', '2026-01-02T00:00:00Z'),
        ],
        'b1',
      ).map((p) => p.id),
    ).toEqual(['c', 'a']);
  });
});
