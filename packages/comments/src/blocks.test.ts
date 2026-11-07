import { describe, expect, it } from 'vitest';
import {
  blockAt,
  continueBlock,
  hasBlocks,
  linkMarkup,
  normalizeLinkUrl,
  parseBlocks,
  splitLinks,
  stylesAt,
  toggleBlock,
} from './blocks';
import { parseFormat, stripFormat } from './format';

const UUID = '0b7c8a1e-1234-4abc-8def-0123456789ab';

describe('parseBlocks', () => {
  it('plain text is one paragraph', () => {
    expect(parseBlocks('hi\nthere')).toEqual([{ kind: 'para', text: 'hi\nthere' }]);
  });

  it('numbered list starts at the first number', () => {
    expect(parseBlocks('3. a\n4. b')).toEqual([{ kind: 'ol', start: 3, items: ['a', 'b'] }]);
  });

  it('bullets, quote and paragraphs in order', () => {
    expect(parseBlocks('Intro\n- a\n- b\n> q1\n> q2\nEnd')).toEqual([
      { kind: 'para', text: 'Intro' },
      { kind: 'ul', items: ['a', 'b'] },
      { kind: 'quote', text: 'q1\nq2' },
      { kind: 'para', text: 'End' },
    ]);
  });

  it('a bare ">" is an empty quote line', () => {
    expect(parseBlocks('> a\n>\n> b')).toEqual([{ kind: 'quote', text: 'a\n\nb' }]);
  });

  it('needs the space after the marker', () => {
    expect(parseBlocks('1.5 kg\n-a\n2.0')).toEqual([{ kind: 'para', text: '1.5 kg\n-a\n2.0' }]);
  });

  it('a list item keeps inline styles, mentions and links', () => {
    const [b] = parseBlocks(`- *bold* @[${UUID}] [site](https://x.com)`);
    expect(b).toEqual({ kind: 'ul', items: [`*bold* @[${UUID}] [site](https://x.com)`] });
  });

  it('is linear on long input (no backtracking)', () => {
    const long = `${'- '.repeat(20000)}\n${'['.repeat(50000)}](${'h'.repeat(5000)}`;
    const t0 = Date.now();
    parseBlocks(long);
    splitLinks(long);
    parseFormat(long);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('memoises per body', () => {
    expect(parseBlocks('- a')).toBe(parseBlocks('- a'));
  });

  it('hasBlocks', () => {
    expect(hasBlocks('plain')).toBe(false);
    expect(hasBlocks('a\n1. b')).toBe(true);
    expect(hasBlocks('> q')).toBe(true);
  });
});

describe('links', () => {
  it('splits [text](url)', () => {
    expect(splitLinks('see [the brief](https://x.com/b) now')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'the brief', url: 'https://x.com/b' },
      { kind: 'text', text: ' now' },
    ]);
  });

  it('non-http stays text', () => {
    expect(splitLinks('[x](javascript:alert(1))')).toEqual([
      { kind: 'text', text: '[x](javascript:alert(1))' },
    ]);
  });

  it('is a protected span: markers never pair across it', () => {
    expect(parseFormat('*a [b*](https://x.com)')).toEqual([
      { text: '*a [b*](https://x.com)', styles: [] },
    ]);
    expect(parseFormat('*[b](https://x.com)*')).toEqual([
      { text: '[b](https://x.com)', styles: ['bold'] },
    ]);
  });

  it('normalizeLinkUrl', () => {
    expect(normalizeLinkUrl('https://a.com/x')).toBe('https://a.com/x');
    expect(normalizeLinkUrl('a.com/x?y=1')).toBe('https://a.com/x?y=1');
    expect(normalizeLinkUrl('localhost:3000')).toBe(null);
    expect(normalizeLinkUrl('a.com:8080/p')).toBe('https://a.com:8080/p');
    expect(normalizeLinkUrl('javascript:alert(1)')).toBe(null);
    expect(normalizeLinkUrl('mailto:a@b.com')).toBe(null);
    expect(normalizeLinkUrl('two words')).toBe(null);
    expect(normalizeLinkUrl('')).toBe(null);
  });

  it('linkMarkup', () => {
    expect(linkMarkup('Brief', 'https://a.com')).toBe('[Brief](https://a.com)');
    expect(linkMarkup('', 'https://a.com')).toBe('[a.com](https://a.com)');
    expect(linkMarkup('a]b', 'https://a.com')).toBe('[a b](https://a.com)');
  });
});

describe('stripFormat display text', () => {
  it('links show their text, quote prefix goes, bullets become •, numbers stay', () => {
    expect(stripFormat('1. Swap the *cover*\n- [brief](https://x.com)\n> said')).toBe(
      '1. Swap the cover\n• brief\nsaid',
    );
  });
});

describe('toggleBlock', () => {
  it('adds a numbered prefix to the caret line', () => {
    expect(toggleBlock('a\nb', 3, 3, 'ol')).toEqual({
      from: 2,
      to: 3,
      insert: '1. b',
      selStart: 6,
      selEnd: 6,
    });
  });

  it('numbers every selected line, then removes them', () => {
    const on = toggleBlock('a\nb\nc', 0, 5, 'ol');
    expect(on.insert).toBe('1. a\n2. b\n3. c');
    const v = on.insert;
    expect(toggleBlock(v, 0, v.length, 'ol').insert).toBe('a\nb\nc');
  });

  it('swaps another kind', () => {
    expect(toggleBlock('- a', 3, 3, 'quote').insert).toBe('> a');
  });

  it('quote toggles off', () => {
    expect(toggleBlock('> a', 3, 3, 'quote')).toMatchObject({ insert: 'a', selStart: 1 });
  });
});

describe('continueBlock', () => {
  it('continues numbered, bullet and quote', () => {
    expect(continueBlock('1. a', 4)).toMatchObject({ insert: '\n2. ', selStart: 8 });
    expect(continueBlock('- a', 3)).toMatchObject({ insert: '\n- ' });
    expect(continueBlock('> a', 3)).toMatchObject({ insert: '\n> ' });
  });

  it('an empty item ends the list', () => {
    expect(continueBlock('1. a\n2. ', 8)).toEqual({
      from: 5,
      to: 8,
      insert: '',
      selStart: 5,
      selEnd: 5,
    });
  });

  it('plain lines return null', () => {
    expect(continueBlock('hello', 5)).toBe(null);
  });
});

describe('blockAt / stylesAt', () => {
  it('blockAt', () => {
    expect(blockAt('x\n- a', 4)).toBe('ul');
    expect(blockAt('x\n- a', 1)).toBe(null);
  });

  it('stylesAt reports inline styles and links', () => {
    const v = 'a *bold* [l](https://x.com)';
    expect(stylesAt(v, 5, 5).has('bold')).toBe(true);
    expect(stylesAt(v, 1, 1).has('bold')).toBe(false);
    expect(stylesAt(v, 11, 11).has('link')).toBe(true);
  });
});
