import { describe, expect, it, vi } from 'vitest';

// The shell's import graph pulls the message factory, which imports the real
// agora-chat browser SDK. Mock it so importing the shell in node never touches
// browser globals or the network.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { ChatShell } from '@/components/chat/ChatShell';
import { ChatUnavailable } from '@/components/chat/ChatUnavailable';

describe('ChatShell status dispatch', () => {
  it('renders the unavailable panel and never throws when unavailable', () => {
    const render = () =>
      ChatShell({ status: 'unavailable', client: null, workspaceId: 'w', currentUserId: 'u' });
    expect(render).not.toThrow();
    expect(render().type).toBe(ChatUnavailable);
  });

  it('renders a loading state while connecting', () => {
    const view = ChatShell({
      status: 'connecting',
      client: null,
      workspaceId: 'w',
      currentUserId: 'u',
    });
    expect(view.type).toBe('div');
  });
});
