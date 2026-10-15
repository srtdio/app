// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { state, mockRpc, mockShow, mockPatch } = vi.hoisted(() => ({
  state: { canEdit: false as boolean | null, userId: 'user-member' },
  mockRpc: vi.fn(),
  mockShow: vi.fn(),
  mockPatch: vi.fn(),
}));

const ROW = {
  id: 'ws-1',
  name: 'Acme',
  platform: 'instagram',
  timezone: 'Asia/Kolkata',
  logo_url: null,
  owner_user_id: 'user-owner',
  client_domain: 'acmebrand.com',
};

vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({
    workspaceId: 'ws-1',
    workspaces: [ROW],
    applyWorkspacePatch: mockPatch,
  }),
}));
vi.mock('@/lib/workspace-context-capability', () => ({
  useWorkspaceCapability: (cap: string) =>
    cap === 'workspace.manage_settings' ? state.canEdit : null,
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: state.userId } } }),
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('@/lib/supabase', () => {
  const query = {
    select: () => query,
    eq: () => query,
    is: () => query,
    order: async () => ({ data: [{ domain: 'acmegroup.com' }], error: null }),
  };
  return { supabase: { from: () => query, rpc: mockRpc } };
});

import {
  CLIENT_NAME_FIXED_LINE,
  PLATFORM_FIXED_LINE,
  WorkspaceSettingsPanel,
} from './WorkspaceSettingsPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

async function render(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<WorkspaceSettingsPanel />));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  mockRpc.mockReset();
  mockShow.mockReset();
  mockPatch.mockReset();
});

function button(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
}

describe('WorkspaceSettingsPanel', () => {
  it('shows read-only values to a member without workspace.manage_settings', async () => {
    state.canEdit = false;
    state.userId = 'user-member';
    await render();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Client name');
    expect(text).toContain('Acme');
    expect(text).toContain('Instagram');
    expect(text).toContain(CLIENT_NAME_FIXED_LINE);
    expect(text).toContain(PLATFORM_FIXED_LINE);
    expect(text).toContain('Asia/Kolkata');
    expect(document.querySelector('input')).toBeNull();
    expect(document.querySelector('button[aria-label="Timezone"]')).toBeNull();
    expect(text).not.toContain('Logo');
    expect(text).not.toContain('Approved approver addresses');
  });

  it('lets an admin edit the timezone only, with no logo, and keeps addresses owner-only', async () => {
    state.canEdit = true;
    state.userId = 'user-admin';
    await render();
    expect(document.querySelector('button[aria-label="Timezone"]')).not.toBeNull();
    expect(document.querySelector('input')).toBeNull();
    expect(button('Upload logo')).toBeUndefined();
    expect(document.body.textContent).not.toContain('Logo');
    expect(document.body.textContent).not.toContain('Approved approver addresses');
  });

  it('keeps the client name read-only for an admin too, and never sends it', async () => {
    state.canEdit = true;
    state.userId = 'user-admin';
    mockRpc.mockResolvedValue({ data: null, error: null });
    await render();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Acme');
    expect(text).toContain(CLIENT_NAME_FIXED_LINE);
    expect(CLIENT_NAME_FIXED_LINE).toBe(
      'Fixed when the workspace was created. To change it, delete this workspace and create a new one.',
    );
    expect(document.querySelector('#workspace-client-name')).toBeNull();
    expect(button('Save name')).toBeUndefined();

    // Timezone still saves, and the payload carries nothing else.
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Timezone"]')!.click(),
    );
    const other = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (o) => o.textContent !== 'Asia/Kolkata',
    )!;
    const zone = other.textContent ?? '';
    await act(async () => other.click());
    expect(mockRpc).toHaveBeenCalledWith('workspace_update', {
      p_workspace_id: 'ws-1',
      p_payload: { timezone: zone },
      p_trace_id: 'trace-1',
    });
    for (const call of mockRpc.mock.calls) {
      expect(Object.keys((call[1] as { p_payload: object }).p_payload)).toEqual(['timezone']);
    }
    expect(mockPatch).toHaveBeenCalledWith('ws-1', { timezone: zone });
  });

  it('shows the owner the approved addresses and words free_mail_client', async () => {
    state.canEdit = true;
    state.userId = 'user-owner';
    await render();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Approved approver addresses');
    expect(text).toContain(
      'Approvers need an address with acmebrand in it. Add another company address here, for example a group company.',
    );
    expect(text).toContain('acmegroup.com');
    expect(document.querySelector('button[aria-label="Remove acmegroup.com"]')).not.toBeNull();

    mockRpc.mockResolvedValue({ data: null, error: { message: 'free_mail_client' } });
    const input = document.querySelector<HTMLInputElement>('#approved-address')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, 'gmail.com');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Add address')!.click());
    expect(mockRpc).toHaveBeenCalledWith('workspace_client_domain_add', {
      p_workspace_id: 'ws-1',
      p_domain: 'gmail.com',
      p_trace_id: 'trace-1',
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Free email addresses cannot be approved.',
    );
  });

  it('confirms before removing an address', async () => {
    state.canEdit = true;
    state.userId = 'user-owner';
    mockRpc.mockResolvedValue({ data: null, error: null });
    await render();
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Remove acmegroup.com"]')!
        .click(),
    );
    expect(mockRpc).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Remove acmegroup.com?');
  });
});
