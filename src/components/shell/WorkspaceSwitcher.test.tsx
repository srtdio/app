// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockWorkspaceCreate, mockRefresh, mockSetActive } = vi.hoisted(() => ({
  mockWorkspaceCreate: vi.fn(),
  mockRefresh: vi.fn(async () => {}),
  mockSetActive: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@srtdio/rpc', () => ({ workspaceCreate: mockWorkspaceCreate }));
vi.mock('@/lib/workspace-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace-context')>();
  return {
    ...actual,
    useWorkspace: () => ({
      workspaceId: 'ws-1',
      workspaces: [{ id: 'ws-1', name: 'Acme', platform: 'linkedin' }],
      loading: false,
      error: null,
      setActiveWorkspaceId: mockSetActive,
      refreshWorkspaces: mockRefresh,
    }),
  };
});

import { WorkspaceSwitcher } from '@/components/shell/WorkspaceSwitcher';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

beforeEach(async () => {
  mockWorkspaceCreate.mockReset();
  mockWorkspaceCreate.mockResolvedValue({ ok: true, data: 'ws-new' });
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<WorkspaceSwitcher />));
  await act(async () => {
    window.dispatchEvent(new CustomEvent('sorted:switch-workspace'));
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  );
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
}

function dialogTitle(): string {
  return document.querySelector('[role="dialog"]')?.getAttribute('aria-label') ?? '';
}

async function typeName(value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('#workspace-name')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('WorkspaceSwitcher', () => {
  it('lists each workspace as "<Client> - <Platform>"', () => {
    expect(document.body.textContent).toContain('Acme - LinkedIn');
  });

  it('requires a platform, confirms, then sends the platform to workspace_create', async () => {
    await act(async () => button('Create workspace').click());
    expect(dialogTitle()).toBe('Create workspace');
    expect(document.querySelector('label[for="workspace-name"]')?.textContent).toContain(
      'Client name',
    );

    // Seven 44px tiles, none picked; Continue waits for both fields.
    const tiles = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(tiles.map((t) => t.textContent)).toEqual([
      'igInstagram',
      'xX',
      'thThreads',
      'inLinkedIn',
      'fbFacebook',
      'ttTikTok',
      'ytYouTube Shorts',
    ]);
    for (const tile of tiles) expect(tile.className).toContain('min-h-[44px]');
    expect(button('Continue').disabled).toBe(true);

    await typeName('Somaiya');
    expect(button('Continue').disabled).toBe(true);
    expect(document.body.textContent).not.toContain('Shown as');

    await act(async () => tiles[0]!.click());
    expect(tiles[0]!.getAttribute('aria-checked')).toBe('true');
    expect(document.body.textContent).toContain(
      'Shown as Somaiya - Instagram. The chat group takes the same name.',
    );
    expect(button('Continue').disabled).toBe(false);

    await act(async () => button('Continue').click());
    expect(dialogTitle()).toBe('One platform per workspace');
    expect(document.body.textContent).toContain(
      "Check the spelling: Somaiya - Instagram can't be changed later. To change it, you delete this workspace and create a new one.",
    );
    expect(mockWorkspaceCreate).not.toHaveBeenCalled();

    // Back returns to the form with the choices kept.
    await act(async () => button('Back').click());
    expect(dialogTitle()).toBe('Create workspace');
    await act(async () => button('Continue').click());

    await act(async () => button('Create').click());
    expect(mockWorkspaceCreate).toHaveBeenCalledTimes(1);
    const args = mockWorkspaceCreate.mock.calls[0]![1] as {
      p_payload: Record<string, unknown>;
      p_trace_id: string;
    };
    expect(args.p_payload).toMatchObject({ name: 'Somaiya', platform: 'instagram' });
    expect(typeof args.p_payload.timezone).toBe('string');
    expect(args.p_trace_id).toBe('trace-1');
    expect(mockSetActive).toHaveBeenCalledWith('ws-new');
  });
});
