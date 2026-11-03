// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The sheet imports the form's role picker; stub the form's in-shell deps.
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: vi.fn() } } }));
vi.mock('@/lib/workspace-context', () => ({ useWorkspace: () => ({ workspaceId: 'ws-1' }) }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 't-1' }));

import { MemberActionSheet, canChangeMemberRole, canSetMemberEmail } from './MemberActionSheet';
import type {
  MemberEmailOptInHandler,
  MemberRoleChangeHandler,
  SheetPerson,
} from './MemberActionSheet';
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

const PEOPLE: Record<string, SheetPerson> = {
  'u-me': { userId: 'u-me', name: 'Zara Owner', avatarUrl: null },
  'u-boss': { userId: 'u-boss', name: 'Bo Admin', avatarUrl: null },
};

function mount(
  member: MemberEntry,
  canManage: boolean,
  onChangeRole: MemberRoleChangeHandler,
  onSetEmailOptIn: MemberEmailOptInHandler = vi.fn(async () => 'saved' as const),
) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemberActionSheet
        member={member}
        open
        canManage={canManage}
        viewerId="u-me"
        onClose={vi.fn()}
        onChangeRole={onChangeRole}
        onSetEmailOptIn={onSetEmailOptIn}
        personFor={(userId) => PEOPLE[userId] ?? null}
      />,
    ),
  );
}

// The DOM lib's HTMLSelectElement does not satisfy querySelector's Element
// constraint here (remove() overloads), so the select is read structurally.
type SelectLike = Element & { value: string; options: ArrayLike<{ value: string }> };

function roleSelect(): SelectLike | null {
  return document.querySelector('select[aria-label="Role"]') as SelectLike | null;
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
  it('shows the role picker and Save for a manager; Remove lives in the row ⋯ menu', () => {
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
    expect(saveButton()).toBeDefined();
    expect(document.body.textContent).not.toContain('Remove from workspace');
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

const OFF_BY_MEMBER = 'They turned catch-up emails off. Only they can turn them back on.';
const HELPER = 'Turns off for this person in every workspace.';

function emailBox(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('#member-email-opt-in');
}

function emailRow(): Element | null {
  return document.querySelector('[data-member-email]');
}

function offByLine(): Element | null {
  return document.querySelector('[data-member-email-off-by]');
}

/** A handler whose answer the test gives by hand. */
function heldHandler() {
  let answer: (outcome: 'saved' | 'failed' | 'turned_off_by_member') => void = () => undefined;
  const handler = vi.fn<MemberEmailOptInHandler>(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  return { handler, answer: (o: 'saved' | 'failed' | 'turned_off_by_member') => answer(o) };
}

describe('canSetMemberEmail', () => {
  it('is for managers on anyone but themselves, once the state was read', () => {
    expect(canSetMemberEmail(entry({ emailOptIn: true, emailOptOutBy: null }), true)).toBe(true);
    expect(canSetMemberEmail(entry({ emailOptIn: true, emailOptOutBy: null }), false)).toBe(false);
    expect(
      canSetMemberEmail(entry({ isSelf: true, emailOptIn: true, emailOptOutBy: null }), true),
    ).toBe(false);
    expect(canSetMemberEmail(entry(), true)).toBe(false);
  });
});

describe('MemberActionSheet catch-up emails', () => {
  it('on: a ticked box with the helper, no "Turned off by"', () => {
    mount(
      entry({ emailOptIn: true, emailOptOutBy: null }),
      true,
      vi.fn(async () => null),
    );
    expect(emailRow()?.getAttribute('data-member-email')).toBe('on');
    expect(emailBox()?.checked).toBe(true);
    expect(document.body.textContent).toContain('Catch-up emails');
    expect(document.body.textContent).toContain(HELPER);
    expect(offByLine()).toBeNull();
    expect(document.body.textContent).not.toContain(OFF_BY_MEMBER);
  });

  it('off by a manager: an unticked box, the helper and the manager through PersonTrigger', () => {
    mount(
      entry({ emailOptIn: false, emailOptOutBy: 'u-boss' }),
      true,
      vi.fn(async () => null),
    );
    expect(emailRow()?.getAttribute('data-member-email')).toBe('off-by-manager');
    expect(emailBox()?.checked).toBe(false);
    expect(document.body.textContent).toContain(HELPER);
    expect(offByLine()?.textContent).toBe('Turned off by Bo Admin');
    expect(offByLine()?.querySelector('[data-person-trigger="u-boss"]')?.textContent).toBe(
      'Bo Admin',
    );
  });

  it('off by the person: no tick box, only the line saying only they can turn it on', () => {
    mount(
      entry({ emailOptIn: false, emailOptOutBy: null }),
      true,
      vi.fn(async () => null),
    );
    expect(emailRow()?.getAttribute('data-member-email')).toBe('off-by-member');
    expect(emailBox()).toBeNull();
    expect(document.body.textContent).toContain(OFF_BY_MEMBER);
    expect(document.body.textContent).not.toContain(HELPER);
  });

  it('untick calls the handler with false and paints at once, naming the viewer', async () => {
    const { handler, answer } = heldHandler();
    mount(
      entry({ emailOptIn: true, emailOptOutBy: null }),
      true,
      vi.fn(async () => null),
      handler,
    );
    act(() => emailBox()!.click());
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-1' }), false);
    expect(emailBox()!.checked).toBe(false);
    expect(offByLine()?.textContent).toBe('Turned off by Zara Owner');
    await act(async () => answer('saved'));
    expect(emailBox()!.checked).toBe(false);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('tick on a manager-off row calls the handler with true', async () => {
    const { handler, answer } = heldHandler();
    mount(
      entry({ emailOptIn: false, emailOptOutBy: 'u-boss' }),
      true,
      vi.fn(async () => null),
      handler,
    );
    act(() => emailBox()!.click());
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-1' }), true);
    expect(emailBox()!.checked).toBe(true);
    expect(offByLine()).toBeNull();
    await act(async () => answer('saved'));
    expect(emailBox()!.checked).toBe(true);
  });

  it('a failure reverts the box and shows the inline error', async () => {
    const { handler, answer } = heldHandler();
    mount(
      entry({ emailOptIn: true, emailOptOutBy: null }),
      true,
      vi.fn(async () => null),
      handler,
    );
    act(() => emailBox()!.click());
    expect(emailBox()!.checked).toBe(false);
    await act(async () => answer('failed'));
    expect(emailBox()!.checked).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Couldn't save. Try again.");
  });

  it('turned_off_by_member lands the off-by-the-person state with no error', async () => {
    const { handler, answer } = heldHandler();
    mount(
      entry({ emailOptIn: false, emailOptOutBy: 'u-boss' }),
      true,
      vi.fn(async () => null),
      handler,
    );
    act(() => emailBox()!.click());
    await act(async () => answer('turned_off_by_member'));
    expect(emailRow()?.getAttribute('data-member-email')).toBe('off-by-member');
    expect(emailBox()).toBeNull();
    expect(document.body.textContent).toContain(OFF_BY_MEMBER);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([
    ['a client viewer', entry({ emailOptIn: true, emailOptOutBy: null }), false],
    ['the viewer own row', entry({ isSelf: true, emailOptIn: true, emailOptOutBy: null }), true],
  ])('is hidden for %s', (_label, member, canManage) => {
    mount(
      member,
      canManage,
      vi.fn(async () => null),
    );
    expect(emailRow()).toBeNull();
    expect(document.body.textContent).not.toContain('Catch-up emails');
  });
});
