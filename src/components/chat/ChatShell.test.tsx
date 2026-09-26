import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// The shell's import graph pulls the message factory, which imports the real
// agora-chat browser SDK. Mock it so importing the shell in node never touches
// browser globals or the network.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  ChatShell,
  ChatStatusBanner,
  ConnectionBanner,
  connectionBannerAction,
  connectionBannerText,
} from '@/components/chat/ChatShell';
import { ChatConnected } from '@/components/chat/ChatConnected';
import { ChatUnavailable, chatUnavailableView } from '@/components/chat/ChatUnavailable';

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

  it('keeps the Postgres chat surface (list, history, sending) mounted when chat is unavailable or kicked', () => {
    for (const status of ['unavailable', 'kicked'] as const) {
      const view = ChatShell({ status, client: null, workspaceId: 'w', currentUserId: 'u' });
      const connected = find(view, (el) => el.type === ChatConnected);
      expect(connected).toHaveLength(1);
      expect((connected[0]?.props as { client: unknown }).client).toBeNull();
      expect(find(view, (el) => el.type === ChatStatusBanner)).toHaveLength(1);
    }
  });

  it('keeps ChatConnected mounted under a banner while connecting and reconnecting', () => {
    for (const status of ['connecting', 'reconnecting'] as const) {
      const view = ChatShell({ status, client: null, workspaceId: 'w', currentUserId: 'u' });
      const connected = find(view, (el) => el.type === ChatConnected);
      expect(connected).toHaveLength(1);
      expect((connected[0]?.props as { status: string }).status).toBe(status);
      const banners = find(view, (el) => el.type === ChatStatusBanner);
      expect(banners).toHaveLength(1);
      expect(connectionBannerText(status)).not.toBe('');
    }
  });

  it('shows no banner once connected', () => {
    expect(connectionBannerText('connected')).toBe('');
    expect(ConnectionBanner({ status: 'connected' })).toBeNull();
    const view = ChatShell({
      status: 'connected',
      client: null,
      workspaceId: 'w',
      currentUserId: 'u',
    });
    expect(find(view, (el) => el.type === ChatConnected)).toHaveLength(1);
  });
});

describe('ConnectionBanner copy', () => {
  it('distinguishes reconnecting live delivery from chat unavailable and a kick', () => {
    expect(connectionBannerText('reconnecting')).toBe('Reconnecting live delivery');
    expect(connectionBannerText('unavailable')).toMatch(/^Chat unavailable/);
    expect(connectionBannerText('kicked')).toBe('Signed in on another device');
    expect(connectionBannerAction('reconnecting')).toBe('');
    for (const status of ['connecting', 'reconnecting', 'unavailable', 'kicked'] as const) {
      expect(connectionBannerText(status)).not.toMatch(/\u2014/);
    }
  });

  it('gives the kicked banner a 44px tap target that reconnects', () => {
    const onRetry = vi.fn();
    const view = ConnectionBanner({ status: 'kicked', onRetry });
    const buttons = find(view, (el) => el.type === 'button');
    expect(buttons).toHaveLength(1);
    const props = buttons[0]?.props as { onClick: () => void; className: string; children: string };
    expect(props.children).toBe('Reconnect');
    expect(props.className).toContain('min-h-[44px]');
    props.onClick();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(
      find(ConnectionBanner({ status: 'reconnecting', onRetry }), (el) => el.type === 'button'),
    ).toHaveLength(0);
  });
});

describe('chatUnavailableView', () => {
  it('offers a Retry action wired to the connection restart', () => {
    const onRetry = vi.fn();
    const view = chatUnavailableView({ onRetry });
    const buttons = find(view, (el) => (el.props as { children?: ReactNode }).children === 'Retry');
    expect(buttons).toHaveLength(1);
    (buttons[0]?.props as { onClick: () => void }).onClick();
    expect(onRetry).toHaveBeenCalledOnce();
    // 44px touch target via the lg button size.
    expect((buttons[0]?.props as { size: string }).size).toBe('lg');
  });
});
