// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
import { renderToStaticMarkup } from 'react-dom/server';

// The list imports the form's role picker; stub the form's in-shell deps.
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: vi.fn() } } }));
vi.mock('@/lib/workspace-context', () => ({ useWorkspace: () => ({ workspaceId: 'ws-1' }) }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 't-1' }));

import { getInviteRoleOptions } from './MembersInviteForm';
import { tagClass } from '@/components/ui/Tag';
import { MembersList, memberActionItems } from './MembersList';
import type { PendingEditHandler } from './MembersList';
import type { DerivedMembers, MemberEntry } from './members-data';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function entry(overrides: Partial<MemberEntry>): MemberEntry {
  return {
    id: 'm-0',
    userId: 'u-0',
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

const derived: DerivedMembers = {
  agency: [
    entry({ id: 'm-owner', displayName: 'Olive Owner', role: 'owner', isOwner: true }),
    entry({ id: 'm-agency', displayName: 'Ada Agency', role: 'agency' }),
  ],
  client: [entry({ id: 'm-client', displayName: 'Cara Client', role: 'client' })],
  pending: [],
};

// The props every render shares; each test overrides what it exercises.
function listProps(
  overrides: Partial<ComponentProps<typeof MembersList>> = {},
): ComponentProps<typeof MembersList> {
  return {
    derived,
    clientName: 'Acme',
    canManage: true,
    cancellingId: null,
    delivery: new Map(),
    pendingEmails: new Map(),
    roleOptions: getInviteRoleOptions(false),
    onChangeRole: vi.fn(),
    onRemove: vi.fn(),
    onCancelInvite: vi.fn(),
    onEditInvite: vi.fn<PendingEditHandler>(async () => null),
    ...overrides,
  };
}

const OWNER_LOCK_TITLE = 'Transfer ownership before the owner can be removed';

describe('memberActionItems', () => {
  it('Change role where allowed, then Remove from workspace last in the danger tone', () => {
    const actions = { onChangeRole: vi.fn(), onRemove: vi.fn() };
    const items = memberActionItems(entry({ id: 'm-a' }), true, actions);
    expect(items.map((i) => i.label)).toEqual(['Change role', 'Remove from workspace']);
    expect(items[1]!.tone).toBe('danger');
    items[1]!.onSelect();
    expect(actions.onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-a' }));
    // The viewer's own row cannot change role: the row is hidden, not disabled.
    const self = memberActionItems(entry({ isSelf: true }), true, actions);
    expect(self.map((i) => i.label)).toEqual(['Remove from workspace']);
  });
});

describe('MembersList', () => {
  it('owner/admin viewers see the email tag on active rows, self included', () => {
    const out = renderToStaticMarkup(
      <MembersList
        {...listProps({
          canManage: true,
          derived: {
            agency: [
              entry({ id: 'm-self', displayName: 'Sam Self', isSelf: true, emailOptIn: true }),
              entry({ id: 'm-off', displayName: 'Oli Off', emailOptIn: false }),
              entry({ id: 'm-old', displayName: 'Ola Old' }),
            ],
            client: [],
            pending: [
              entry({
                id: 'p-1',
                displayName: 'pia',
                role: 'client',
                acceptedAt: null,
                emailOptIn: false,
              }),
            ],
          },
        })}
      />,
    );
    expect(out.match(/>On</g)).toHaveLength(1);
    expect(out.match(/>Emails off</g)).toHaveLength(1);
    // The tag sits in the self row and the opted-out row only.
    const self = out.slice(out.indexOf('Sam Self'), out.indexOf('Oli Off'));
    expect(self).toContain('>On<');
    const old = out.slice(out.indexOf('Ola Old'));
    expect(old).not.toContain('>On<');
    expect(old).not.toContain('>Emails off<');
  });

  it('creator and approver viewers never see the email tag', () => {
    const out = renderToStaticMarkup(
      <MembersList
        {...listProps({
          canManage: false,
          derived: {
            agency: [entry({ id: 'm-a', emailOptIn: true })],
            client: [entry({ id: 'm-c', role: 'client', emailOptIn: false })],
            pending: [],
          },
        })}
      />,
    );
    expect(out).not.toContain('>On<');
    expect(out).not.toContain('>Emails off<');
  });

  it('shows the owner lock and no action kebabs for a read-only (client) viewer', () => {
    const out = renderToStaticMarkup(<MembersList {...listProps({ canManage: false })} />);
    expect(out).toContain(OWNER_LOCK_TITLE);
    expect(out).not.toContain('Actions for Ada Agency');
    expect(out).not.toContain('Actions for Cara Client');
  });

  it('shows action kebabs for non-owner rows when the viewer can manage', () => {
    const out = renderToStaticMarkup(<MembersList {...listProps()} />);
    // Owner still shows the lock, never a kebab.
    expect(out).toContain(OWNER_LOCK_TITLE);
    expect(out).not.toContain('Actions for Olive Owner');
    // Every other row gets a kebab.
    expect(out).toContain('Actions for Ada Agency');
    expect(out).toContain('Actions for Cara Client');
  });

  it('groups approvers (under the brand name), then creators, then the invited list', () => {
    const out = renderToStaticMarkup(
      <MembersList
        {...listProps({
          derived: {
            ...derived,
            pending: [
              entry({ id: 'p-client', displayName: 'pia', role: 'client', acceptedAt: null }),
              entry({ id: 'p-agency', displayName: 'tom', role: 'agency', acceptedAt: null }),
            ],
          },
          pendingEmails: new Map([['p-client', 'pia@acme.com']]),
        })}
      />,
    );
    const approvers = out.indexOf('>Approvers<');
    const team = out.indexOf('>Creators<');
    const invited = out.indexOf('>Invited</h3>');
    expect(approvers).toBeGreaterThan(-1);
    expect(team).toBeGreaterThan(approvers);
    expect(invited).toBeGreaterThan(team);
    // The brand name is the Approvers subheading.
    expect(out.indexOf('>Acme<')).toBeGreaterThan(approvers);
    expect(out.indexOf('>Acme<')).toBeLessThan(team);
    // Pending rows sit in the invited list: the known email, else the account name.
    expect(out.indexOf('pia@acme.com')).toBeGreaterThan(invited);
    expect(out.indexOf('>tom<')).toBeGreaterThan(invited);
    // Each keeps Edit and Cancel; the role name reads as the picker label.
    expect(out.match(/>Edit</g)).toHaveLength(2);
    expect(out.match(/>Cancel</g)).toHaveLength(2);
    expect(out).toContain('>Approver<');
    expect(out).not.toContain('Not delivered');
  });

  it('shows "Not delivered" next to Invited only for a bounced invite', () => {
    const out = renderToStaticMarkup(
      <MembersList
        {...listProps({
          derived: {
            ...derived,
            pending: [
              entry({ id: 'p-1', displayName: 'pia', role: 'client', acceptedAt: null }),
              entry({ id: 'p-2', displayName: 'tom', role: 'agency', acceptedAt: null }),
            ],
          },
          delivery: new Map([
            ['p-1', 'bounced'],
            ['p-2', 'delivered'],
          ]),
        })}
      />,
    );
    expect(out.match(/Not delivered/g)).toHaveLength(1);
    expect(out).toMatch(/Invited<\/span><span[^>]*text-bad[^>]*>Not delivered/);
    // Both pills are ui/Tag: Invited neutral, Not delivered bad.
    expect(out).toContain(`<span class="${tagClass('neutral')}">Invited</span>`);
    expect(out).toContain(`<span class="${tagClass('bad')}">Not delivered</span>`);
  });

  it('shows the empty lines for a side with nobody yet and no pending invites', () => {
    const out = renderToStaticMarkup(
      <MembersList {...listProps({ derived: { ...derived, client: [] } })} />,
    );
    expect(out).toContain('Approvers show up here.');
    expect(out).toContain('People you invite show up here.');
  });

  it('hides Edit and Cancel for viewers who cannot manage', () => {
    const out = renderToStaticMarkup(
      <MembersList
        {...listProps({
          canManage: false,
          derived: {
            ...derived,
            pending: [entry({ id: 'p-1', displayName: 'pia', role: 'client', acceptedAt: null })],
          },
        })}
      />,
    );
    expect(out).not.toContain('>Edit<');
    expect(out).not.toContain('>Cancel<');
  });
});

describe('MembersList pending edit', () => {
  function mountWithPending(onEditInvite: PendingEditHandler) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <MembersList
          {...listProps({
            derived: {
              ...derived,
              pending: [entry({ id: 'p-1', displayName: 'pia', role: 'client', acceptedAt: null })],
            },
            pendingEmails: new Map([['p-1', 'pia@acme.com']]),
            onEditInvite,
          })}
        />,
      ),
    );
    return {
      host,
      unmount: () => {
        act(() => root.unmount());
        host.remove();
      },
    };
  }

  function button(host: HTMLElement, name: string): HTMLButtonElement {
    const found = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === name);
    if (found === undefined) throw new Error(`no ${name} button`);
    return found;
  }

  it('turns the row into fields in place with the local part selected', () => {
    const { host, unmount } = mountWithPending(vi.fn<PendingEditHandler>(async () => null));
    act(() => button(host, 'Edit').click());
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Email"]')!;
    expect(input.value).toBe('pia@acme.com');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3]);
    expect(host.textContent).toContain('Saving sends a fresh invite. The old link stops working.');
    act(() => button(host, 'Keep as is').click());
    expect(host.querySelector('input[aria-label="Email"]')).toBeNull();
    unmount();
  });

  it('Save with no change closes without sending', async () => {
    const onEditInvite = vi.fn<PendingEditHandler>(async () => null);
    const { host, unmount } = mountWithPending(onEditInvite);
    act(() => button(host, 'Edit').click());
    await act(async () => button(host, 'Save').click());
    expect(onEditInvite).not.toHaveBeenCalled();
    expect(host.querySelector('input[aria-label="Email"]')).toBeNull();
    unmount();
  });

  it('Save with a new email hands the change over and shows a refusal inline', async () => {
    const onEditInvite = vi.fn<PendingEditHandler>(
      async () => "Temporary emails can't be invited. Use a permanent one.",
    );
    const { host, unmount } = mountWithPending(onEditInvite);
    act(() => button(host, 'Edit').click());
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Email"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, 'pia@acme.org');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button(host, 'Save').click());
    expect(onEditInvite).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-1' }), {
      email: 'pia@acme.org',
      role: 'client',
      sameEmail: false,
    });
    expect(host.textContent).toContain("Temporary emails can't be invited. Use a permanent one.");
    unmount();
  });
});
