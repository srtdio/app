import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// The shell's import graph pulls the message factory, which imports the real
// agora-chat browser SDK. Mock it so importing the shell in node never touches
// browser globals or the network.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { ChatShell } from '@/components/chat/ChatShell';
import { ChatConnected } from '@/components/chat/ChatConnected';
import { ChatUnavailable, chatUnavailableView } from '@/components/chat/ChatUnavailable';
import { EmptyState } from '@/components/ui/EmptyState';

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

function find(tree: ReactNode, predicate: (el: ReactElement) => boolean): ReactElement[] {
  const all: ReactElement[] = [];
  collect(tree, all);
  return all.filter(predicate);
}

describe('ChatShell status dispatch', () => {
  it('renders the full unavailable panel only when there is no workspace or user', () => {
    const render = () =>
      ChatShell({ status: 'unavailable', client: null, workspaceId: '', currentUserId: '' });
    expect(render).not.toThrow();
    expect(render().type).toBe(ChatUnavailable);
  });

  it('keeps the Postgres chat surface (list, history, sending) mounted in every down state', () => {
    for (const status of ['connecting', 'reconnecting', 'unavailable', 'kicked'] as const) {
      const view = ChatShell({ status, client: null, workspaceId: 'w', currentUserId: 'u' });
      const connected = find(view, (el) => el.type === ChatConnected);
      expect(connected).toHaveLength(1);
      expect((connected[0]?.props as { client: unknown }).client).toBeNull();
      expect((connected[0]?.props as { status: string }).status).toBe(status);
    }
  });

  it('renders no banner node while disconnected: ChatConnected is the only child, no status strip', () => {
    for (const status of [
      'connecting',
      'reconnecting',
      'unavailable',
      'kicked',
      'connected',
    ] as const) {
      const view = ChatShell({ status, client: null, workspaceId: 'w', currentUserId: 'u' });
      const all = find(view, () => true);
      expect(all.filter((el) => el.type === ChatConnected)).toHaveLength(1);
      // Only the two layout wrappers and ChatConnected: nothing reserved above the list.
      expect(all).toHaveLength(3);
      expect(find(view, (el) => (el.props as { role?: string }).role === 'status')).toHaveLength(0);
      const classes = find(view, (el) => el.type === 'div').map(
        (el) => (el.props as { className: string }).className,
      );
      for (const className of classes) expect(className).not.toMatch(/absolute|pt-|mt-|top-/);
    }
  });
});

describe('chatUnavailableView', () => {
  it('offers a Retry action wired to the connection restart', () => {
    const onRetry = vi.fn();
    const view = chatUnavailableView({ onRetry });
    // The shared EmptyState carries the copy and the Retry as its action.
    expect(view.type).toBe(EmptyState);
    expect((view.props as { title: string }).title).toBe("Couldn't load chats");
    // T11: no connection / network / offline wording anywhere in the panel.
    const copy = JSON.stringify(view.props, (_k, v: unknown) =>
      typeof v === 'function' ? undefined : v,
    );
    expect(copy).not.toMatch(/connect|network|offline/i);
    const action = (view.props as { action: ReactElement }).action;
    const buttons = find(
      action,
      (el) => (el.props as { children?: ReactNode }).children === 'Retry',
    );
    expect(buttons).toHaveLength(1);
    (buttons[0]?.props as { onClick: () => void }).onClick();
    expect(onRetry).toHaveBeenCalledOnce();
    // 44px touch target: every Button is 44 tall, no size prop needed.
    expect((buttons[0]?.props as { size?: string }).size).toBeUndefined();
  });
});
