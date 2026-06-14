import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement, ReactNode } from 'react';
import { ActivityRow } from '@/components/pages/activity/ActivityRow';
import { AvatarStack } from '@/components/pages/activity/AvatarStack';
import type { ActivityItem } from '@/components/pages/activity/data';

function item(over: Partial<ActivityItem>): ActivityItem {
  return {
    id: 'e1',
    workspaceId: 'w1',
    eventType: 'comment',
    entityType: 'post',
    entityId: 'p1',
    scope: 'posts',
    tier: 'active',
    createdAt: '2026-06-14T00:00:00.000Z',
    readAt: null,
    snoozedUntil: null,
    commentId: null,
    toStage: null,
    fromStage: null,
    title: null,
    actorId: null,
    actorName: null,
    ...over,
  };
}

function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

// ActivityRow itself is hookless, so we invoke it to get its element tree and
// walk it. Its stateful child (ActivityRowMenu, which reads window.matchMedia)
// is left as an unexpanded element, so this never touches the DOM.
function collect(node: ReactNode, found: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, found));
    return;
  }
  if (!isElement(node)) return;
  found.push(node);
  collect((node.props as { children?: ReactNode }).children, found);
}

function texts(node: ReactNode): string[] {
  const out: string[] = [];
  const walk = (n: ReactNode): void => {
    if (typeof n === 'string') out.push(n);
    else if (Array.isArray(n)) n.forEach(walk);
    else if (isElement(n)) walk((n.props as { children?: ReactNode }).children);
  };
  walk(node);
  return out;
}

function renderRow(it: ActivityItem): ReactElement[] {
  const tree = ActivityRow({
    item: it,
    nowMs: Date.parse('2026-06-14T01:00:00.000Z'),
    onOpen: () => {},
    onSnooze: () => {},
    onMarkRead: () => {},
  });
  const found: ReactElement[] = [];
  collect(tree, found);
  return found;
}

describe('ActivityRow', () => {
  it('renders the activity line', () => {
    const nodes = renderRow(item({ eventType: 'comment', actorName: 'Alice', title: 'Q3' }));
    const joined = nodes.flatMap((n) => texts(n)).join(' ');
    expect(joined).toContain('Alice commented on Q3');
  });

  it('shows the unread dot for an unread row and hides it once read', () => {
    const unread = renderRow(item({ readAt: null }));
    expect(unread.some((n) => (n.props as { ['aria-label']?: string })['aria-label'] === 'Unread')).toBe(
      true,
    );
    const read = renderRow(item({ readAt: '2026-06-14T00:30:00.000Z' }));
    expect(read.some((n) => (n.props as { ['aria-label']?: string })['aria-label'] === 'Unread')).toBe(
      false,
    );
  });
});

describe('AvatarStack', () => {
  it('renders nothing for an empty set', () => {
    expect(renderToStaticMarkup(<AvatarStack names={[]} />)).toBe('');
  });

  it('overlaps up to three and shows a +N indicator beyond that', () => {
    const html = renderToStaticMarkup(
      <AvatarStack names={['Ann', 'Bo', 'Cy', 'Di', 'Ed']} />,
    );
    expect(html).toContain('+2');
  });
});
