// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The sheet imports the form's role picker; stub the form's in-shell deps.
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: vi.fn() } } }));
vi.mock('@/lib/workspace-context', () => ({ useWorkspace: () => ({ workspaceId: 'ws-1' }) }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 't-1' }));

import { MemberActionSheet, canChangeMemberRole } from './MemberActionSheet';
import type { MemberRoleChangeHandler } from './MemberActionSheet';
import type { MemberEntry } from './members-data';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function entry(overrides: Partial<MemberEntry> = {}): MemberEntry {
  return {
    id: 'm-1',
    userId: 'u-1',
    role: 'agency',
    displayName: 'Ada Agency',
    avatarUrl: null,
    email: null,
    acceptedAt: '2026-01-01T00:00:00Z',
    isOwner: false,
    isSelf: false,
    ...overrides,
  };
}

function mount(member: MemberEntry, canManage: boolean, onChangeRole: MemberRoleChangeHandler) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemberActionSheet
        member={member}
        open
        canManage={canManage}
        onClose={vi.fn()}
        onRemove={vi.fn()}
        onChangeRole={onChangeRole}
      />,
    ),
  );
}

function roleSelect(): HTMLSelectElement | null {
  return document.querySelector<HTMLSelectElement>('select[aria-label="Role"]');
}

function saveButton(): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Save');
}

describe('canChangeMemberRole', () => {
  it('is for managers, never on the owner row or their own row', () => {
    expect(canChangeMemberRole(entry(), true)).toBe(true);
    expect(canChangeMemberRole(entry(), false)).toBe(false);
    expect(canChangeMemberRole(entry({ role: 'owner', isOwner: true }), true)).toBe(false);
    expect(canChangeMemberRole(entry({ isSelf: true }), true)).toBe(false);
  });
});

describe('MemberActionSheet role change', () => {
  it('shows the role picker and Save above Remove for a manager', () => {
    mount(
      entry(),
      true,
      vi.fn(async () => null),
    );
    const select = roleSelect();
    expect(select).not.toBeNull();
    expect(select!.value).toBe('agency');
    const options = Array.from(select!.options).map((o) => o.value);
    expect(options).not.toContain('owner');
    const text = document.body.textContent ?? '';
    expect(text.indexOf('Save')).toBeLessThan(text.indexOf('Remove from workspace'));
  });

  it.each([
    ['the owner row', entry({ role: 'owner', isOwner: true }), true],
    ['the viewer own row', entry({ isSelf: true }), true],
    ['a viewer without manage-members', entry(), false],
  ])('hides the picker for %s', (_label, member, canManage) => {
    mount(
      member,
      canManage,
      vi.fn(async () => null),
    );
    expect(roleSelect()).toBeNull();
    expect(saveButton()).toBeUndefined();
    expect(document.body.textContent).toContain('Remove from workspace');
  });

  it('Save calls the role change with the picked role and shows a refusal inline', async () => {
    const onChangeRole = vi.fn<MemberRoleChangeHandler>(
      async () => 'Use a brand.com email, or a personal one like Gmail.',
    );
    mount(entry(), true, onChangeRole);
    expect(saveButton()!.disabled).toBe(true);
    act(() => {
      const select = roleSelect()!;
      select.value = 'client';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => saveButton()!.click());
    expect(onChangeRole).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-1' }), 'client');
    expect(document.body.textContent).toContain(
      'Use a brand.com email, or a personal one like Gmail.',
    );
  });
});
