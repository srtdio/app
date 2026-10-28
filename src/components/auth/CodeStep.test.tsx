// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyOtp } = vi.hoisted(() => ({ verifyOtp: vi.fn() }));

vi.mock('@/lib/supabase', () => ({ supabase: { auth: { verifyOtp } } }));

import { CODE_EXPIRY_MS, CodeStep, codeDigits, codeErrorKind, cooldownClock } from './CodeStep';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('code helpers', () => {
  it('keeps digits only, at most 6', () => {
    expect(codeDigits('123 456')).toBe('123456');
    expect(codeDigits('12-34-56-78')).toBe('123456');
    expect(codeDigits('ab')).toBe('');
  });

  it('formats the cooldown as m:ss', () => {
    expect(cooldownClock(60)).toBe('1:00');
    expect(cooldownClock(28)).toBe('0:28');
    expect(cooldownClock(0)).toBe('0:00');
  });

  it('maps errors by code, never by provider text', () => {
    const now = 10_000_000;
    expect(codeErrorKind({ code: 'otp_expired' }, now - 1000, now)).toBe('wrong');
    expect(codeErrorKind({ code: 'otp_expired' }, now - CODE_EXPIRY_MS, now)).toBe('expired');
    expect(codeErrorKind({ code: 'over_request_rate_limit', status: 429 }, now, now)).toBe(
      'rate-limited',
    );
    expect(codeErrorKind({ code: 'validation_failed' }, now, now)).toBe('wrong');
  });
});

describe('CodeStep', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  const onResend = vi.fn<() => Promise<string | null>>();
  const onDifferentEmail = vi.fn();
  const onSignedIn = vi.fn();

  beforeEach(() => {
    verifyOtp.mockReset();
    verifyOtp.mockResolvedValue({ error: null });
    onResend.mockReset();
    onResend.mockResolvedValue(null);
    onDifferentEmail.mockReset();
    onSignedIn.mockReset();
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
        <CodeStep
          email="dana@kite.in"
          onResend={onResend}
          onDifferentEmail={onDifferentEmail}
          onSignedIn={onSignedIn}
        />,
      );
    });
  }

  function input(): HTMLInputElement {
    return document.querySelector<HTMLInputElement>('#auth-code')!;
  }

  function boxes(): string[] {
    return [...document.querySelectorAll('[data-code-box]')].map((b) => b.textContent ?? '');
  }

  async function type(value: string): Promise<void> {
    const el = input();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function button(text: string): HTMLButtonElement {
    const found = [...document.querySelectorAll('button')].find((b) => b.textContent === text);
    if (found === undefined) throw new Error(`no button ${text}`);
    return found;
  }

  // Guard: iOS shows the code from Mail above the keyboard only for this attribute.
  it('is ONE real input with autocomplete=one-time-code, numeric, focused', async () => {
    await render();
    expect(document.querySelectorAll('input')).toHaveLength(1);
    const el = input();
    expect(el.getAttribute('autocomplete')).toBe('one-time-code');
    expect(el.getAttribute('inputmode')).toBe('numeric');
    expect(el.getAttribute('pattern')).toBe('[0-9]*');
    expect(el.maxLength).toBe(6);
    expect(document.activeElement).toBe(el);
    expect(boxes()).toHaveLength(6);
  });

  it('the source never drops autocomplete="one-time-code"', () => {
    const src = readFileSync(fileURLToPath(new URL('./CodeStep.tsx', import.meta.url)), 'utf8');
    expect(src).toContain('autoComplete="one-time-code"');
  });

  it('fills the boxes digit by digit without submitting early', async () => {
    await render();
    await type('12');
    expect(boxes()).toEqual(['1', '2', '', '', '', '']);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('a pasted full code fills all 6 and submits once', async () => {
    await render();
    await type('123 456');
    expect(boxes()).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(verifyOtp).toHaveBeenCalledTimes(1);
    expect(verifyOtp).toHaveBeenCalledWith({
      email: 'dana@kite.in',
      token: '123456',
      type: 'email',
    });
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it('the 6th digit calls verifyOtp exactly once', async () => {
    let resolve: (v: { error: null }) => void = () => undefined;
    verifyOtp.mockReturnValue(new Promise((r) => (resolve = r)));
    await render();
    await type('12345');
    expect(verifyOtp).not.toHaveBeenCalled();
    await type('123456');
    await type('123456');
    expect(verifyOtp).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ error: null }));
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it('a wrong code clears the boxes, keeps focus and says so under them', async () => {
    verifyOtp.mockResolvedValue({
      error: { message: 'Token has expired or is invalid', code: 'otp_expired', status: 403 },
    });
    await render();
    await type('000000');
    expect(boxes()).toEqual(['', '', '', '', '', '']);
    expect(input().value).toBe('');
    expect(document.activeElement).toBe(input());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "That code didn't work. Try again.",
    );
    expect(document.body.textContent).not.toContain('Token has expired or is invalid');
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('an expired code shows the error with a Resend code action', async () => {
    vi.useFakeTimers();
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CODE_EXPIRY_MS);
    });
    verifyOtp.mockResolvedValue({
      error: { message: 'Token has expired or is invalid', code: 'otp_expired', status: 403 },
    });
    await type('111111');
    const alert = document.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe('That code has expired.Resend code');
    const action = [...alert.querySelectorAll('button')].find(
      (b) => b.textContent === 'Resend code',
    )!;
    await act(async () => action.click());
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('counts the resend down as m:ss from the existing cooldown', async () => {
    vi.useFakeTimers();
    await render();
    const resend = (): HTMLButtonElement =>
      [...document.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').startsWith('Resend'),
      )!;
    expect(resend().textContent).toBe('Resend in 1:00');
    expect(resend().disabled).toBe(true);
    for (let i = 0; i < 32; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    expect(resend().textContent).toBe('Resend in 0:28');
  });

  it('a failed resend shows the line it is given', async () => {
    vi.useFakeTimers();
    onResend.mockResolvedValue("Couldn't send the code. Try again.");
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await act(async () => button('Resend code').click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't send the code. Try again.",
    );
  });

  it('Use a different email goes back', async () => {
    await render();
    await act(async () => button('Use a different email').click());
    expect(onDifferentEmail).toHaveBeenCalledTimes(1);
  });
});
