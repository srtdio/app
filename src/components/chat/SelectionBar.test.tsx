import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { describe, expect, it, vi } from 'vitest';
import {
  SelectionBarView,
  SelectionHeader,
  selectedCountLabel,
} from '@/components/chat/SelectionBar';
import { DELETE_BLOCK_COPY } from '@/lib/chat/forward';

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

const find = (el: ReactElement, attr: string): ReactElement<Record<string, unknown>> | undefined =>
  all(el).find((e) => e.props[attr] !== undefined);

describe('SelectionBarView (D4)', () => {
  it('others selected: Delete stays visible, disabled, with "Only your own messages can be deleted"', () => {
    const bar = SelectionBarView({
      count: 2,
      block: 'others',
      canDelete: false,
      onForward: vi.fn(),
      onDeleteTap: vi.fn(),
    });
    expect(find(bar, 'data-selection-delete')?.props.disabled).toBe(true);
    const reason = find(bar, 'data-selection-reason');
    expect(reason?.props.children).toBe('Only your own messages can be deleted');
    expect(reason?.props.children).toBe(DELETE_BLOCK_COPY.others);
  });

  it('an own message older than 30 min: disabled with "Messages older than 30 min can\'t be deleted"', () => {
    const bar = SelectionBarView({
      count: 1,
      block: 'old',
      canDelete: false,
      onDeleteTap: vi.fn(),
    });
    expect(find(bar, 'data-selection-delete')?.props.disabled).toBe(true);
    expect(find(bar, 'data-selection-reason')?.props.children).toBe(
      "Messages older than 30 min can't be deleted",
    );
  });

  it('deletable: enabled, no reason line; Delete opens the confirm', () => {
    const onDeleteTap = vi.fn();
    const bar = SelectionBarView({ count: 1, block: null, canDelete: true, onDeleteTap });
    const del = find(bar, 'data-selection-delete');
    expect(del?.props.disabled).toBe(false);
    expect(find(bar, 'data-selection-reason')).toBeUndefined();
    (del?.props.onClick as () => void)();
    expect(onDeleteTap).toHaveBeenCalledOnce();
  });

  it('zero selected: Forward and Delete disabled, the bar stays; it keeps the safe-area inset', () => {
    const bar = SelectionBarView({
      count: 0,
      block: null,
      canDelete: false,
      onForward: vi.fn(),
      onDeleteTap: vi.fn(),
    });
    expect(find(bar, 'data-selection-forward')?.props.disabled).toBe(true);
    expect(find(bar, 'data-selection-delete')?.props.disabled).toBe(true);
    expect(String(bar.props.className)).toContain('env(safe-area-inset-bottom)');
  });
});

describe('SelectionHeader (D8)', () => {
  it('"N selected" and a 44x44 Cancel that exits', () => {
    const onCancel = vi.fn();
    const header = SelectionHeader({ count: 0, onCancel, layout: 'touch' });
    expect(find(header, 'data-selection-count')?.props.children).toBe('0 selected');
    expect(selectedCountLabel(3)).toBe('3 selected');
    const cancel = find(header, 'data-selection-cancel');
    // The shared Button (44 tall, 8px radius) as a link, at least 44 wide.
    expect(cancel?.type).toBe(Button);
    expect(cancel?.props.variant).toBe('link');
    expect(String(cancel?.props.className)).toContain('min-w-[44px]');
    (cancel?.props.onClick as () => void)();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
