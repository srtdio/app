import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  REACTION_BADGE_CLASS,
  REACTION_BADGE_HIT,
  ReactionBadge,
} from '@/components/ui/ReactionBadge';

function render(): string {
  return renderToStaticMarkup(
    <ReactionBadge label="2 reactions: 👍 🎉" onClick={() => {}}>
      <span>👍🎉</span>
    </ReactionBadge>,
  );
}

describe('ReactionBadge', () => {
  it('is a labelled button carrying the badge marker', () => {
    const html = render();
    expect(html).toMatch(/^<button type="button" data-reaction-badge=""/);
    expect(html).toContain('aria-label="2 reactions: 👍 🎉"');
    expect(html).toContain('👍🎉');
  });

  it('keeps its 3px hang and drawn size', () => {
    const cls = REACTION_BADGE_CLASS.split(' ');
    const hang = ['absolute', 'top-[calc(100%-3px)]', 'rounded-full', 'px-1.5', 'py-0.5'];
    expect(cls).toEqual(expect.arrayContaining(hang));
    expect(cls.some((c) => /^(min-)?h-/.test(c))).toBe(false);
  });

  it('adds a ::before hit area of at least 44x44 around the drawn badge', () => {
    const html = render();
    for (const c of ['before:absolute', 'before:-inset-x-2', 'before:-inset-y-3.5']) {
      expect(REACTION_BADGE_HIT.split(' ')).toContain(c);
      expect(html).toContain(c);
    }
    // The markup escapes the quotes in content-['']; the class list holds it.
    expect(REACTION_BADGE_HIT.split(' ')).toContain("before:content-['']");
  });
});
