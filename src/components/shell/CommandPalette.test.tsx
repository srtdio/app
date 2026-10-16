import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// The unit env is `node` with no DOM, so CommandPalette is invoked as a plain
// function and its element tree walked (the Topbar test style). Hooks are
// shimmed to pure values so the body runs without a renderer.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (init: unknown) => [
      typeof init === 'function' ? (init as () => unknown)() : init,
      () => {},
    ],
    useEffect: () => {},
    useMemo: (factory: () => unknown) => factory(),
    useRef: (init: unknown) => ({ current: init }),
  };
});

vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }));

import { CommandPalette } from '@/components/shell/CommandPalette';

function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

function texts(node: ReactNode, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((child) => texts(child, out));
    return out;
  }
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (!isElement(node)) return out;
  texts((node.props as { children?: ReactNode }).children, out);
  return out;
}

describe('CommandPalette', () => {
  it('lists the Go to commands and no New post / New brief actions', () => {
    const tree = CommandPalette({ open: true, onClose: () => {} });
    const all = texts(tree);
    expect(all).toContain('Pipeline');
    expect(all).toContain('Briefs');
    expect(all).not.toContain('New post');
    expect(all).not.toContain('New brief');
    expect(all).not.toContain('Actions');
  });
});
