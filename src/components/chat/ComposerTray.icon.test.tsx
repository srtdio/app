// Regression: the tray opener is a plus, never the paperclip. Closed it shows
// IconPlus (open, the same plus turned 45deg into an X); the label is unchanged.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerTray } from '@/components/chat/ComposerTray';
import { ICON_SIZE, IconPaperclip, IconPlus } from '@/components/ui/icons';

/** The inner markup of the opener's icon span. */
function iconSpan(html: string): string {
  const m = /<span[^>]*data-plus-icon=""[^>]*>([\s\S]*?)<\/span>/.exec(html);
  return m?.[1] ?? '';
}

describe('ComposerTray opener icon', () => {
  const html = renderToStaticMarkup(<ComposerTray layout="touch" onPick={() => undefined} />);

  it('closed state renders IconPlus', () => {
    const plus = renderToStaticMarkup(<IconPlus size={ICON_SIZE.control} />);
    const clip = renderToStaticMarkup(<IconPaperclip size={ICON_SIZE.control} />);
    expect(iconSpan(html)).toBe(plus);
    expect(iconSpan(html)).not.toBe(clip);
    expect(html).toContain('aria-label="Add attachment"');
  });

  it('the source no longer imports IconPaperclip and the tray uses the motion module', () => {
    const src = readFileSync(fileURLToPath(new URL('./ComposerTray.tsx', import.meta.url)), 'utf8');
    expect(src).not.toContain('IconPaperclip');
    // The plus turns 45deg into the X (mv-turn); the tray slides above the composer.
    expect(src).toContain("cn('flex', MOVE_CLASS.turn, open && 'rotate-45')");
    expect(src).toContain("stripIn(el, 'above-composer', TRAY_SLIDE_PX)");
    expect(src).not.toMatch(/duration-|transition-|\bease-out\b/);
  });
});
