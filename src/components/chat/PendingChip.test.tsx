import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { PendingChip } from '@/components/chat/PendingChip';
import { IconButton } from '@/components/ui/IconButton';
import { IconTrash } from '@/components/ui/icons';

function find(node: ReactNode, match: (el: ReactElement) => boolean): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node as ReactNode[]) {
      const hit = find(child, match);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (match(node)) return node;
  return find((node.props as { children?: ReactNode }).children, match);
}

describe('PendingChip remove (no-cross)', () => {
  it('removes with the bin, labelled "Remove <title>", never an X', () => {
    const onRemove = vi.fn();
    const chip = PendingChip({ thumb: null, title: 'deck.pdf', meta: 'PDF', onRemove });
    const remove = find(chip, (el) => el.type === IconButton);
    expect(remove).not.toBeNull();
    const props = remove!.props as { label: string; children: ReactElement; onClick: () => void };
    expect(props.label).toBe('Remove deck.pdf');
    expect(props.children.type).toBe(IconTrash);
    props.onClick();
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
