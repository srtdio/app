import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { Toast } from '@/components/ui/toast/Toast';
import type { Toast as ToastModel } from '@/components/ui/toast/types';

// Toast is hookless, so it can be invoked as a function and its element tree
// walked without a DOM (the SectionHeader/SortMenu test convention here).
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

function textOf(tree: ReactNode): string {
  const all: ReactElement[] = [];
  collect(tree, all);
  return all
    .map((el) => (el.props as { children?: ReactNode }).children)
    .filter((child): child is string => typeof child === 'string')
    .join(' ');
}

const base: ToastModel = { id: '1', title: 'New message' };

describe('Toast', () => {
  it('renders the title and description', () => {
    const tree = Toast({ toast: { ...base, description: 'from Alex' }, onDismiss: () => {} });
    const text = textOf(tree);
    expect(text).toContain('New message');
    expect(text).toContain('from Alex');
  });

  it('fires onPress when the content area is tapped', () => {
    const onPress = vi.fn();
    const tree = Toast({ toast: { ...base, onPress }, onDismiss: () => {} });
    const pressables = findAll(
      tree,
      (el) => el.type === 'button' && (el.props as { onClick?: unknown }).onClick === onPress,
    );
    expect(pressables).toHaveLength(1);
    (pressables[0]!.props as { onClick: () => void }).onClick();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('exposes a labelled dismiss button that calls onDismiss with the id', () => {
    const onDismiss = vi.fn();
    const tree = Toast({ toast: base, onDismiss });
    const dismiss = findAll(tree, (el) => ariaLabel(el) === 'Dismiss notification');
    expect(dismiss).toHaveLength(1);
    (dismiss[0]!.props as { onClick: () => void }).onClick();
    expect(onDismiss).toHaveBeenCalledWith('1');
  });

  it('does not render a press button when onPress is absent', () => {
    const tree = Toast({ toast: base, onDismiss: () => {} });
    // Only the dismiss button is a <button> when the toast is not pressable.
    const buttons = findAll(tree, (el) => el.type === 'button');
    expect(buttons).toHaveLength(1);
    expect(ariaLabel(buttons[0]!)).toBe('Dismiss notification');
  });

  it('plays the enter animation by default and the exit animation while leaving', () => {
    const animationOf = (tree: ReactElement): string =>
      (tree.props as { style: { animation: string } }).style.animation;
    expect(animationOf(Toast({ toast: base, onDismiss: () => {} }))).toContain('sorted-toast-in');
    expect(animationOf(Toast({ toast: base, leaving: true, onDismiss: () => {} }))).toContain(
      'sorted-toast-out',
    );
  });

  it('renders an optional 44px action that runs and then dismisses the toast', () => {
    const onPress = vi.fn();
    const onDismiss = vi.fn();
    const tree = Toast({ toast: { ...base, action: { label: 'Undo', onPress } }, onDismiss });
    const action = findAll(
      tree,
      (el) => (el.props as Record<string, unknown>)['data-toast-action'] === '',
    );
    expect(action).toHaveLength(1);
    const props = action[0]!.props as { onClick: () => void; className: string; children: string };
    expect(props.children).toBe('Undo');
    expect(props.className).toContain('min-h-[44px]');
    expect(props.className).toContain('min-w-[44px]');
    props.onClick();
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith('1');
    // The dismiss control is still there, apart from the action.
    expect(findAll(tree, (el) => ariaLabel(el) === 'Dismiss notification')).toHaveLength(1);
  });

  it('renders no action button when none is given (existing toasts unchanged)', () => {
    const tree = Toast({ toast: base, onDismiss: () => {} });
    expect(
      findAll(tree, (el) => (el.props as Record<string, unknown>)['data-toast-action'] === ''),
    ).toHaveLength(0);
  });
});
