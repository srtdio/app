import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// The unit env is `node` with no DOM, so Topbar is invoked as a plain function
// and its element tree walked (the SectionHeader/SortMenu test style in this
// codebase). Topbar holds no hooks, so no renderer is needed.
import { Topbar } from '@/components/shell/Topbar';
import { NotificationsButton } from '@/components/shell/NotificationsButton';
import { Button } from '@/components/ui/Button';

// The button's module graph reaches the chat SDK and the logger: stub both.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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

/** The switcher is a <Button>; expand it (hookless) to read the host <button> it renders. */
function switcherButtons(tree: ReactNode): ReactElement[] {
  return findAll(
    tree,
    (el) => (el.type === 'button' || el.type === Button) && ariaLabel(el) === 'Switch workspace',
  ).map((el) =>
    el.type === Button ? (Button(el.props as Parameters<typeof Button>[0]) as ReactElement) : el,
  );
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
    // The name is bounded so search / avatar stay on a 375px screen.
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

describe('Topbar create menu', () => {
  it('renders no Create button and no New post / New brief entries', () => {
    const tree = Topbar({ ...baseProps, workspaceName: 'Acme' });
    const labels = findAll(tree, () => true).map(
      (el) => (el.props as { label?: string; 'aria-label'?: string }).label ?? ariaLabel(el),
    );
    expect(labels).not.toContain('Create');
    expect(labels).not.toContain('New post');
    expect(labels).not.toContain('New brief');
    expect(texts(tree)).not.toContain('New post');
    expect(texts(tree)).not.toContain('New brief');
  });
});

describe('Notifications lives in the top bar on every main screen', () => {
  it('mounts the Notifications button once beside search and the account menu', () => {
    const tree = Topbar({ ...baseProps, workspaceName: 'Acme' });
    expect(findAll(tree, (el) => el.type === NotificationsButton)).toHaveLength(1);
  });

  it('leaves the button out while there is no workspace yet', () => {
    const creating = Topbar({ ...baseProps, workspaceName: null, onCreateWorkspace: () => {} });
    expect(findAll(creating, (el) => el.type === NotificationsButton)).toHaveLength(0);
    const loading = Topbar({ ...baseProps, workspaceName: null });
    expect(findAll(loading, (el) => el.type === NotificationsButton)).toHaveLength(0);
  });
});
