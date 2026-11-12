import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  bodyLinkClass,
  FORMAT_OL_CLASS,
  FORMAT_QUOTE_CLASS,
  FORMAT_UL_CLASS,
  renderMessageBody,
  renderRich,
  withTextLinks,
} from '@/components/chat/message-body';

const read = (f: string): string =>
  readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8');
const ORIGIN = 'https://app.example';
const html = (body: string, mine = false): string =>
  renderToStaticMarkup(<MemoryRouter>{renderMessageBody(body, mine, ORIGIN)}</MemoryRouter>);

describe('message-body (U2: moved out of MessageThread, unchanged)', () => {
  it('external links open in a new tab, shown without the scheme, accent on a peer bubble', () => {
    const out = html('see https://example.com/a?b=1 now');
    expect(out).toContain('href="https://example.com/a?b=1"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('data-msg-link=""');
    expect(out).toContain('>example.com/a?b=1<');
    expect(out).toContain(`class="${bodyLinkClass(false)}"`);
    expect(bodyLinkClass(false)).toBe('underline text-accent');
    expect(bodyLinkClass(true)).toBe('underline text-accent-fg');
  });

  it('app links route in-app; plain text stays a string', () => {
    expect(html(`${ORIGIN}/p/gbl-142`)).not.toContain('target="_blank"');
    expect(renderMessageBody('no links here', false, ORIGIN)).toEqual(['no links here']);
  });

  it('MessageThread renders bodies through this file and keeps its exports; the Plan item screen never imports the thread', () => {
    const thread = read('MessageThread.tsx');
    expect(thread).toMatch(/from '@\/components\/chat\/message-body';/);
    expect(thread).not.toContain('export function renderMessageBody');
    expect(thread).toContain('export { bodyLinkClass, markSearchWords, renderMessageBody };');
    const item = read('PlanItemScreen.tsx');
    expect(item).toContain("import { renderMessageBody } from '@/components/chat/message-body';");
    expect(item).toContain('{renderMessageBody(description, false)}');
    expect(item).not.toMatch(/from '@\/components\/chat\/MessageThread'/);
    // 12 Nov 2026: the comment box is chat's Composer.
    expect(item).toMatch(/from '@\/components\/chat\/Composer'/);
  });
});

describe('message-body: WhatsApp formatting is the outer layer', () => {
  it('styles words and hides markers', () => {
    const out = html('*b* _i_ ~s~ +u+ ```m```');
    expect(out).toContain('<strong class="font-semibold">b</strong>');
    expect(out).toContain('<em class="italic">i</em>');
    expect(out).toContain('<s class="line-through">s</s>');
    expect(out).toContain('<u class="underline decoration-current">u</u>');
    expect(out).toContain('<code class="rounded-sm bg-panel-2 font-mono">m</code>');
    expect(out).not.toMatch(/[*~+`]|_i_/);
  });

  it('a styled span contains a link: bold link, closing star not in the url', () => {
    const out = html('*see https://x.com*');
    expect(out).toMatch(/<strong class="font-semibold">see <a [^>]*href="https:\/\/x.com"/);
    expect(out).not.toContain('x.com*');
  });

  it('mono is literal: a link inside stays plain text', () => {
    const out = html('```https://x.com/a_b```');
    expect(out).not.toContain('<a ');
    expect(out).toContain('https://x.com/a_b');
  });

  it('formatted underline keeps the body colour (never reads as a link)', () => {
    expect(html('+u+')).not.toContain('text-accent');
  });

  it('search marks still run inside a styled segment', () => {
    const out = renderToStaticMarkup(
      <MemoryRouter>
        {renderMessageBody('*diwali lights*', false, ORIGIN, ['diwali'])}
      </MemoryRouter>,
    );
    expect(out).toMatch(/<strong[^>]*><mark/);
  });

  it('unformatted bodies render exactly as before', () => {
    expect(renderMessageBody('snake_case_name 2*3*4', false, ORIGIN)).toEqual([
      'snake_case_name 2*3*4',
    ]);
  });
});

describe('message-body: Slack blocks are the outermost layer', () => {
  it('consecutive "N. " lines are one ordered list starting at the first N', () => {
    const out = html('3. three\n4. four');
    expect(out).toContain(
      `<ol start="3" class="${FORMAT_OL_CLASS}"><li>three</li><li>four</li></ol>`,
    );
    expect(out).not.toContain('3. ');
  });

  it('"- " lines are one bullet list (disc markers, no dash shown)', () => {
    const out = html('- one\n- two');
    expect(out).toContain(`<ul class="${FORMAT_UL_CLASS}"><li>one</li><li>two</li></ul>`);
    expect(FORMAT_UL_CLASS).toContain('list-disc');
    expect(FORMAT_OL_CLASS).toContain('list-decimal');
    expect(out).not.toContain('- ');
  });

  it('"> " lines are one quote with the faded bar class; text keeps its ink', () => {
    const out = html('> first\n> second');
    expect(out).toContain(`<blockquote class="${FORMAT_QUOTE_CLASS}">first\nsecond</blockquote>`);
    expect(FORMAT_QUOTE_CLASS).toContain('fmt-quote');
    expect(FORMAT_QUOTE_CLASS).not.toMatch(/text-|opacity/);
    expect(out).not.toContain('&gt;');
  });

  it('paragraphs around blocks are block spans, in order', () => {
    const out = html('intro\n- a\noutro');
    expect(out).toMatch(
      /<span class="block">intro<\/span><ul[^>]*><li>a<\/li><\/ul><span class="block">outro<\/span>/,
    );
  });

  it('inline styles, links and search marks work inside items and quotes', () => {
    const out = renderToStaticMarkup(
      <MemoryRouter>
        {renderMessageBody('- *bold* https://x.com\n> _lit_ diwali', false, ORIGIN, ['diwali'])}
      </MemoryRouter>,
    );
    expect(out).toMatch(
      /<li><strong class="font-semibold">bold<\/strong> <a [^>]*href="https:\/\/x.com"/,
    );
    expect(out).toMatch(/<blockquote[^>]*><em class="italic">lit<\/em> <mark/);
  });

  it('mono stays literal inside a list item', () => {
    const out = html('- ```*not bold*```');
    expect(out).toContain(
      '<li><code class="rounded-sm bg-panel-2 font-mono">*not bold*</code></li>',
    );
  });

  it('a body with no blocks renders exactly as renderFormatted did (fast path)', () => {
    expect(renderMessageBody('plain words', false, ORIGIN)).toEqual(['plain words']);
    expect(renderMessageBody('a-b >c 1.5 x', false, ORIGIN)).toEqual(['a-b >c 1.5 x']);
    expect(renderRich('no blocks', (t) => [t])).toEqual(['no blocks']);
  });

  it('a mid-line "- " or "1. " is not a block', () => {
    expect(html('buy 1. eggs - milk')).not.toMatch(/<ol|<ul/);
  });
});

describe('message-body: [text](url) links', () => {
  it('shows its text, underlined, opening exactly like a pasted url', () => {
    const out = html('see [the deck](https://example.com/d) now');
    expect(out).toContain('href="https://example.com/d"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('data-msg-link=""');
    expect(out).toContain(`class="${bodyLinkClass(false)}">the deck</a>`);
    expect(out).not.toContain('](');
    expect(out).not.toContain('>example.com/d<');
  });

  it('the own bubble uses the on-bubble ink', () => {
    expect(html('[x](https://example.com)', true)).toContain(`class="${bodyLinkClass(true)}"`);
  });

  it('a link to this app routes in-app', () => {
    const out = html(`[the post](${ORIGIN}/p/gbl-142)`);
    expect(out).toContain('href="/p/gbl-142"');
    expect(out).not.toContain('target="_blank"');
    expect(out).toContain('>the post</a>');
  });

  it('an unsafe url opens the check sheet, never the site', () => {
    const out = html('[admin](http://192.168.1.1/admin)');
    expect(out).toContain('data-unsafe-link=""');
    expect(out).not.toContain('href="http://192.168.1.1');
    expect(out).toContain('admin');
  });

  it('link text renders its inline styles; outer styles wrap the link', () => {
    expect(html('[*big* news](https://example.com)')).toMatch(
      /<a [^>]*><strong class="font-semibold">big<\/strong> news<\/a>/,
    );
    expect(html('*see [it](https://example.com)*')).toMatch(
      /<strong class="font-semibold">see <a /,
    );
  });

  it('works inside list items and quotes', () => {
    const out = html('1. [one](https://example.com/1)\n> [two](https://example.com/2)');
    expect(out).toMatch(/<li><a [^>]*href="https:\/\/example.com\/1"[^>]*>one<\/a><\/li>/);
    expect(out).toMatch(/<blockquote[^>]*><a [^>]*href="https:\/\/example.com\/2"/);
  });

  it('withTextLinks hands only the text between links to the inner renderer', () => {
    const seen: string[] = [];
    const inner = withTextLinks(
      (t) => {
        seen.push(t);
        return [t];
      },
      false,
      ORIGIN,
    );
    const out = renderToStaticMarkup(
      <MemoryRouter>{renderRich('a [b](https://example.com) c', inner)}</MemoryRouter>,
    );
    expect(seen).toEqual(['a ', ' c']);
    expect(out).toContain('>b</a>');
  });

  it('long hostile input renders in linear time (no regex backtracking)', () => {
    const body = `${'- '.repeat(5000)}\n${'1. ['.repeat(5000)}\n> ${'*_~+'.repeat(5000)}](https://x`;
    const t0 = Date.now();
    html(body);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
