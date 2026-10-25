// @vitest-environment jsdom
// Type roles on Settings > Members (design rules, 24 Oct 2026): the group
// headings (Approvers, Creators, Invited) are section labels (sm/600 uppercase
// tracking-[0.06em] fg-2), a member name is the row title (base/500), and the
// email and joined date are sm fg-3 meta. Fixtures mirror MembersList.test.tsx.
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', () => ({ useIsLaptop: () => true }));

vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: vi.fn() } } }));
vi.mock('@/lib/workspace-context', () => ({ useWorkspace: () => ({ workspaceId: 'ws-1' }) }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 't-1' }));

import { getInviteRoleOptions } from './MembersInviteForm';
import { MembersList } from './MembersList';
import type { PendingEditHandler } from './MembersList';
import type { DerivedMembers, MemberEntry } from './members-data';

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
    entry({
      id: 'm-agency',
      displayName: 'Ada Agency',
      role: 'agency',
      email: 'ada@agency.test',
    }),
  ],
  client: [],
  pending: [],
};

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

function mount(): void {
  document.body.innerHTML = renderToStaticMarkup(<MembersList {...listProps()} />);
}

/** The deepest element whose whole text is `text`. */
function byText(text: string): HTMLElement {
  const hits = [...document.body.querySelectorAll<HTMLElement>('*')].filter(
    (el) => el.textContent?.trim() === text,
  );
  const deepest = hits.find((el) => ![...el.children].some((c) => c.textContent?.trim() === text));
  if (deepest === undefined) throw new Error(`no element with text "${text}"`);
  return deepest;
}

function expectRole(el: Element, classes: string[]): void {
  const list = el.className.split(/\s+/);
  for (const c of classes) expect(list).toContain(c);
}

const SECTION_LABEL = ['text-sm', 'font-semibold', 'uppercase', 'tracking-[0.06em]', 'text-fg-2'];

afterEach(() => {
  document.body.innerHTML = '';
});

describe('MembersList type roles', () => {
  it('every group heading is a section label', () => {
    mount();
    for (const heading of ['Approvers', 'Creators', 'Invited']) {
      const el = byText(heading);
      expect(el.tagName).toBe('H3');
      expectRole(el, SECTION_LABEL);
      expect(el.className).not.toContain('text-base');
    }
  });

  it('the brand line under Approvers and the group counts are sm fg-3 meta', () => {
    mount();
    expectRole(byText('Acme'), ['text-sm', 'text-fg-3']);
    const approvers = byText('Approvers');
    const count = approvers.nextElementSibling as HTMLElement;
    expect(count.textContent).toBe('0');
    expectRole(count, ['text-sm', 'text-fg-3']);
  });

  it('a member name is the row title: base/500', () => {
    mount();
    expectRole(byText('Ada Agency'), ['text-base', 'font-medium', 'text-fg']);
  });

  it('the member email is sm fg-3 meta', () => {
    mount();
    expectRole(byText('ada@agency.test'), ['text-sm', 'text-fg-3']);
  });

  it('an empty group line is base fg-2 copy', () => {
    mount();
    expectRole(byText('Approvers show up here.'), ['text-base', 'text-fg-2']);
  });
});
