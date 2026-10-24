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

  it('adds a centred 44x44 ::before hit area', () => {
    const html = render();
    for (const c of [
      'before:absolute',
      'before:h-11',
      'before:w-11',
      'before:left-1/2',
      'before:top-1/2',
      'before:-translate-x-1/2',
      'before:-translate-y-1/2',
      "before:content-['']",
    ]) {
      expect(REACTION_BADGE_HIT.split(' ')).toContain(c);
      // The markup escapes the quotes in content-['']; the class list holds it.
      if (!c.includes("'")) expect(html).toContain(c);
    }
  });
});
