// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1', workspaceDisplayName: 'Acme - LinkedIn' }),
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/env', () => ({
  env: { VITE_SUPABASE_URL: 'https://sb.test', VITE_SUPABASE_PUBLISHABLE_KEY: 'pk' },
}));

import { uploadAssetFile, type UploadFetcher } from '@/lib/asset-upload';
import { reportWorkspaceFull } from '@/lib/storage-full';
import { WorkspaceFullSheet, workspaceFullCopy } from './WorkspaceFullSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MB = 1024 * 1024;
let root: Root | null = null;

async function settle(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={['/assets']}>
        <Routes>
          <Route path="*" element={<WorkspaceFullSheet />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}

function dialogTitles(): string[] {
  return [...document.querySelectorAll('[role="dialog"]')].map(
    (d) => d.getAttribute('aria-label') ?? '',
  );
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('workspace full sheet', () => {
  it('words the refused file size in human units', () => {
    expect(workspaceFullCopy(12 * MB + 1000)).toBe(
      "There isn't room for this 12 MB file. Free up space in Recently deleted, or talk to us about more storage.",
    );
    expect(workspaceFullCopy(12 * MB)).not.toContain('950');
  });

  it('opens on reportWorkspaceFull with its rows, and Cancel closes it', async () => {
    await render();
    expect(dialogTitles()).toEqual([]);
    await act(async () => reportWorkspaceFull(12 * MB));
    await settle();
    expect(dialogTitles()).toEqual(['This workspace is full']);
    const text = document.body.textContent ?? '';
    expect(text).toContain("There isn't room for this 12 MB file.");
    expect(text).toContain('Recently deletedFree up space now');
    expect(text).toContain('Contact ussupport@srtd.io');
    expect(text).toContain('Book a callPick a time, we send a Meet link');
    await act(async () => button('Cancel').click());
    await settle(300);

    expect(dialogTitles()).toEqual([]);
  });

  it('Contact us swaps the full sheet for Write to us', async () => {
    await render();
    await act(async () => reportWorkspaceFull(3 * MB));
    await settle();
    await act(async () => button('Contact us').click());
    await settle(300);
    expect(dialogTitles()).toEqual(['Write to us']);
  });

  it('a 413 workspace_full upload opens the sheet with that file size', async () => {
    await render();
    const fetcher: UploadFetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'workspace_full', message: 'This workspace is full.' } }),
          { status: 413 },
        ),
    );
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    Object.defineProperty(file, 'size', { value: 2 * MB });
    let out: Awaited<ReturnType<typeof uploadAssetFile>> | null = null;
    await act(async () => {
      out = await uploadAssetFile(file, {
        endpoint: 'https://upload.test',
        token: 'tok',
        workspaceId: 'ws-1',
        origin: 'chat',
        filename: 'a.png',
        fetcher,
      });
    });
    expect(out).toEqual({ ok: false, message: 'This workspace is full', code: 'workspace_full' });
    await settle();
    expect(dialogTitles()).toEqual(['This workspace is full']);
    expect(document.body.textContent).toContain('this 2 MB file');
  });
});
