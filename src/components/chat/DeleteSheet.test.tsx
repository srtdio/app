import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import {
  DELETE_FOR_EVERYONE_LABEL,
  DELETE_FOR_ME_LABEL,
  DeleteSheet,
  deleteSheetTitle,
} from '@/components/chat/DeleteSheet';

function all(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!isValidElement(n)) return;
    out.push(n as ReactElement<Record<string, unknown>>);
    walk((n.props as { children?: ReactNode }).children);
  };
  walk(node);
  return out;
}

function sheet(everyone: boolean, count = 1) {
  const onEveryone = vi.fn();
  const onForMe = vi.fn();
  const onClose = vi.fn();
  const root = DeleteSheet({ open: true, count, everyone, onEveryone, onForMe, onClose });
  const buttons = all(root).filter((el) => el.type === Button);
  const choice = (name: string): ReactElement<Record<string, unknown>> | undefined =>
    buttons.find((b) => b.props['data-delete-choice'] === name);
  return { root, buttons, choice, onEveryone, onForMe, onClose };
}

describe('DeleteSheet', () => {
  it('titles one or several messages', () => {
    expect(deleteSheetTitle(1)).toBe('Delete message?');
    expect(deleteSheetTitle(3)).toBe('Delete 3 messages?');
    const { root } = sheet(true, 3);
    expect(root.type).toBe(Sheet);
    expect(root.props).toMatchObject({ open: true, title: 'Delete 3 messages?' });
  });

  it('with Delete for everyone: everyone, me, then Cancel; both deletes are danger', () => {
    const { buttons, choice, root } = sheet(true);
    expect(all(root).some((el) => el.props['data-testid'] === 'delete-sheet')).toBe(true);
    expect(buttons.map((b) => b.props['data-delete-choice'])).toEqual(['everyone', 'me', 'cancel']);
    expect(choice('everyone')?.props.children).toBe(DELETE_FOR_EVERYONE_LABEL);
    expect(choice('me')?.props.children).toBe(DELETE_FOR_ME_LABEL);
    expect(choice('cancel')?.props.children).toBe('Cancel');
    expect(choice('everyone')?.props.variant).toBe('danger');
    expect(choice('me')?.props.variant).toBe('danger');
    expect(choice('cancel')?.props.variant).toBe('ghost');
    expect(DELETE_FOR_EVERYONE_LABEL).toBe('Delete for everyone');
    expect(DELETE_FOR_ME_LABEL).toBe('Delete for me');
  });

  it('without Delete for everyone: only Delete for me and Cancel', () => {
    const { buttons, choice } = sheet(false);
    expect(buttons.map((b) => b.props['data-delete-choice'])).toEqual(['me', 'cancel']);
    expect(choice('everyone')).toBeUndefined();
  });

  it('each choice closes the sheet, then runs once', () => {
    const one = sheet(true);
    (one.choice('everyone')?.props.onClick as () => void)();
    expect(one.onClose).toHaveBeenCalledTimes(1);
    expect(one.onEveryone).toHaveBeenCalledTimes(1);
    expect(one.onForMe).not.toHaveBeenCalled();

    const two = sheet(true);
    (two.choice('me')?.props.onClick as () => void)();
    expect(two.onClose).toHaveBeenCalledTimes(1);
    expect(two.onForMe).toHaveBeenCalledTimes(1);
    expect(two.onEveryone).not.toHaveBeenCalled();

    const three = sheet(true);
    (three.choice('cancel')?.props.onClick as () => void)();
    expect(three.onClose).toHaveBeenCalledTimes(1);
    expect(three.onForMe).not.toHaveBeenCalled();
    expect(three.onEveryone).not.toHaveBeenCalled();
  });

  it('phone: a full-width stack; laptop: one row, Cancel first on the trailing edge', () => {
    const { root, buttons } = sheet(true);
    const stack = all(root).find((el) => el.props['data-testid'] === 'delete-sheet');
    const cls = String(stack?.props.className).split(' ');
    expect(cls).toContain('flex-col');
    expect(cls).toContain('md:flex-row-reverse');
    for (const b of buttons) {
      const bc = String(b.props.className).split(' ');
      expect(bc).toContain('w-full');
      expect(bc).toContain('md:w-auto');
    }
  });
});
