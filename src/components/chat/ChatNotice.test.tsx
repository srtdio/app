import { describe, expect, it } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { ChatNotice } from '@/components/chat/ChatNotice';

// Collect all string content from a React element tree without a DOM. The chat
// notices are hook-free, so calling them directly returns an inspectable tree.
function textOf(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

describe('ChatNotice', () => {
  it('renders the unavailable panel and never throws', () => {
    let element: ReactElement | null = null;
    expect(() => {
      element = ChatNotice({ variant: 'unavailable' });
    }).not.toThrow();
    expect(textOf(element)).toContain('Chat unavailable');
  });

  it('renders a loading state while connecting', () => {
    expect(textOf(ChatNotice({ variant: 'loading' }))).toContain('Connecting to chat');
  });
});
