import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BREAK_LONG_WORD, TEXT_ROLE, Text, textRole } from '@/components/ui/Text';

// Text holds its shape (11 Nov 2026): a word too long for its line breaks
// inside itself in body, heading and title; roles that truncate keep cutting.
describe('Text long words', () => {
  it('body, heading and title break a too-long word', () => {
    for (const role of ['body', 'heading', 'title'] as const) {
      expect(textRole(role).split(' '), role).toContain(BREAK_LONG_WORD);
    }
    expect(renderToStaticMarkup(<Text role="body">Supercalifragilistic</Text>)).toContain(
      BREAK_LONG_WORD,
    );
  });

  it('a truncating role or caller keeps truncating, with no break added', () => {
    expect(textRole('secondary')).toContain('truncate');
    expect(textRole('secondary')).not.toContain(BREAK_LONG_WORD);
    expect(textRole('heading', 'min-w-0 truncate')).toBe(`${TEXT_ROLE.heading} min-w-0 truncate`);
  });

  it('sizes and weights are unchanged', () => {
    expect(TEXT_ROLE.title).toBe('text-lg font-semibold');
    expect(TEXT_ROLE.heading).toBe('text-lg font-semibold');
    expect(TEXT_ROLE.body).toBe('text-base font-normal');
  });
});
