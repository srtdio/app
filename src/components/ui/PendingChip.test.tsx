import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PendingChip, PENDING_CHIP_FAILED } from '@/components/ui/PendingChip';
import { IconButton } from '@/components/ui/IconButton';
import { IconX } from '@/components/ui/icons';

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

describe('ui/PendingChip: the one pending-file chip', () => {
  it('ready: trailing X labelled "Remove <title>" removes it', () => {
    const onRemove = vi.fn();
    const chip = PendingChip({ thumb: null, title: 'deck.pdf', meta: 'PDF · 1.2 MB', onRemove });
    const remove = find(chip, (el) => el.type === IconButton);
    expect(remove).not.toBeNull();
    const props = remove!.props as { label: string; children: ReactElement; onClick: () => void };
    expect(props.label).toBe('Remove deck.pdf');
    expect(props.children.type).toBe(IconX);
    props.onClick();
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('48 thumb radius 8, chip radius 12, padding 4', () => {
    const html = renderToStaticMarkup(
      <ul>
        <PendingChip thumb={null} title="a.png" meta="PNG" onRemove={() => {}} />
      </ul>,
    );
    expect(html).toContain('h-12 w-12');
    expect(html).toContain('rounded-lg');
    expect(html).toMatch(/data-pending-chip="ready"[^>]*class="[^"]*rounded-xl[^"]*p-1/);
  });

  it('uploading: ring + X on the thumb, size meta, no trailing X', () => {
    const html = renderToStaticMarkup(
      <ul>
        <PendingChip
          thumb={null}
          title="a.png"
          meta="1.2 of 3.4 MB"
          status={{ state: 'uploading', progress: 0.3 }}
          onRemove={() => {}}
        />
      </ul>,
    );
    expect(html).toContain('data-upload-ring');
    expect(html).toContain('1.2 of 3.4 MB');
    expect(html).not.toContain('aria-label="Remove a.png"');
    expect(html).not.toContain('%');
  });

  it('failed: bad border, "Couldn\'t upload", Retry and the trailing X', () => {
    const html = renderToStaticMarkup(
      <ul>
        <PendingChip
          thumb={null}
          title="a.png"
          meta="PNG"
          status={{ state: 'failed' }}
          onRemove={() => {}}
          onRetry={() => {}}
        />
      </ul>,
    );
    expect(html).toContain('border-bad');
    expect(html).toContain(PENDING_CHIP_FAILED.replace("'", '&#x27;'));
    expect(html).toContain('aria-label="Retry a.png"');
    expect(html).toContain('aria-label="Remove a.png"');
  });
});
