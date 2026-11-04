import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The component import graph pulls the agora-chat browser SDK; mock it so the
// pure helpers import in node.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ThreadTopStrip, threadOpeningSkeleton } from '@/components/chat/MessageThread';

// iOS Safari samples a solid fixed element at the top edge for its bar tint.
// A phone chat thread (locked, Topbar hidden) carries one strip, the status
// bar inset tall, in the header's fill; laptop never renders it.

const source = readFileSync(
  fileURLToPath(new URL('../MessageThread.tsx', import.meta.url)),
  'utf8',
);

describe('ThreadTopStrip', () => {
  it('phone: one solid, fixed, inert, hidden strip the inset tall in bg-panel', () => {
    const html = renderToStaticMarkup(<ThreadTopStrip layout="touch" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-thread-top-strip=""');
    const cls = /class="([^"]*)"/.exec(html)?.[1]?.split(/\s+/) ?? [];
    for (const c of [
      'pointer-events-none',
      'fixed',
      'inset-x-0',
      'top-0',
      'z-0',
      'h-[env(safe-area-inset-top,0px)]',
      'bg-panel',
    ])
      expect(cls).toContain(c);
    // Same surface as the header: no lit-* of its own, no blur, no opacity, no shadow.
    expect(cls.some((c) => /^(lit-|backdrop-|opacity-|shadow|bg-panel\/)/.test(c))).toBe(false);
  });

  it('laptop: nothing', () => {
    expect(renderToStaticMarkup(<ThreadTopStrip layout="laptop" />)).toBe('');
  });

  it('the opening skeleton carries it on phone only', () => {
    expect(renderToStaticMarkup(threadOpeningSkeleton('touch'))).toContain('data-thread-top-strip');
    expect(renderToStaticMarkup(threadOpeningSkeleton('laptop'))).not.toContain(
      'data-thread-top-strip',
    );
  });

  it('the live thread root renders it once, beside its header', () => {
    expect(source).toMatch(
      /<div ref=\{rootRef\} className="relative flex h-full flex-col bg-bg">\s*<ThreadTopStrip layout=\{layout\} \/>/,
    );
    expect(source.match(/<ThreadTopStrip /g)).toHaveLength(2);
  });
});

describe('homepage strip (home.css)', () => {
  const css = readFileSync(fileURLToPath(new URL('../../home/home.css', import.meta.url)), 'utf8');
  const block = /\.home::before \{([^}]*)\}/.exec(css)?.[1] ?? '';

  it('is a solid fixed --panel strip the inset tall, inert, no blur', () => {
    expect(block).toContain('position: fixed;');
    expect(block).toContain('top: 0;');
    expect(block).toContain('height: env(safe-area-inset-top, 0px);');
    expect(block).toContain('background: var(--panel);');
    expect(block).toContain('pointer-events: none;');
    expect(block).not.toMatch(/backdrop-filter|opacity|blur|rgb\(/);
  });

  it('the frosted .top keeps its blur', () => {
    expect(css).toMatch(/\.home \.top \{[^}]*backdrop-filter: blur\(14px\);/);
  });
});
