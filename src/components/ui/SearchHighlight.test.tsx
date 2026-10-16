import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { Highlight, highlightText, useSearchWords } from '@/components/ui/SearchHighlight';

function Probe() {
  const words = useSearchWords();
  return <p>{highlightText('Diwali lights for @diwali.team', words)}</p>;
}

describe('Highlight', () => {
  it('colours every matched word with the accent token, @username included', () => {
    const html = renderToStaticMarkup(
      <Highlight text="Diwali lights for @diwali.team" words={['diwali']} />,
    );
    expect(html.match(/data-search-match/g)).toHaveLength(2);
    expect(html).toContain('text-accent');
    // Tokens only: no hardcoded colour.
    expect(html).not.toMatch(/#[0-9a-f]{3,6}|rgb\(/i);
  });
  it('a mention tint keeps the match readable on accent text (light and dark tokens)', () => {
    const html = renderToStaticMarkup(<Highlight text="@diwali" words={['diwali']} tone="tint" />);
    expect(html).toContain('bg-accent-soft');
  });
  it('no words: the plain text, unchanged', () => {
    expect(highlightText('Diwali', [])).toBe('Diwali');
  });
});

describe('useSearchWords', () => {
  it('reads the link term until the screen is left', () => {
    const on = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/p/gbl-1?q=diwali']}>
        <Probe />
      </MemoryRouter>,
    );
    expect(on).toContain('data-search-match');
    const left = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/p/gbl-1']}>
        <Probe />
      </MemoryRouter>,
    );
    expect(left).not.toContain('data-search-match');
  });
  it('outside a router: no words, never a throw', () => {
    expect(renderToStaticMarkup(<Probe />)).not.toContain('data-search-match');
  });
});
