// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { signInWithOtp } = vi.hoisted(() => ({ signInWithOtp: vi.fn() }));

vi.mock('@/lib/supabase', () => ({ supabase: { auth: { signInWithOtp } } }));

import { CHECK_EMAIL_COPY } from '@/lib/induction-copy';
import {
  POLICY_CONSENT_MESSAGE,
  RATE_LIMIT_MESSAGE,
  RESEND_COOLDOWN_SECONDS,
  SignUpPage,
  linkErrorMessage,
  performSignUp,
  testSignUpMessage,
  type SignUpAuthClient,
} from './SignUpPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function authClient(): SignUpAuthClient {
  return { auth: { signInWithOtp } };
}

describe('performSignUp', () => {
  beforeEach(() => {
    signInWithOtp.mockReset();
    signInWithOtp.mockResolvedValue({ error: null });
  });

  it('emails a sign-in link that creates the account, with the timezone, and no password', async () => {
    const result = await performSignUp(authClient(), {
      email: '  dana@kite.in ',
      timezone: 'Asia/Kolkata',
      policyConsent: true,
    });
    expect(result).toEqual({ status: 'sent' });
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: 'dana@kite.in',
      options: {
        shouldCreateUser: true,
        data: { timezone: 'Asia/Kolkata' },
        emailRedirectTo: window.location.origin,
      },
    });
    expect(JSON.stringify(signInWithOtp.mock.calls[0])).not.toContain('password');
  });

  it('asks for nothing without policy consent', async () => {
    const result = await performSignUp(authClient(), {
      email: 'dana@kite.in',
      timezone: 'UTC',
      policyConsent: false,
    });
    expect(result).toEqual({ status: 'error', message: POLICY_CONSENT_MESSAGE });
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it.each([429, 403])('maps a %s rate limit to a plain message', async (status) => {
    signInWithOtp.mockResolvedValue({ error: { message: 'email rate limit exceeded', status } });
    const result = await performSignUp(authClient(), {
      email: 'dana@kite.in',
      timezone: 'UTC',
      policyConsent: true,
    });
    expect(result).toEqual({ status: 'error', message: RATE_LIMIT_MESSAGE });
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
  });

  it('uses the rate limit line from the copy file', () => {
    expect(RATE_LIMIT_MESSAGE).toBe(CHECK_EMAIL_COPY.rateLimited);
  });

  // W11 fix 5: never the raw provider text.
  it('maps any other provider refusal to plain copy', async () => {
    signInWithOtp.mockResolvedValue({ error: { message: 'Invalid email', status: 400 } });
    const result = await performSignUp(authClient(), {
      email: 'x',
      timezone: 'UTC',
      policyConsent: true,
    });
    expect(result).toEqual({ status: 'error', message: "Couldn't send the link. Try again." });
  });

  it('words the rate limit as Too many tries', () => {
    expect(linkErrorMessage({ message: 'email rate limit exceeded', status: 429 })).toBe(
      'Too many tries. Wait a minute and try again.',
    );
  });
});

