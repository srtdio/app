import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import { MarkBadge } from '@/components/chat/MarkBits';
import { PressableRow } from '@/components/ui/PressableRow';
import { Tag } from '@/components/ui/Tag';
import type { ChatMark } from '@/lib/chat/marks';

// MarkBadge is hook-free, so its returned element is inspected directly with
// no DOM, as MessageThread.test.tsx does for MessageBubble.
function mark(over: Partial<ChatMark>): ChatMark {
  return {
    messageId: 'm1',
    channelId: 'c1',
    type: 'commitment',
    priority: null,
    markedAt: 't',
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    ...over,
  };
}

function render(m: ChatMark | undefined, onChangePriority = vi.fn()): ReactElement {
  return MarkBadge({ mark: m, onChangePriority });
}

describe('MarkBadge', () => {
  it('frozen marks render a plain label with no action', () => {
    for (const type of ['commitment', 'decision'] as const) {
      const el = render(mark({ type }));
      expect(el.type).toBe('span');
      const tag = (el.props as { children: ReactElement }).children;
      expect(tag.type).toBe(Tag);
      expect(tag.props).toMatchObject({
        label: type === 'commitment' ? 'Commitment' : 'Decision',
        tone: type === 'commitment' ? 'good' : 'accent',
      });
    }
  });

  it('an open pending badge is a button that opens the priority chooser', () => {
    const onChangePriority = vi.fn();
    const el = render(mark({ type: 'pending', priority: 1 }), onChangePriority);
    expect(el.type).toBe(PressableRow);
    const props = el.props as {
      children: ReactElement;
      inline: boolean;
      className: string;
      onClick: (e: { stopPropagation: () => void }) => void;
    };
    // The small pill is the shared Tag inside a 44px-tall PressableRow target.
    expect(props.children.type).toBe(Tag);
    expect(props.children.props).toMatchObject({ label: 'Pending P1', tone: 'warn' });
    expect(String((props.children.props as { className: string }).className)).toContain(
      'min-w-[44px]',
    );
    expect(props.inline).toBe(true);
    expect(props.className).toContain('-mt-3');
    props.onClick({ stopPropagation: vi.fn() });
    expect(onChangePriority).toHaveBeenCalledOnce();
  });

  it('renders nothing for no mark', () => {
    const el = render(undefined);
    expect(isValidElement(el)).toBe(true);
    expect((el.props as { children?: unknown }).children).toBeUndefined();
  });

  it('a stamped mark renders a plain label with the stamp word, never a button', () => {
    const cases = [
      [mark({ type: 'commitment', resolved: true }), 'Commitment · Delivered'],
      [mark({ type: 'decision', resolved: true }), 'Decision · Closed'],
      [mark({ type: 'pending', priority: 1, resolved: true }), 'Pending · Completed'],
    ] as const;
    for (const [m, label] of cases) {
      const el = render(m);
      expect(el.type).toBe('span');
      const tag = (el.props as { children: ReactElement }).children;
      expect(tag.type).toBe(Tag);
      expect((tag.props as { label: string }).label).toBe(label);
    }
  });
});
