// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// W12: honest sent status (NEW9), plain errors (FT63), no default role (T86),
// and the one-box invite list (rows, Set all as, inline fix, typo nudge).
const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: mockInvoke } } }));
vi.mock('@/lib/workspace-context', () => ({ useWorkspace: () => ({ workspaceId: 'ws-1' }) }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 't-1' }));

import {
  INVITE_DUPLICATE_MESSAGE,
  INVITE_ERROR_MESSAGE,
  INVITE_INVALID_EMAIL_MESSAGE,
  INVITE_NOT_SENT_MESSAGE,
  INVITE_PICK_ROLE_MESSAGE,
  InviteNotSent,
  MembersInviteForm,
  inviteStatus,
  readInviteOutcome,
  sendInvite,
} from './MembersInviteForm';
import { ToastProvider, ToastViewport } from '@/components/ui/toast';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  mockInvoke.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function mount(element: ReactElement): void {
  root = createRoot(host!);
  act(() => root!.render(element));
}

function typeEmail(value: string): void {
  const input = document.querySelector<HTMLInputElement>('#invite-email')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function input(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('#invite-email')!;
}

function key(target: HTMLElement, value: string): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
    );
  });
}

function paste(text: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
  act(() => {
    input().dispatchEvent(event);
  });
}

function rowEmails(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>('ul[aria-label="People to invite"] input'),
  ).map((el) => el.value);
}

function setValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// The DOM lib's HTMLSelectElement does not satisfy querySelector's Element
// constraint here (remove() overloads), so selects are read structurally.
type SelectLike = Element & { value: string };

function selectNamed(label: string): SelectLike {
  const found = document.querySelector(`select[aria-label="${label}"]`);
  if (found === null) throw new Error(`no ${label} select`);
  return found as SelectLike;
}

function pick(select: SelectLike, value: string): void {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function buttonNamed(name: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent === name);
}

async function submitSingle(): Promise<void> {
  const form = document.querySelector<HTMLInputElement>('#invite-email')!.closest('form')!;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('W12 invite sent status', () => {
  it('shows the not-sent message and Copy link for emailed:false, with no sent toast', async () => {
    mockInvoke.mockResolvedValue({
      data: {
        emailed: false,
        error_detail: 'resend_not_configured',
        accept_url: 'https://app.test/invite/accept/inv-1',
        invite_id: 'inv-1',
      },
      error: null,
    });
    const onInvited = vi.fn();
    mount(<MembersInviteForm clientOnly onInvited={onInvited} />);
    typeEmail('person@brand.com');
    await submitSingle();
    expect(document.body.textContent).toContain(INVITE_NOT_SENT_MESSAGE);
    expect(buttonNamed('Copy link')).toBeDefined();
    expect(onInvited).toHaveBeenCalledWith([
      { email: 'person@brand.com', role: 'client', inviteId: 'inv-1', status: 'not-sent' },
    ]);
  });

  it('hands the sent address to the panel and clears the list for emailed:true', async () => {
    mockInvoke.mockResolvedValue({
      data: {
        emailed: true,
        error_detail: null,
        accept_url: 'https://app.test/x',
        invite_id: 'inv-2',
      },
      error: null,
    });
    const onInvited = vi.fn();
    mount(<MembersInviteForm clientOnly onInvited={onInvited} />);
    typeEmail('person@brand.com');
    await submitSingle();
    expect(onInvited).toHaveBeenCalledWith([
      { email: 'person@brand.com', role: 'client', inviteId: 'inv-2', status: 'sent' },
    ]);
    expect(document.body.textContent).not.toContain(INVITE_NOT_SENT_MESSAGE);
    expect(rowEmails()).toEqual([]);
    expect(input().value).toBe('');
  });

  it('copies the accept_url from the not-sent notice', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mount(
      <ToastProvider>
        <InviteNotSent email="a@b.com" acceptUrl="https://app.test/invite/accept/inv-9" />
        <ToastViewport />
      </ToastProvider>,
    );
    await act(async () => {
      buttonNamed('Copy link')!.click();
    });
    expect(writeText).toHaveBeenCalledWith('https://app.test/invite/accept/inv-9');
    // The shared toast confirms it; the notice carries no inline label.
    const toastText = document.querySelector('[role="status"][aria-live="polite"]')?.textContent;
    expect(toastText).toContain('Link copied');
  });

  it('reads the outcome and classifies it', () => {
    expect(inviteStatus(readInviteOutcome({ emailed: true }))).toBe('sent');
    expect(
      inviteStatus(readInviteOutcome({ emailed: false, error_detail: 'resend_not_configured' })),
    ).toBe('not-sent');
    expect(
      inviteStatus(readInviteOutcome({ emailed: false, error_detail: 'resend send failed (500)' })),
    ).toBe('not-sent');
    expect(
      inviteStatus(readInviteOutcome({ emailed: false, error_detail: 'test_address_not_emailed' })),
    ).toBe('test');
    expect(readInviteOutcome(null)).toEqual({
      emailed: false,
      errorDetail: null,
      acceptUrl: null,
      inviteId: null,
    });
  });
});

