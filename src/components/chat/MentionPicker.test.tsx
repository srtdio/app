import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { MentionPicker, stepActive } from '@/components/chat/MentionPicker';
import { roleLabel } from '@/components/pages/settings/members-data';
import type { MentionMember } from '@/lib/chat/mentions';

const ANA = '11111111-1111-4111-8111-111111111111';
const BEN = '22222222-2222-4222-8222-222222222222';

const MEMBERS: MentionMember[] = [
  { userId: ANA, displayName: 'Ana Roy', avatarUrl: null, role: 'agency' },
  { userId: BEN, displayName: 'Ben', avatarUrl: null, role: 'client' },
];

/** Every element in a tree whose props carry `key` (depth-first). */
function find(node: ReactNode, key: string, acc: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) find(child, key, acc);
    return acc;
  }
  if (!isValidElement(node)) return acc;
  const props = node.props as Record<string, unknown> & { children?: ReactNode };
  if (key in props) acc.push(node);
  find(props.children, key, acc);
  return acc;
}

describe('MentionPicker', () => {
  it('renders one 44px row per member with avatar, name and role line', () => {
    const html = renderToStaticMarkup(
      <MentionPicker members={MEMBERS} active={0} onPick={() => undefined} />,
    );
    expect(html).toContain('Ana Roy');
    expect(html).toContain(roleLabel('agency'));
    expect(html).toContain(roleLabel('client'));
    expect(html.match(/min-h-11/g)).toHaveLength(2);
    expect(html).toContain('aria-selected="true"');
    // Same anchor panel as the hash picker (chat-tokens.test.ts guards tokens-only).
    expect(html).toContain('max-h-[45dvh]');
  });

  it('renders nothing when no member matches', () => {
    expect(MentionPicker({ members: [], active: 0, onPick: () => undefined })).toBeNull();
  });

  it('tap picks the row and a press never takes focus', () => {
    const onPick = vi.fn();
    const root = MentionPicker({ members: MEMBERS, active: 0, onPick });
    const rows = find(root, 'data-mention-option');
    expect(rows).toHaveLength(2);
    const second = rows[1]?.props as {
      onClick: () => void;
      onMouseDown: (e: { preventDefault: () => void }) => void;
    };
    second.onClick();
    expect(onPick).toHaveBeenCalledWith(MEMBERS[1]);
    const preventDefault = vi.fn();
    second.onMouseDown({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
  });
});

describe('stepActive', () => {
  it('moves and wraps', () => {
    expect(stepActive(0, 3, 'ArrowDown')).toBe(1);
    expect(stepActive(2, 3, 'ArrowDown')).toBe(0);
    expect(stepActive(0, 3, 'ArrowUp')).toBe(2);
    expect(stepActive(0, 0, 'ArrowUp')).toBe(0);
  });
});
