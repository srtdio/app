// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { state, navigate } = vi.hoisted(() => ({
  state: { restart: undefined as (() => void) | undefined },
  navigate: vi.fn(),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('@/components/induction/InductionProvider', () => ({
  useInduction: () => (state.restart === undefined ? null : { restart: state.restart }),
}));
vi.mock('@/lib/use-theme', () => ({ useTheme: () => ({ theme: 'light', toggle: vi.fn() }) }));
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
vi.mock('@/lib/events', () => ({ dispatchSorted: vi.fn() }));

import { AvatarMenu } from '@/components/shell/AvatarMenu';
import { GUIDE_CHROME } from '@/lib/induction-copy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  state.restart = undefined;
  navigate.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function mount(): void {
  root = createRoot(host!);
  act(() => root!.render(<AvatarMenu open onClose={() => undefined} />));
}

function labels(): string[] {
  return Array.from(document.querySelectorAll('[role="menuitem"]')).map(
    (el) => el.textContent ?? '',
  );
}

describe('AvatarMenu rows', () => {
  it('has no Members row', () => {
    mount();
    expect(labels()).not.toContain('Members');
  });

  it('lists the rows in order without Restart tour when the guide is off', () => {
    mount();
    expect(labels()).toEqual([
      'Switch workspace',
      'Settings',
      'Recently deleted',
      'Appearance',
      'Help',
      'Sign out',
    ]);
  });

  it('adds Restart tour after Help when the guide can restart', () => {
    state.restart = vi.fn();
    mount();
    expect(labels()).toEqual([
      'Switch workspace',
      'Settings',
      'Recently deleted',
      'Appearance',
      'Help',
      GUIDE_CHROME.restart,
      'Sign out',
    ]);
  });

  it('has no Profile row and Settings routes to /settings', () => {
    mount();
    expect(labels()).not.toContain('Profile');
    const settings = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (el) => el.textContent === 'Settings',
    );
    act(() => (settings as HTMLButtonElement).click());
    expect(navigate).toHaveBeenCalledWith('/settings');
  });
});

describe('AvatarMenu dismiss (laptop popover)', () => {
  it('closes on Escape and hands focus back to the account button', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Account menu';
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    function Harness({ open }: { open: boolean }) {
      return <AvatarMenu open={open} onClose={onClose} />;
    }
    root = createRoot(host!);
    act(() => root!.render(<Harness open />));
    const row = document.querySelector<HTMLButtonElement>('[role="menuitem"]');
    act(() => row?.focus());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root!.render(<Harness open={false} />));
    expect(document.activeElement).toBe(opener);
  });
});
