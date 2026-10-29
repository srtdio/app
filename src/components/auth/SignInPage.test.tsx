// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { signInWithOtp, verifyOtp } = vi.hoisted(() => ({
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ supabase: { auth: { signInWithOtp, verifyOtp } } }));

import { SignInPage, signInErrorMessage } from './SignInPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('signInErrorMessage (W11 fix 6)', () => {
  it('maps a rate limit to Too many tries', () => {
    expect(signInErrorMessage({ message: 'email rate limit exceeded', httpStatus: 429 })).toBe(
      'Too many tries. Wait a minute and try again.',
    );
  });

  it('never shows the raw provider text', () => {
    expect(signInErrorMessage({ message: 'AuthApiError: boom', httpStatus: 500 })).toBe(
      "Couldn't send the code. Try again.",
    );
  });
});

describe('SignInPage (W11 fix 6)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    signInWithOtp.mockReset();
    signInWithOtp.mockResolvedValue({ error: null });
    verifyOtp.mockReset();
    verifyOtp.mockResolvedValue({ error: null });
    window.localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
  });

  async function render(entry = '/signin'): Promise<void> {
    root = createRoot(host!);
    await act(async () => {
      root!.render(
        <MemoryRouter
          initialEntries={[entry]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <Routes>
            <Route path="/signin" element={<SignInPage />} />
            <Route path="*" element={<p data-landed="">landed</p>} />
          </Routes>
        </MemoryRouter>,
      );
    });
  }

  function emailInput(): HTMLInputElement {
    return document.querySelector<HTMLInputElement>('#signin-email')!;
  }

  async function typeEmail(value: string): Promise<void> {
    const input = emailInput();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function button(text: string): HTMLButtonElement {
    const found = [...document.querySelectorAll('button')].find((b) => b.textContent === text);
    if (found === undefined) throw new Error(`no button ${text}`);
    return found;
  }

  it('flags a typo on blur and sends nothing', async () => {
    await render();
    await typeEmail('dana@kite');
    await act(async () => {
      emailInput().focus();
      emailInput().blur();
    });
    expect(document.body.textContent).toContain('Enter a valid email, like name@company.com');
    await act(async () => button('Send code').click());
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it('shows plain copy for a rate limit', async () => {
    signInWithOtp.mockResolvedValue({ error: { message: 'too many', status: 429 } });
    await render();
    await typeEmail('dana@kite.in');
    await act(async () => button('Send code').click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Too many tries. Wait a minute and try again.',
    );
  });

  it('shows the code copy on the form', async () => {
    await render();
    expect(document.body.textContent).toContain('We email you a code. No password.');
    expect(button('Send code')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/sign-in link/i);
  });

  it('Send code swaps the same card to the code step, no reload', async () => {
    await render();
    const card = host!.firstElementChild;
    await typeEmail('dana@kite.in');
    await act(async () => button('Send code').click());
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
    expect(host!.firstElementChild).toBe(card);
    expect(document.body.textContent).toContain('Enter the code');
    expect(document.body.textContent).toContain('Sent to dana@kite.in');
    const code = document.querySelector<HTMLInputElement>('#auth-code')!;
    expect(code.getAttribute('autocomplete')).toBe('one-time-code');
    expect(document.activeElement).toBe(code);
    expect(document.body.textContent).not.toContain('Check your email');
  });

  it('the code step offers Use a different email, back to the form with the email kept', async () => {
    await render();
    await typeEmail('dana@kite.in');
    await act(async () => button('Send code').click());
    await act(async () => button('Use a different email').click());
    expect(emailInput().value).toBe('dana@kite.in');
  });

  it('a right code lands on ?next=, as the link callback did', async () => {
    await render('/signin?next=/briefs');
    await typeEmail('dana@kite.in');
    await act(async () => button('Send code').click());
    const code = document.querySelector<HTMLInputElement>('#auth-code')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(code, '123456');
      code.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(verifyOtp).toHaveBeenCalledWith({
      email: 'dana@kite.in',
      token: '123456',
      type: 'email',
    });
    expect(document.querySelector('[data-landed]')).not.toBeNull();
    expect(window.localStorage.getItem('srtd.auth.next')).toBeNull();
  });
});
