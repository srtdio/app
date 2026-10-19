// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// W12: honest sent status (NEW9), plain errors (FT63), no default role (T86).
const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: mockInvoke } } }));
vi.mock('@/lib/workspace-context', () => ({ useWorkspace: () => ({ workspaceId: 'ws-1' }) }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 't-1' }));

import {
  INVITE_ERROR_MESSAGE,
  INVITE_NOT_SENT_MESSAGE,
  INVITE_PICK_ROLE_MESSAGE,
  InviteNotSent,
  MembersInviteForm,
  inviteStatus,
  readInviteOutcome,
  sendInvite,
} from './MembersInviteForm';

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

async function submitSingle(): Promise<void> {
  const form = document.querySelector<HTMLInputElement>('#invite-email')!.closest('form')!;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('W12 invite sent status', () => {
  it('shows the not-sent message and Copy link for emailed:false', async () => {
    mockInvoke.mockResolvedValue({
      data: {
        emailed: false,
        error_detail: 'resend_not_configured',
        accept_url: 'https://app.test/invite/accept/inv-1',
      },
      error: null,
    });
    mount(<MembersInviteForm clientOnly />);
    typeEmail('person@brand.com');
    await submitSingle();
    const text = document.body.textContent ?? '';
    expect(text).toContain(INVITE_NOT_SENT_MESSAGE);
    expect(text).not.toContain('Invitation sent to');
    const copy = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Copy link',
    );
    expect(copy).toBeDefined();
  });

  it('says "Invitation sent to {email}." only for emailed:true', async () => {
    mockInvoke.mockResolvedValue({
      data: { emailed: true, error_detail: null, accept_url: 'https://app.test/x' },
      error: null,
    });
    mount(<MembersInviteForm clientOnly />);
    typeEmail('person@brand.com');
    await submitSingle();
    expect(document.body.textContent).toContain('Invitation sent to person@brand.com.');
    expect(document.body.textContent).not.toContain(INVITE_NOT_SENT_MESSAGE);
  });

  it('copies the accept_url from the not-sent notice', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mount(<InviteNotSent email="a@b.com" acceptUrl="https://app.test/invite/accept/inv-9" />);
    const copy = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Copy link',
    )!;
    await act(async () => {
      copy.click();
    });
    expect(writeText).toHaveBeenCalledWith('https://app.test/invite/accept/inv-9');
    expect(document.body.textContent).toContain('Link copied');
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
    expect(readInviteOutcome(null)).toEqual({ emailed: false, errorDetail: null, acceptUrl: null });
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
        onSuccess: vi.fn(),
        onError: vi.fn(),
      });
      expect(result).toEqual({ ok: false, message: INVITE_ERROR_MESSAGE, code: null });
      expect(INVITE_ERROR_MESSAGE).toBe("Couldn't send the invite. Try again.");
      if (!result.ok) {
        expect(result.message).not.toContain('tr-9');
        expect(result.message).not.toContain(code);
      }
      // The trace id goes to the logs.
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('tr-9');
      warn.mockRestore();
    },
  );
});

describe('W12 role has no default (T86)', () => {
  it('renders no preselected role', () => {
    const html = renderToStaticMarkup(<MembersInviteForm />);
    expect(html).toContain('Choose a role');
  });

  it('tapping Send without a role shows "Pick a role" and sends nothing', async () => {
    mount(<MembersInviteForm />);
    typeEmail('person@brand.com');
    await submitSingle();
    expect(document.body.textContent).toContain(INVITE_PICK_ROLE_MESSAGE);
    expect(INVITE_PICK_ROLE_MESSAGE).toBe('Pick a role');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("the tour's approver-invite step names the role, so Send goes out as Approver", async () => {
    const guide = document.createElement('div');
    guide.setAttribute('data-induction-step', 'c_approver_invite');
    document.body.appendChild(guide);
    mockInvoke.mockResolvedValue({ data: { emailed: true }, error: null });
    mount(<MembersInviteForm />);
    typeEmail('riya@kitebrand.in');
    await submitSingle();
    expect(document.body.textContent).not.toContain(INVITE_PICK_ROLE_MESSAGE);
    expect(mockInvoke).toHaveBeenCalledWith(
      'invite-send',
      expect.objectContaining({ body: expect.objectContaining({ role: 'client' }) }),
    );
  });
});
