// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthShell } from '@/components/auth/AuthShell';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function classesOf(text: string): string[] {
  const el = [...document.querySelectorAll<HTMLElement>('body *')].find(
    (node) => node.textContent === text && node.children.length === 0,
  );
  if (el === undefined) throw new Error(`no element with text ${text}`);
  return el.className.split(/\s+/);
}

describe('AuthShell type roles', () => {
  it('title is the screen header, subtitle and footer are secondary copy', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <AuthShell title="Sign in" subtitle="Welcome back to Sorted." footer="New here? Sign up">
          <p>form</p>
        </AuthShell>,
      );
    });
    const title = classesOf('Sign in');
    expect(title).toContain('text-lg');
    expect(title).toContain('font-semibold');

    const subtitle = classesOf('Welcome back to Sorted.');
    expect(subtitle).toContain('text-base');
    expect(subtitle).toContain('text-fg-2');

    const footer = classesOf('New here? Sign up');
    expect(footer).toContain('text-base');
    expect(footer).toContain('text-fg-2');
  });
});
