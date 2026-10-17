// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockWorkspaceCreate, mockRefresh, mockSetActive, mockClearDeleted, mockState } = vi.hoisted(
  () => ({
    mockWorkspaceCreate: vi.fn(),
    mockRefresh: vi.fn(async () => {}),
    mockSetActive: vi.fn(),
    mockClearDeleted: vi.fn(),
    mockState: {
      createBlocked: false,
      deletedWorkspace: null as { name: string } | null,
      workspaces: [{ id: 'ws-1', name: 'Acme', platform: 'linkedin' }],
    },
  }),
);

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/env', () => ({
  env: { VITE_SUPABASE_URL: 'https://sb.test', VITE_SUPABASE_PUBLISHABLE_KEY: 'pk' },
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@srtdio/rpc', () => ({ workspaceCreate: mockWorkspaceCreate }));
vi.mock('@/lib/workspace-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace-context')>();
  return {
    ...actual,
    useWorkspace: () => ({
      workspaceId: 'ws-1',
      workspaces: mockState.workspaces,
      loading: false,
      error: null,
      setActiveWorkspaceId: mockSetActive,
      refreshWorkspaces: mockRefresh,
      createBlocked: mockState.createBlocked,
      workspaceDisplayName: 'Acme - LinkedIn',
      deletedWorkspace: mockState.deletedWorkspace,
      clearDeletedWorkspace: mockClearDeleted,
    }),
  };
});

import { WorkspaceSwitcher } from '@/components/shell/WorkspaceSwitcher';
import { WORKSPACE_LIMIT_MESSAGE } from '@/lib/workspace-context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

async function mount(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<WorkspaceSwitcher />));
  await act(async () => {
    window.dispatchEvent(new CustomEvent('sorted:switch-workspace'));
  });
}

beforeEach(async () => {
  mockState.createBlocked = false;
  mockState.deletedWorkspace = null;
  mockState.workspaces = [{ id: 'ws-1', name: 'Acme', platform: 'linkedin' }];
  mockClearDeleted.mockReset();
  mockSetActive.mockReset();
  mockWorkspaceCreate.mockReset();
  mockWorkspaceCreate.mockResolvedValue({ ok: true, data: 'ws-new' });
  await mount();
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

  it('opens straight on the create form when there is no workspace yet', async () => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
    mockState.workspaces = [];
    await mount();
    expect(dialogTitle()).toBe('Create workspace');
    expect(button('Continue').getAttribute('data-induction')).toBe('workspace-create-continue');
  });

  it('requires a platform, confirms, then sends the platform to workspace_create', async () => {
    await act(async () => button('Create workspace').click());
    expect(dialogTitle()).toBe('Create workspace');
    expect(document.querySelector('label[for="workspace-name"]')?.textContent).toContain(
      'Brand name',
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

  it('shows the free-plan message when workspace_create hits the owner limit', async () => {
    mockWorkspaceCreate.mockResolvedValue({
      ok: false,
      error: { code: 'unknown', message: 'workspace_limit_reached' },
    });
    await act(async () => button('Create workspace').click());
    await typeName('Somaiya');
    const tiles = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    await act(async () => tiles[0]!.click());
    await act(async () => button('Continue').click());
    await act(async () => button('Create').click());
    expect(document.body.textContent).toContain('On the free plan you can own one workspace.');
    expect(document.body.textContent).not.toContain('workspace_limit_reached');
    expect(mockSetActive).not.toHaveBeenCalledWith('ws-new');
    // Still open, Create usable again: no crash, no retry loop.
    expect(mockWorkspaceCreate).toHaveBeenCalledTimes(1);
    expect(button('Create').disabled).toBe(false);
  });

  it('starts Create disabled with the message when the owner may not create another', async () => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
    mockState.createBlocked = true;
    await mount();
    const create = button('Create workspace');
    expect(create.disabled).toBe(true);
    expect(create.getAttribute('aria-describedby')).toBe('workspace-limit-note');
    expect(document.getElementById('workspace-limit-note')?.textContent).toBe(
      WORKSPACE_LIMIT_MESSAGE,
    );
    await act(async () => create.click());
    expect(dialogTitle()).toBe('Switch workspace');
  });

  it('offers Contact us and Book a call under the limit message', async () => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
    mockState.createBlocked = true;
    await mount();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Contact ussupport@srtd.io');
    expect(text).toContain('Book a callPick a time, we send a Meet link');
    await act(async () => button('Contact ussupport@srtd.io').click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.querySelector('[aria-label="Write to us"]')).not.toBeNull();
    expect(document.body.textContent).toContain(
      "Hi, I'm on Acme - LinkedIn and need another workspace.",
    );
  });

  it('hides the rows for an exempt owner, who is never blocked', () => {
    expect(document.body.textContent).not.toContain('Contact us');
    expect(document.body.textContent).not.toContain('Book a call');
  });

  it('opens straight on the create form after a delete, with the gone hint', async () => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
    mockState.deletedWorkspace = { name: 'Somaiya - Instagram' };
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<WorkspaceSwitcher />));
    expect(dialogTitle()).toBe('Create workspace');
    expect(document.body.textContent).toContain('Somaiya - Instagram is gone. Start a new one.');
    expect(mockClearDeleted).not.toHaveBeenCalled();
    await act(async () => button('Back').click());
    expect(mockClearDeleted).toHaveBeenCalled();
  });
});