describe('SignUpPage', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    signInWithOtp.mockReset();
    signInWithOtp.mockResolvedValue({ error: null });
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    vi.useRealTimers();
  });

  async function render(): Promise<void> {
    root = createRoot(host!);
    await act(async () => {
      root!.render(
        <MemoryRouter
          initialEntries={['/signup?email=dana@kite.in']}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <SignUpPage />
        </MemoryRouter>,
      );
    });
  }

  function button(text: string): HTMLButtonElement {
    const found = [...document.querySelectorAll('button')].find((b) => b.textContent === text);
    if (found === undefined) throw new Error(`no button ${text}`);
    return found;
  }

  async function click(el: HTMLElement): Promise<void> {
    await act(async () => el.click());
  }

  async function submit(): Promise<void> {
    await click(document.querySelector<HTMLInputElement>('#signup-policy-consent')!);
    await click(button(CHECK_EMAIL_COPY.createAccount));
  }

  async function tick(seconds: number): Promise<void> {
    for (let i = 0; i < seconds; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
  }

  it('renders no password field, and the short subtitle', async () => {
    await render();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.body.textContent).toContain("We'll email you a sign-in link. No password.");
  });

  // W11 fix 5: Create is never disabled for the consent box.
  it('keeps Create enabled unticked, and says why on tap', async () => {
    await render();
    const create = button(CHECK_EMAIL_COPY.createAccount);
    expect(create.disabled).toBe(false);
    await click(create);
    expect(signInWithOtp).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(POLICY_CONSENT_MESSAGE);
  });

  // W11 fix 5: the email format is checked when the field loses focus.
  it('flags a malformed email on blur, inline', async () => {
    await render();
    const input = document.querySelector<HTMLInputElement>('#signup-email')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, 'dana@kite');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.focus();
      input.blur();
    });
    expect(document.body.textContent).toContain('Enter a valid email, like name@company.com');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('shows Check your email with the address after sending', async () => {
    await render();
    await submit();
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Check your email');
    expect(document.body.textContent).toContain(
      'We sent a link to dana@kite.in. Open it on this device to finish signing up.',
    );
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('holds Resend link for 60 seconds, then sends once per tap', async () => {
    await render();
    await submit();
    const resend = (): HTMLButtonElement =>
      [...document.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').startsWith('Resend link'),
      )!;
    expect(resend().disabled).toBe(true);
    expect(resend().textContent).toBe(`Resend link (${RESEND_COOLDOWN_SECONDS}s)`);
    await tick(1);
    expect(resend().textContent).toBe('Resend link (59s)');
    await tick(RESEND_COOLDOWN_SECONDS - 1);
    expect(resend().disabled).toBe(false);
    expect(resend().textContent).toBe('Resend link');
    // No auto-resend while waiting.
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
    await click(resend());
    expect(signInWithOtp).toHaveBeenCalledTimes(2);
    expect(resend().disabled).toBe(true);
    await click(resend());
    expect(signInWithOtp).toHaveBeenCalledTimes(2);
  });

  it('clears the countdown timer on unmount', async () => {
    await render();
    await submit();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    act(() => root?.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows a plain line on a rate limit, with no retry', async () => {
    await render();
    await submit();
    await tick(RESEND_COOLDOWN_SECONDS);
    signInWithOtp.mockResolvedValue({ error: { message: 'too many', status: 429 } });
    await click(button('Resend link'));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(RATE_LIMIT_MESSAGE);
    await tick(5);
    expect(signInWithOtp).toHaveBeenCalledTimes(2);
  });

  it('agree row: checkbox and label text share one 44px flex row', async () => {
    await render();
    const checkbox = document.querySelector<HTMLInputElement>('#signup-policy-consent')!;
    const label = checkbox.closest('label')!;
    expect(label).not.toBeNull();
    expect(label.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['flex', 'items-center', 'gap-3', 'min-h-11']),
    );
    expect(checkbox.parentElement).toBe(label);
    expect(label.textContent).toContain('I agree to the');
    expect(checkbox.className.split(/\s+/)).toContain('m-0');
  });

  it('Use a different email goes back to the form with the email kept and editable', async () => {
    await render();
    await submit();
    await click(button('Use a different email'));
    const input = document.querySelector<HTMLInputElement>('#signup-email')!;
    expect(input.value).toBe('dana@kite.in');
    expect(input.readOnly).toBe(false);
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });
});

describe('testSignUpMessage', () => {
  it('words the test site refusals', () => {
    expect(testSignUpMessage('account_exists')).toBe(
      'That email already has a real account. Use another email to test.',
    );
    expect(testSignUpMessage('invalid_email')).toBe('Enter a valid email address.');
    expect(testSignUpMessage('rate_limited')).toBe(
      'Too many test accounts this hour. Try again later.',
    );
    expect(testSignUpMessage('boom')).toBe("Couldn't start that. Try again.");
  });
});
