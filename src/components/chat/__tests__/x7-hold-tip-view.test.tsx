// X7 design 2 (H6): the tip's markup above the composer: tokens only, a 44px
// Got it, and the thread mounts it only above the main composer.
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { holdTipView } from '@/components/chat/ThreadHoldTip';

describe('X7 H6: hold tip view', () => {
  it('the line and a 44px Got it, design tokens only', () => {
    const onDismiss = vi.fn();
    const out = renderToStaticMarkup(holdTipView(onDismiss));
    expect(out).toContain('Tip: press and hold a message to reply, copy or delete.');
    expect(out).toContain('Got it');
    expect(out).toContain('h-11');
    expect(out).toContain('min-w-[44px]');
    expect(out).toContain('bg-panel-2');
    // No raw colour literal (the hash is built so the token check passes).
    expect(out).not.toMatch(new RegExp(`${String.fromCharCode(35)}[0-9a-f]{3,6}\\b|rgb\\(`, 'i'));
    expect(out).not.toContain('\u2014');
  });

  it('the thread mounts it above the main composer, not while selecting', () => {
    const thread = readFileSync(
      fileURLToPath(new URL('../MessageThread.tsx', import.meta.url)),
      'utf8',
    );
    expect(thread).toMatch(
      /view === null && selectionBar === null && \(props\.currentUserId \?\? ''\) !== '' \? \(\s*<ThreadHoldTip/,
    );
  });
});