describe('W12 plain invite errors (FT63)', () => {
  it.each(['provisioning_failed', 'membership_lookup_failed', 'delivery_record_failed', 'boom'])(
    '%s reads as the plain line with no code or trace id',
    async (code) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await sendInvite({
        workspaceId: 'ws-1',
        email: 'person@brand.com',
        role: 'agency',
        traceId: 't-1',
        invoke: vi.fn().mockResolvedValue({
          error: {
            context: {
              json: async () => ({ error: code, error_detail: 'raw db text', trace_id: 'tr-9' }),
            },
          },
        }),
      });
      expect(result).toEqual({ ok: false, code: null });
      expect(INVITE_ERROR_MESSAGE).toBe("Couldn't send the invite. Try again.");
      // The trace id goes to the logs.
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('tr-9');
      warn.mockRestore();
    },
  );
});

describe('W12 role has no default (T86)', () => {
  it('renders no preselected role once an address is a row', () => {
    mount(<MembersInviteForm />);
    typeEmail('person@brand.com');
    key(input(), 'Enter');
    expect(document.body.textContent).toContain('Choose a role');
  });

  it('tapping Send without a role highlights the picker, says so, and sends nothing', async () => {
    mount(<MembersInviteForm />);
    typeEmail('person@brand.com');
    await submitSingle();
    expect(document.body.textContent).toContain(INVITE_PICK_ROLE_MESSAGE);
    expect(INVITE_PICK_ROLE_MESSAGE).toBe('Pick a role for each person');
    expect(document.querySelector('select[aria-invalid="true"]')).not.toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("the tour's approver-invite step names the role, so Send goes out as Approver", async () => {
    const guide = document.createElement('div');
    guide.setAttribute('data-induction-step', 'c_approver_invite');
    document.body.appendChild(guide);
    mockInvoke.mockResolvedValue({ data: { emailed: true }, error: null });
    mount(<MembersInviteForm />);
    typeEmail('riya@kitebrand.in');
    expect(buttonNamed('Send invite')).toBeDefined();
    await submitSingle();
    expect(document.body.textContent).not.toContain(INVITE_PICK_ROLE_MESSAGE);
    expect(mockInvoke).toHaveBeenCalledWith(
      'invite-send',
      expect.objectContaining({ body: expect.objectContaining({ role: 'client' }) }),
    );
  });
});

describe('one entry box', () => {
  it('Enter, comma and space each turn the typed address into a row', () => {
    mount(<MembersInviteForm />);
    typeEmail('a@brand.com');
    key(input(), 'Enter');
    typeEmail('b@brand.com');
    key(input(), ',');
    typeEmail('c@brand.com');
    key(input(), ' ');
    expect(rowEmails()).toEqual(['a@brand.com', 'b@brand.com', 'c@brand.com']);
    expect(input().value).toBe('');
    expect(buttonNamed('Send 3 invites')).toBeDefined();
  });

  it('a pasted list becomes rows at once', () => {
    mount(<MembersInviteForm />);
    paste('a@brand.com, b@brand.com\nc@brand.com d@brand.com');
    expect(rowEmails()).toEqual(['a@brand.com', 'b@brand.com', 'c@brand.com', 'd@brand.com']);
  });

  it('Backspace in an empty box removes the last unsent row', () => {
    mount(<MembersInviteForm />);
    paste('a@brand.com b@brand.com');
    key(input(), 'Backspace');
    expect(rowEmails()).toEqual(['a@brand.com']);
  });

  it('says so when an address is already on the list or already invited', () => {
    mount(<MembersInviteForm invitedEmails={['old@brand.com']} />);
    typeEmail('a@brand.com');
    key(input(), 'Enter');
    typeEmail('A@brand.com');
    key(input(), 'Enter');
    expect(rowEmails()).toEqual(['a@brand.com']);
    expect(document.body.textContent).toContain(INVITE_DUPLICATE_MESSAGE);
    typeEmail('old@brand.com');
    key(input(), 'Enter');
    expect(rowEmails()).toEqual(['a@brand.com']);
    expect(document.body.textContent).toContain('That person is already on the list.');
  });

  it('an invalid address stays as a row with "Check this email" and is fixed in place', () => {
    mount(<MembersInviteForm />);
    typeEmail('a@brand');
    key(input(), 'Enter');
    expect(document.body.textContent).toContain(INVITE_INVALID_EMAIL_MESSAGE);
    expect(INVITE_INVALID_EMAIL_MESSAGE).toBe('Check this email');
    const row = document.querySelector<HTMLInputElement>(
      'ul[aria-label="People to invite"] input',
    )!;
    setValue(row, 'a@brand.com');
    expect(rowEmails()).toEqual(['a@brand.com']);
    expect(document.body.textContent).not.toContain(INVITE_INVALID_EMAIL_MESSAGE);
  });

  it('Set all as fills every row, and one row can still change after', () => {
    mount(<MembersInviteForm />);
    paste('a@brand.com b@brand.com c@brand.com');
    pick(selectNamed('Set all as'), 'client');
    const roleOf = (email: string) => selectNamed(`Role for ${email}`);
    expect(['a', 'b', 'c'].map((n) => roleOf(`${n}@brand.com`).value)).toEqual([
      'client',
      'client',
      'client',
    ]);
    pick(roleOf('b@brand.com'), 'agency');
    expect(['a', 'b', 'c'].map((n) => roleOf(`${n}@brand.com`).value)).toEqual([
      'client',
      'agency',
      'client',
    ]);
  });

  it('a typo shows "Did you mean" under the row and a tap applies it', () => {
    mount(<MembersInviteForm />);
    typeEmail('riya@gmial.com');
    key(input(), 'Enter');
    const nudge = buttonNamed('Did you mean gmail.com?');
    expect(nudge).toBeDefined();
    act(() => nudge!.click());
    expect(rowEmails()).toEqual(['riya@gmail.com']);
    expect(buttonNamed('Did you mean gmail.com?')).toBeUndefined();
  });

  it('a typo in the entry box gets the nudge too', () => {
    mount(<MembersInviteForm />);
    typeEmail('riya@gmial.com');
    act(() => buttonNamed('Did you mean gmail.com?')!.click());
    expect(input().value).toBe('riya@gmail.com');
  });

  it('sends each row separately; refused rows stay with their line, sent rows leave', async () => {
    mockInvoke.mockImplementation(async (_name: string, options: { body: { email: string } }) =>
      options.body.email === 'temp@mailinator.com'
        ? { error: { context: { json: async () => ({ error: 'disposable_email' }) } } }
        : options.body.email === 'x@other.com'
          ? { error: { context: { json: async () => ({ error: 'client_domain_mismatch' }) } } }
          : { data: { emailed: true, invite_id: 'inv-1' }, error: null },
    );
    const onInvited = vi.fn();
    const loadClientDomain = vi.fn(async () => 'brand.com');
    mount(
      <MembersInviteForm clientOnly onInvited={onInvited} loadClientDomain={loadClientDomain} />,
    );
    paste('ok@brand.com temp@mailinator.com x@other.com');
    await submitSingle();
    expect(mockInvoke).toHaveBeenCalledTimes(3);
    expect(rowEmails()).toEqual(['temp@mailinator.com', 'x@other.com']);
    const text = document.body.textContent ?? '';
    expect(text).toContain("Temporary emails can't be invited. Use a permanent one.");
    expect(text).toContain('Use a brand.com email, or a personal one like Gmail.');
    expect(loadClientDomain).toHaveBeenCalledTimes(1);
    expect(onInvited).toHaveBeenCalledWith([
      { email: 'ok@brand.com', role: 'client', inviteId: 'inv-1', status: 'sent' },
    ]);
    expect(buttonNamed('Send 2 invites')).toBeDefined();
  });
});
