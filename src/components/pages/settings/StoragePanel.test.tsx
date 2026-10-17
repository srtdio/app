// @vitest-environment jsdom
import { CAP_BYTES } from '@/lib/storage-limits';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockStorage } = vi.hoisted(() => ({ mockStorage: vi.fn() }));

vi.mock('@srtdio/rpc', () => ({ workspaceStorage: mockStorage }));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1', workspaceDisplayName: 'Acme - LinkedIn' }),
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/env', () => ({
  env: { VITE_SUPABASE_URL: 'https://sb.test', VITE_SUPABASE_PUBLISHABLE_KEY: 'pk' },
}));

import type { StorageUsage } from '@/components/storage/storage-usage';
import { StoragePanel, meterTone } from './StoragePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MB = 1024 * 1024;
const WARN = 800 * MB;
let root: Root | null = null;

function usage(usedBytes: number, exempt = false): StorageUsage {
  return { usedBytes, warnAtBytes: WARN, warn: !exempt && usedBytes >= WARN, exempt };
}

function storageRow(usedBytes: number) {
  return {
    ok: true,
    data: [
      {
        bytes_used: usedBytes,
        library_bytes: 500 * MB,
        chat_bytes: 120 * MB,
        voice_bytes: 30 * MB,
        deleted_bytes: 64 * MB,
      },
    ],
  };
}

async function render(value: StorageUsage | null): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <MemoryRouter>
        <StoragePanel usage={value} />
      </MemoryRouter>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  mockStorage.mockReset();
});

const text = (): string => document.body.textContent ?? '';
const tone = (): string | null =>
  document.querySelector('[role="meter"]')?.getAttribute('data-tone') ?? null;

describe('StoragePanel', () => {
  it('below 800 MB: usage and what is using it, nothing about limits or contact', async () => {
    mockStorage.mockResolvedValue(storageRow(700 * MB));
    await render(usage(700 * MB));
    expect(mockStorage).toHaveBeenCalledWith({}, { p_workspace_id: 'ws-1' });
    expect(text()).toContain('700 MBof 1 GB');
    expect(text()).toContain('Acme - LinkedIn · everything in this workspace counts');
    expect(text()).toContain("WHAT'S USING IT");
    expect(text()).toContain('Assets500 MB');
    expect(text()).toContain('Chat files120 MB');
    expect(text()).toContain('Voice notes30 MB');
    expect(text()).toContain('Recently deleted64 MB');
    expect(tone()).toBe('accent');
    for (const absent of ['NEED MORE SPACE?', 'Contact us', 'Book a call', 'more storage', '950']) {
      expect(text()).not.toContain(absent);
    }
  });

  it('from 800 MB: the warn meter and NEED MORE SPACE? with its rows', async () => {
    mockStorage.mockResolvedValue(storageRow(820 * MB));
    await render(usage(820 * MB));
    expect(tone()).toBe('warn');
    expect(text()).toContain('NEED MORE SPACE?');
    expect(text()).toContain(
      'Free up space in Recently deleted, or talk to us about more storage for Acme - LinkedIn.',
    );
    expect(text()).toContain('Recently deleted64 MB can be freed now');
    expect(text()).toContain('Contact ussupport@srtd.io');
    expect(text()).toContain('Book a callPick a time, we send a Meet link');
    expect(text()).not.toContain('950');
  });

  it('an exempt workspace never sees NEED MORE SPACE?', async () => {
    mockStorage.mockResolvedValue(storageRow(900 * MB));
    await render(usage(900 * MB, true));
    expect(text()).toContain('900 MBof 1 GB');
    expect(text()).not.toContain('NEED MORE SPACE?');
    expect(text()).not.toContain('Contact us');
    expect(tone()).toBe('accent');
  });

  it('the meter turns bad only once full (the upload cap)', () => {
    expect(meterTone(CAP_BYTES - 1, usage(CAP_BYTES - 1))).toBe('warn');
    expect(meterTone(CAP_BYTES, usage(CAP_BYTES))).toBe('bad');
    expect(meterTone(799 * MB, usage(799 * MB))).toBe('accent');
  });
});
