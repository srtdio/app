// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PERSON_CARD_COPY,
  PERSON_POPOVER_W,
  PersonCardBody,
  PersonCardHost,
  personCardData,
  personMetaLine,
  personPopoverPosition,
  type PersonCardData,
} from '@/components/ui/PersonCard';
import { rememberMentionNames, rememberMentionProfiles, resetMentionNames } from '@/lib/chat/mentions';
import type { ChatProfile } from '@/lib/chat-reads';
import {
  closePersonCard,
  openPersonCard,
  personCardSnapshot,
  type PersonCardRequest,
} from '@/lib/person-card';
import type { WorkspaceMemberRow, WorkspaceMembersData } from '@/lib/workspace-members';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS = '0190a000-0000-7000-8000-00000000a001';
const ME = '0190a000-0000-7000-8000-000000000001';
const LEO = '0190a000-0000-7000-8000-000000000003';
const GONE = '0190a000-0000-7000-8000-000000000009';

// The phone/laptop split is the one hook; the test flips it per case.
const laptop = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => laptop.value,
}));

vi.mock('@/lib/session-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session-context')>()),
  useSession: () => ({ session: { user: { id: '0190a000-0000-7000-8000-000000000001' } } }),
}));

vi.mock('@/lib/workspace-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-context')>()),
  useWorkspace: () => ({ workspaceId: '0190a000-0000-7000-8000-00000000a001' }),
}));

// The Message tap goes through the one open-my-DM path; the card only calls it.
const openDm = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@/components/ui/use-open-person-dm', () => ({
  useOpenPersonDm: () => (userId: string) => {
    openDm.calls.push(userId);
  },
}));

// The members cache: the test sets what the device already holds (no reads).
const membersHeld = vi.hoisted(() => ({
  rows: [] as unknown[],
  profiles: new Map<string, unknown>(),
}));
vi.mock('@/lib/workspace-members', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-members')>()),
  useWorkspaceMembers: () => ({
    loading: false,
    error: null,
    rows: membersHeld.rows,
    profiles: membersHeld.profiles,
    options: [],
    refetch: () => {},
  }),
  keptWorkspaceMembers: () => undefined,
}));

let root: Root | null = null;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function memberRow(userId: string, role: string, over: Partial<WorkspaceMemberRow> = {}): WorkspaceMemberRow {
  return {
    id: `row-${userId}`,
    workspace_id: WS,
    user_id: userId,
    role,
    active: true,
    removed_at: null,
    invited_at: '2026-01-01T00:00:00Z',
    invited_by: null,
    accepted_at: '2026-01-01T00:00:00Z',
    rejoined_at: null,
    join_default_group: false,
    ...over,
  };
}

function profile(userId: string, displayName: string, username: string | null): ChatProfile {
  return { userId, displayName, avatarUrl: null, username };
}

function holdMembers(rows: WorkspaceMemberRow[], profiles: ChatProfile[]): void {
  membersHeld.rows = rows;
  membersHeld.profiles = new Map(profiles.map((p) => [p.userId, p]));
}

function defaultMembers(): void {
  holdMembers(
    [memberRow(ME, 'owner'), memberRow(LEO, 'agency'), memberRow(GONE, 'client', { active: false, removed_at: '2026-10-01T00:00:00Z' })],
    [profile(ME, 'Sam Okafor', 'sam'), profile(LEO, 'Leo Martins', 'leo'), profile(GONE, 'Ola Gone', 'ola')],
  );
}

async function mountHost(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<PersonCardHost />);
    await wait(10);
  });
}

/** A focused trigger in the page, like a PersonTrigger the person just tapped. */
function makeTrigger(): HTMLElement {
  const el = document.createElement('span');
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.textContent = 'trigger';
  document.body.appendChild(el);
  el.focus();
  return el;
}

