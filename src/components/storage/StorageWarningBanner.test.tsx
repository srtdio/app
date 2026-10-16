// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { state, mockFetch } = vi.hoisted(() => ({
  state: { userId: 'user-member' },
  mockFetch: vi.fn(),
}));

vi.mock('@/lib/workspace-context', () => ({ useWorkspace: () => ({ workspaceId: 'ws-1' }) }));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: state.userId } } }),
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
  },
}));
vi.mock('@/lib/env', () => ({ env: { VITE_ASSET_UPLOAD_URL: 'https://upload.test/' } }));
vi.mock('@/lib/fetch', () => ({ fetchWithTrace: mockFetch }));

import { UPLOAD_COMPLETE_EVENT } from '@/lib/asset-upload';
import { StorageWarningBanner } from './StorageWarningBanner';
import {
  parseStorageUsage,
  readWarningDismissed,
  storageWarningCopy,
  writeWarningDismissed,
} from './storage-usage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MB = 1024 * 1024;
let root: Root | null = null;

function usageResponse(usedBytes: number, warn: boolean, exempt = false): Response {
  return Response.json({ usedBytes, warnAtBytes: 800 * MB, warn, exempt });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<StorageWarningBanner />));
  await settle();
}

function unmount(): void {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
}

const banner = (): Element | null => document.querySelector('[role="status"]');

afterEach(() => {
  unmount();
  mockFetch.mockReset();
  localStorage.clear();
  state.userId = 'user-member';
});

describe('storage warning copy and helpers', () => {
  it('words the warning in whole MB of the 1 GB and says deleted files count', () => {
    expect(storageWarningCopy(820 * MB + 12345)).toBe(
      'This workspace has used 820 MB of its 1 GB. Deleted files still count toward storage.',
    );
    expect(storageWarningCopy(820 * MB)).not.toContain('—');
  });

  it('accepts only a well-formed usage body', () => {
    expect(parseStorageUsage({ usedBytes: 1, warnAtBytes: 2, warn: false, exempt: true })).toEqual({
      usedBytes: 1,
      warnAtBytes: 2,
      warn: false,
      exempt: true,
    });
    expect(parseStorageUsage({ error: { code: 'usage_unavailable' } })).toBeNull();
  });

  it('keeps dismissal per viewer and survives blocked storage', () => {
    writeWarningDismissed('ws-1', 'user-owner');
    expect(readWarningDismissed('ws-1', 'user-owner')).toBe(true);
    expect(readWarningDismissed('ws-1', 'user-admin')).toBe(false);
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readWarningDismissed('ws-1', 'user-owner')).toBe(false);
    spy.mockRestore();
  });
});

describe('StorageWarningBanner', () => {
  it('shows a non-admin member the warning when the Worker says warn', async () => {
    mockFetch.mockImplementation(async () => usageResponse(820 * MB, true));
    await render();
    expect(mockFetch.mock.calls[0]![0]).toBe('https://upload.test/usage?workspace_id=ws-1');
    expect(banner()?.textContent).toContain(
      'This workspace has used 820 MB of its 1 GB. Deleted files still count toward storage.',
    );
    const close = banner()!.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!;
    expect(close.className).toContain('h-11 w-11');
  });

  it('never shows for an exempt workspace or when usage is unavailable', async () => {
    mockFetch.mockImplementation(async () => usageResponse(900 * MB, false, true));
    await render();
    expect(banner()).toBeNull();
    unmount();
    mockFetch.mockImplementation(async () => new Response('{}', { status: 503 }));
    await render();
    expect(banner()).toBeNull();
  });

  it('dismiss hides it on this device; fresh storage shows it again', async () => {
    mockFetch.mockImplementation(async () => usageResponse(820 * MB, true));
    await render();
    await act(async () =>
      banner()!.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click(),
    );
    expect(banner()).toBeNull();
    expect(readWarningDismissed('ws-1', 'user-member')).toBe(true);

    unmount();
    await render();
    expect(banner()).toBeNull();

    unmount();
    localStorage.clear();
    await render();
    expect(banner()).not.toBeNull();
  });

  it('re-reads usage after an upload in this workspace, with no toast', async () => {
    mockFetch.mockImplementation(async () => usageResponse(700 * MB, false));
    await render();
    expect(banner()).toBeNull();

    mockFetch.mockImplementation(async () => usageResponse(810 * MB, true));
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(UPLOAD_COMPLETE_EVENT, { detail: { workspaceId: 'ws-other' } }),
      );
    });
    await settle();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(UPLOAD_COMPLETE_EVENT, { detail: { workspaceId: 'ws-1' } }),
      );
    });
    await settle();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(banner()?.textContent).toContain('810 MB');
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
  });
});

describe('Assets page', () => {
  // The per-upload toast and the page's own banner are gone: the shell banner is
  // the only storage warning.
  const source = readFileSync(
    resolve(process.cwd(), 'src/components/pages/AssetsPage.tsx'),
    'utf8',
  );

  it('fires no storage toast after uploads and renders no second banner', () => {
    expect(source).not.toContain('storageWarningCopy');
    expect(source).not.toContain('useStorageWarning');
    expect(source).not.toContain('StorageWarningBanner');
  });
});
