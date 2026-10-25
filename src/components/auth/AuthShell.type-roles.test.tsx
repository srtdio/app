// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthShell } from '@/components/auth/AuthShell';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function render(ui: ReactElement, initialEntries: string[] = ['/signin']): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>);
  });
}

function classesOf(text: string): string[] {
  const el = [...document.querySelectorAll<HTMLElement>('body *')].find(
    (node) => node.textContent === text && node.children.length === 0,
  );
  if (el === undefined) throw new Error(`no element with text ${text}`);
  return el.className.split(/\s+/);
}

function card(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-auth-card]')!;
}

describe('AuthShell type roles', () => {
  it('title is the page title, subtitle and footer are secondary copy', async () => {
    await render(
      <AuthShell title="Sign in" subtitle="Welcome back to Sorted." footer="New here? Sign up">
        <p>form</p>
      </AuthShell>,
    );
    const title = classesOf('Sign in');
    expect(title).toContain('text-3xl');
    expect(title).toContain('font-semibold');
    expect(title).toContain('tracking-tight');

    const subtitle = classesOf('Welcome back to Sorted.');
    expect(subtitle).toContain('text-base');
    expect(subtitle).toContain('text-fg-2');

    const footer = classesOf('New here? Sign up');
    expect(footer).toContain('text-base');
    expect(footer).toContain('text-fg-2');
  });

  it('title and subtitle balance their lines so no word is left alone on phone', async () => {
    await render(
      <AuthShell title="Create your free account" subtitle="Welcome to Sorted." footer="f">
        <p>form</p>
      </AuthShell>,
    );
    expect(classesOf('Create your free account')).toContain('[text-wrap:balance]');
    expect(classesOf('Welcome to Sorted.')).toContain('[text-wrap:balance]');
  });

  it('card uses the shared card shadow token and the 16px radius', async () => {
    await render(
      <AuthShell title="Sign up" subtitle="s" footer="f">
        <p>form</p>
      </AuthShell>,
    );
    expect(card().className).toContain('shadow-[var(--shadow-card)]');
    expect(card().className).toContain('rounded-2xl');
    expect(card().className).not.toContain('rgba(');
  });

  it('footer renders inside the card under a divider', async () => {
    await render(
      <AuthShell title="Sign up" subtitle="s" footer="Already have an account?">
        <p>form</p>
      </AuthShell>,
    );
    const footer = [...card().querySelectorAll<HTMLElement>('div')].find(
      (node) => node.textContent === 'Already have an account?',
    );
    expect(footer).toBeDefined();
    expect(footer?.className).toContain('border-t');
  });

  it('renders no divider when the footer is null', async () => {
    await render(
      <AuthShell title="Invite link" subtitle="s" footer={null}>
        <p>form</p>
      </AuthShell>,
    );
    expect(card().querySelector('.border-t')).toBeNull();
  });

  it('shows the Plan backdrop by default and none with backdrop off', async () => {
    await render(
      <AuthShell title="Sign up" subtitle="s" footer="f">
        <p>form</p>
      </AuthShell>,
    );
    expect(document.querySelector('[data-plan-backdrop]')).not.toBeNull();
    act(() => root?.unmount());
    document.body.innerHTML = '';

    await render(
      <AuthShell title="Privacy policy" subtitle="s" footer="f" backdrop={false}>
        <p>policy</p>
      </AuthShell>,
    );
    expect(document.querySelector('[data-plan-backdrop]')).toBeNull();
  });

  it('logo links home', async () => {
    await render(
      <AuthShell title="Sign up" subtitle="s" footer="f">
        <p>form</p>
      </AuthShell>,
    );
    const link = document.querySelector<HTMLAnchorElement>('[data-auth-home-link]')!;
    expect(link.getAttribute('href')).toBe('/');
    expect(link.getAttribute('aria-label')).toBe('srtd home');
    expect(link.getAttribute('target')).toBeNull();
  });

  it('clicking the logo routes to the home route', async () => {
    await render(
      <Routes>
        <Route path="/" element={<p data-home-marker="">home</p>} />
        <Route
          path="/signup"
          element={
            <AuthShell title="Sign up" subtitle="s" footer="f">
              <p>form</p>
            </AuthShell>
          }
        />
      </Routes>,
      ['/signup'],
    );
    const link = document.querySelector<HTMLAnchorElement>('[data-auth-home-link]')!;
    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(document.querySelector('[data-home-marker]')).not.toBeNull();
    expect(document.querySelector('[data-auth-card]')).toBeNull();
  });
});
