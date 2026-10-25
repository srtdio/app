// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { signInWithOtp } = vi.hoisted(() => ({ signInWithOtp: vi.fn() }));

vi.mock('@/lib/supabase', () => ({ supabase: { auth: { signInWithOtp } } }));

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
      "Couldn't send the link. Try again.",
    );
  });
});

describe('SignInPage (W11 fix 6)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    signInWithOtp.mockReset();
    signInWithOtp.mockResolvedValue({ error: null });
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
  });

  async function render(): Promise<void> {
    root = createRoot(host!);
    await act(async () => {
      root!.render(
        <MemoryRouter
          initialEntries={['/signin']}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <SignInPage />
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
    await act(async () => button('Email me a sign-in link').click());
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it('shows plain copy for a rate limit', async () => {
    signInWithOtp.mockResolvedValue({ error: { message: 'too many', status: 429 } });
    await render();
    await typeEmail('dana@kite.in');
    await act(async () => button('Email me a sign-in link').click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Too many tries. Wait a minute and try again.',
    );
  });

  it('Check your email offers Use a different email, back to the form with the email kept', async () => {
    await render();
    await typeEmail('dana@kite.in');
    await act(async () => button('Email me a sign-in link').click());
    expect(document.body.textContent).toContain('Check your email');
    await act(async () => button('Use a different email').click());
    expect(emailInput().value).toBe('dana@kite.in');
  });
});