async function open(userId: string, extra: Partial<PersonCardRequest> = {}): Promise<HTMLElement> {
  const trigger = makeTrigger();
  await act(async () => {
    openPersonCard({
      userId,
      anchor: { top: 100, left: 100, right: 140, bottom: 140 },
      trigger,
      ...extra,
    });
    await wait(30);
  });
  return trigger;
}

function card(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-person-card]');
}

function cardButtons(): HTMLButtonElement[] {
  const el = card();
  return el === null ? [] : [...el.querySelectorAll<HTMLButtonElement>('button')];
}

function metaLine(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-person-meta]');
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(10);
  });
}

beforeEach(() => {
  laptop.value = false;
  openDm.calls = [];
  defaultMembers();
});

afterEach(() => {
  act(() => closePersonCard());
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  resetMentionNames();
});

describe('PersonCardHost content', () => {
  it('another member: their name, "@user · Role" and a Message button', async () => {
    laptop.value = true;
    await mountHost();
    await open(LEO, { name: 'Leo' });
    expect(card()?.textContent).toContain('Leo Martins');
    expect(metaLine()?.textContent).toBe('@leo · Creator');
    const buttons = cardButtons();
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe(PERSON_CARD_COPY.message);
  });

  it('me: the button reads "Message yourself"', async () => {
    laptop.value = true;
    await mountHost();
    await open(ME);
    expect(cardButtons().map((b) => b.textContent)).toEqual([PERSON_CARD_COPY.self]);
    expect(metaLine()?.textContent).toBe('@sam · Owner');
  });

  it('a removed member: no button, the "No longer in this workspace" block', async () => {
    laptop.value = true;
    await mountHost();
    await open(GONE, { name: 'Ola Gone' });
    expect(cardButtons()).toHaveLength(0);
    expect(card()?.textContent).toContain(PERSON_CARD_COPY.removed);
  });

  it('the trigger said former: removed even when the cache is empty', async () => {
    holdMembers([], []);
    laptop.value = true;
    await mountHost();
    await open(LEO, { name: 'Leo Martins', former: true });
    expect(cardButtons()).toHaveLength(0);
    expect(card()?.textContent).toContain(PERSON_CARD_COPY.removed);
  });

  it('the meta line is reserved (h-5) and empty when username and role are not held', async () => {
    holdMembers([], []);
    laptop.value = true;
    await mountHost();
    await open(LEO, { name: 'Leo Martins' });
    const meta = metaLine();
    expect(meta).not.toBeNull();
    expect(meta?.textContent).toBe('');
    expect(meta?.className).toContain('h-5');
    // Still a Message button: unknown is not removed.
    expect(cardButtons().map((b) => b.textContent)).toEqual([PERSON_CARD_COPY.message]);
  });

  it('Message closes the card, then opens the DM for that person', async () => {
    laptop.value = true;
    await mountHost();
    await open(LEO);
    await act(async () => {
      cardButtons()[0]?.click();
      await wait(10);
    });
    expect(personCardSnapshot()).toBeNull();
    expect(openDm.calls).toEqual([LEO]);
    expect(card()).toBeNull();
  });
});

