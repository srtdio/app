import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// The unit env is `node` with no DOM, so Topbar is invoked as a plain function
// and its element tree walked (the SectionHeader/SortMenu test style in this
// codebase). Its single useState (the create popover) is shimmed to a pure
// value/setter pair so the body can run without a renderer.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (init: unknown) => [
      typeof init === 'function' ? (init as () => unknown)() : init,
      () => {},
    ],
  };
});

import { Topbar } from '@/components/shell/Topbar';

function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

function collect(node: ReactNode, found: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, found));
    return;
  }
  if (!isElement(node)) return;
  found.push(node);
  collect((node.props as { children?: ReactNode }).children, found);
}

function findAll(tree: ReactNode, predicate: (el: ReactElement) => boolean): ReactElement[] {
  const all: ReactElement[] = [];
  collect(tree, all);
  return all.filter(predicate);
}

function ariaLabel(el: ReactElement): string | undefined {
  return (el.props as { 'aria-label'?: string })['aria-label'];
}

function className(el: ReactElement): string {
  return (el.props as { className?: string }).className ?? '';
}

function texts(tree: ReactNode): string[] {
  const out: string[] = [];
  const all: ReactElement[] = [];
  collect(tree, all);
  for (const el of all) {
    const child = (el.props as { children?: ReactNode }).children;
    if (typeof child === 'string') out.push(child);
  }
  return out;
}

const baseProps = {
  onOpenPalette: () => {},
  onOpenAvatar: () => {},
};

function switcherButtons(tree: ReactNode): ReactElement[] {
  return findAll(tree, (el) => el.type === 'button' && ariaLabel(el) === 'Switch workspace');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Topbar mobile workspace switcher', () => {
  it('renders a mobile-only button carrying the workspace name and a chevron', () => {
    const tree = Topbar({ ...baseProps, workspaceName: 'Acme' });
    const buttons = switcherButtons(tree);
    expect(buttons).toHaveLength(1);

    const button = buttons[0]!;
    expect((button.props as { 'aria-haspopup'?: string })['aria-haspopup']).toBe('dialog');
    expect(className(button)).toContain('md:hidden');
    // Touch target invariant: the tap area is at least 44px tall.
    expect(className(button)).toContain('min-h-[44px]');
    expect(texts(button)).toContain('Acme');
    // The name is bounded so search / create / avatar stay on a 375px screen.
    expect(className(button)).toMatch(/max-w-\[\d+px\]/);
  });

  it('dispatches the sorted:switch-workspace window event when clicked', () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const listener = vi.fn();
    target.addEventListener('sorted:switch-workspace', listener);

    const tree = Topbar({ ...baseProps, workspaceName: 'Acme' });
    (switcherButtons(tree)[0]!.props as { onClick: () => void }).onClick();

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]![0] as Event).type).toBe('sorted:switch-workspace');
  });

  it('renders no switcher button while the workspace name is still loading', () => {
    const tree = Topbar({ ...baseProps, workspaceName: null });
    expect(switcherButtons(tree)).toHaveLength(0);
  });
});
