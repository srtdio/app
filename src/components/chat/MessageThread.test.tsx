import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

// MessageThread's import graph pulls the message factory, which imports the real
// agora-chat browser SDK. Mock it so importing the module in node never touches
// browser globals or the network (mirrors ChatShell.test.tsx).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { Avatar } from '@/components/ui/Avatar';
import { MessageBubble } from '@/components/chat/MessageThread';
import { PresignCache } from '@/lib/asset-presign';
import type { ChatProfile } from '@/lib/chat-reads';
import type { ThreadMessage } from '@/lib/chat/thread';

// MessageBubble is a pure, hook-free presentational component, so calling it
// directly returns its element tree without invoking child components (Avatar,
// SharedPostCards, ...). That keeps these assertions in the node test job with
// no DOM, exactly as ChatShell.test.tsx inspects ChatShell's returned element.
const cache = new PresignCache({
  endpoint: null,
  getAccessToken: () => Promise.resolve(null),
  fetcher: () => Promise.reject(new Error('unused')),
});

const PROFILES: Map<string, ChatProfile> = new Map([
  ['peer-1', { userId: 'peer-1', displayName: 'Alice', avatarUrl: null }],
]);

function makeMessage(over: Partial<ThreadMessage>): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: 'peer-1',
    body: 'hello there',
    time: 0,
    mine: false,
    attachments: [],
    sharedPostIds: [],
    reply: null,
    status: 'sent',
    reactions: [],
    ...over,
  };
}

function renderBubble(message: ThreadMessage): ReactElement {
  return MessageBubble({
    message,
    profiles: PROFILES,
    cache,
    presignEnabled: false,
    showTicks: false,
    pickerOpen: false,
    onTogglePicker: () => {},
    onReact: () => {},
    onReply: () => {},
  });
}

/** Walk the element tree depth-first, yielding every React element. */
function walk(node: ReactNode, visit: (el: ReactElement) => void): void {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (!isValidElement(node)) return;
  visit(node);
  walk((node.props as { children?: ReactNode }).children, visit);
}

function hasAvatar(root: ReactElement): boolean {
  let found = false;
  walk(root, (el) => {
    if (el.type === Avatar) found = true;
  });
  return found;
}

function allText(root: ReactElement): string {
  const parts: string[] = [];
  walk(root, (el) => {
    const child = (el.props as { children?: ReactNode }).children;
    if (typeof child === 'string') parts.push(child);
  });
  return parts.join(' ');
}

function rootClass(root: ReactElement): string {
  return (root.props as { className?: string }).className ?? '';
}

describe('MessageBubble WhatsApp-style layout', () => {
  it('renders own messages right-aligned with no avatar and no sender name', () => {
    const root = renderBubble(makeMessage({ mine: true, senderUserId: 'me' }));
    expect(rootClass(root)).toContain('flex-row-reverse');
    expect(hasAvatar(root)).toBe(false);
    expect(allText(root)).not.toContain('You');
  });

  it('renders peer messages left-aligned with an avatar and the sender name', () => {
    const root = renderBubble(makeMessage({ mine: false }));
    expect(rootClass(root)).toContain('flex-row');
    expect(rootClass(root)).not.toContain('flex-row-reverse');
    expect(hasAvatar(root)).toBe(true);
    expect(allText(root)).toContain('Alice');
  });
});