describe('PersonCardHost on phone', () => {
  it('renders a Sheet titled with the name, no hint, no name line in the body', async () => {
    laptop.value = false;
    await mountHost();
    await open(LEO);
    const sheet = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(sheet).not.toBeNull();
    expect(sheet?.querySelector('h2')?.textContent).toBe('Leo Martins');
    // The Sheet's X is there (a popover has none).
    expect(sheet?.querySelector('[aria-label="Close"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain(PERSON_CARD_COPY.hint);
    expect(card()?.querySelector('p.text-lg')).toBeNull();
  });

  it('Escape closes the Sheet', async () => {
    laptop.value = false;
    await mountHost();
    await open(LEO);
    await pressEscape();
    expect(personCardSnapshot()).toBeNull();
  });
});

describe('PersonCardHost on laptop', () => {
  it('renders a popover dialog beside the anchor with the hint and no Sheet X', async () => {
    laptop.value = true;
    await mountHost();
    await open(LEO);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-label')).toBe('Leo Martins');
    expect(dialog?.querySelector('[aria-label="Close"]')).toBeNull();
    expect(dialog?.textContent).toContain(PERSON_CARD_COPY.hint);
    expect(dialog?.style.width).toBe(`${PERSON_POPOVER_W}px`);
    // Right of the anchor (right 140 + 8 gap).
    expect(dialog?.style.left).toBe('148px');
    expect(dialog?.style.top).toBe('100px');
  });

  it('focus moves into the card (the button)', async () => {
    laptop.value = true;
    await mountHost();
    await open(LEO);
    expect(document.activeElement).toBe(cardButtons()[0]);
  });

  it('Escape closes and focus returns to the trigger', async () => {
    laptop.value = true;
    await mountHost();
    const trigger = await open(LEO);
    await pressEscape();
    expect(personCardSnapshot()).toBeNull();
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('a click outside closes and focus returns to the trigger', async () => {
    laptop.value = true;
    await mountHost();
    const trigger = await open(LEO);
    const outside = document.querySelector<HTMLElement>('div.fixed.inset-0[aria-hidden="true"]');
    expect(outside).not.toBeNull();
    await act(async () => {
      outside?.click();
      await wait(10);
    });
    expect(personCardSnapshot()).toBeNull();
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('a click inside the card does not close it', async () => {
    laptop.value = true;
    await mountHost();
    await open(LEO);
    await act(async () => {
      metaLine()?.click();
      await wait(10);
    });
    expect(personCardSnapshot()).not.toBeNull();
    expect(card()).not.toBeNull();
  });
});

describe('PersonCardBody', () => {
  const data: PersonCardData = {
    userId: LEO,
    name: 'Leo Martins',
    avatarUrl: null,
    username: 'leo',
    role: 'Creator',
    action: 'message',
  };

  async function render(node: ReactElement): Promise<void> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(node);
    });
  }

  it('shows the name and hint only when asked', async () => {
    await render(<PersonCardBody data={data} showName={false} showHint={false} onAction={() => {}} />);
    expect(card()?.querySelector('p.text-lg')).toBeNull();
    expect(card()?.textContent).not.toContain(PERSON_CARD_COPY.hint);
  });

  it('the button runs onAction', async () => {
    const onAction = vi.fn();
    await render(<PersonCardBody data={data} showName showHint onAction={onAction} />);
    expect(card()?.querySelector('p.text-lg')?.textContent).toBe('Leo Martins');
    expect(card()?.textContent).toContain(PERSON_CARD_COPY.hint);
    await act(async () => cardButtons()[0]?.click());
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

describe('personPopoverPosition', () => {
  const viewport = { width: 1024, height: 768 };

  it('sits right of the anchor when it fits', () => {
    expect(personPopoverPosition({ top: 100, left: 100, right: 140, bottom: 140 }, viewport)).toEqual({
      top: 100,
      left: 148,
    });
  });

  it('flips left of the anchor near the right edge', () => {
    expect(personPopoverPosition({ top: 100, left: 900, right: 940, bottom: 940 }, viewport)).toEqual({
      top: 100,
      left: 900 - 8 - PERSON_POPOVER_W,
    });
  });

  it('clamps to the left edge when neither side fits', () => {
    expect(personPopoverPosition({ top: 100, left: 100, right: 1000, bottom: 140 }, viewport).left).toBe(8);
  });

  it('clamps the top inside the viewport (bottom and top edges)', () => {
    expect(personPopoverPosition({ top: 740, left: 100, right: 140, bottom: 760 }, viewport).top).toBe(
      768 - 236 - 8,
    );
    expect(personPopoverPosition({ top: -40, left: 100, right: 140, bottom: 0 }, viewport).top).toBe(8);
  });

  it('centres when there is no anchor', () => {
    expect(personPopoverPosition(null, viewport)).toEqual({
      top: (768 - 236) / 2,
      left: (1024 - PERSON_POPOVER_W) / 2,
    });
  });
});

describe('personCardData', () => {
  function members(rows: WorkspaceMemberRow[], profiles: ChatProfile[]): Pick<WorkspaceMembersData, 'rows' | 'profiles'> {
    return { rows, profiles: new Map(profiles.map((p) => [p.userId, p])) };
  }

  it('prefers the members cache: name, username and role label', () => {
    const data = personCardData({
      request: { userId: LEO, name: 'Old name', username: 'old' },
      me: ME,
      workspaceId: WS,
      members: members([memberRow(LEO, 'agency')], [profile(LEO, 'Leo Martins', 'leo')]),
    });
    expect(data).toMatchObject({
      userId: LEO,
      name: 'Leo Martins',
      username: 'leo',
      role: 'Creator',
      action: 'message',
    });
  });

  it('falls back to the trigger hint when nothing is held', () => {
    const data = personCardData({
      request: { userId: LEO, name: 'Leo M', avatarUrl: 'https://x.test/a.png', username: 'leom' },
      me: ME,
      workspaceId: WS,
      members: null,
    });
    expect(data).toMatchObject({
      name: 'Leo M',
      avatarUrl: 'https://x.test/a.png',
      username: 'leom',
      role: null,
      action: 'message',
    });
  });

  it('a blank username is not held', () => {
    const data = personCardData({
      request: { userId: LEO, name: 'Leo', username: '' },
      me: ME,
      workspaceId: WS,
      members: null,
    });
    expect(data.username).toBeNull();
  });

  it('falls back to the mention registry name when the hint has none', () => {
    rememberMentionNames(WS, [{ userId: LEO, displayName: 'Leo Martins', username: 'leo' }]);
    const data = personCardData({ request: { userId: LEO }, me: ME, workspaceId: WS, members: null });
    expect(data.name).toBe('Leo Martins');
    expect(data.action).toBe('message');
  });

  it('removed when the trigger says former', () => {
    const data = personCardData({
      request: { userId: LEO, name: 'Leo', former: true },
      me: ME,
      workspaceId: WS,
      members: null,
    });
    expect(data.action).toBe('removed');
  });

  it('removed when the held list lacks a current row for them', () => {
    const data = personCardData({
      request: { userId: GONE, name: 'Ola' },
      me: ME,
      workspaceId: WS,
      members: members(
        [memberRow(LEO, 'agency'), memberRow(GONE, 'client', { removed_at: '2026-10-01T00:00:00Z' })],
        [],
      ),
    });
    expect(data.action).toBe('removed');
    expect(data.role).toBeNull();
  });

  it('removed when no list is held and the registry marked them former; no "Former member" name', () => {
    rememberMentionProfiles(WS, [{ userId: GONE, displayName: 'Ola Gone', member: false }]);
    const data = personCardData({ request: { userId: GONE }, me: ME, workspaceId: WS, members: null });
    expect(data.action).toBe('removed');
    expect(data.name).toBe('');
  });

  it('an empty held list does not mark anyone removed', () => {
    const data = personCardData({
      request: { userId: LEO, name: 'Leo' },
      me: ME,
      workspaceId: WS,
      members: members([], []),
    });
    expect(data.action).toBe('message');
  });

  it('me is self', () => {
    const data = personCardData({
      request: { userId: ME },
      me: ME,
      workspaceId: WS,
      members: members([memberRow(ME, 'owner')], [profile(ME, 'Sam Okafor', 'sam')]),
    });
    expect(data.action).toBe('self');
    expect(data.role).toBe('Owner');
  });
});

describe('personMetaLine', () => {
  it('joins username and role, either alone, or empty', () => {
    expect(personMetaLine({ username: 'leo', role: 'Creator' })).toBe('@leo · Creator');
    expect(personMetaLine({ username: 'leo', role: null })).toBe('@leo');
    expect(personMetaLine({ username: null, role: 'Approver' })).toBe('Approver');
    expect(personMetaLine({ username: null, role: null })).toBe('');
  });
});
