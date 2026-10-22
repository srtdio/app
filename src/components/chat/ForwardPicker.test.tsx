import { describe, expect, it, vi } from 'vitest';

// The Sheet portals to document.body; static markup renders its body in place.
vi.mock('@/components/ui/Sheet', () => ({
  Sheet: (props: { open: boolean; children: ReactNode }) => (props.open ? props.children : null),
}));
vi.mock('@/components/chat/ChatStoreProvider', () => ({
  useChatStore: () => ({ state: {} }),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ show: () => undefined }) }));
vi.mock('@/lib/chat/use-history-step', () => ({ useHistoryStep: () => undefined }));

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ForwardPicker } from '@/components/chat/ForwardPicker';

describe('ForwardPicker zero state', () => {
  it('empty query and no chats reads "No chats yet"', () => {
    const html = renderToStaticMarkup(
      <ForwardPicker
        open
        onClose={() => undefined}
        channels={[]}
        onSend={async () => ({ ok: true })}
        onSent={() => undefined}
      />,
    );
    expect(html).toContain('No chats yet');
    expect(html).not.toContain('No matches');
    expect(html).not.toContain('No chats called');
  });
});
