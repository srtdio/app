import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CommentLinkCard, renderCommentBody } from '@/components/comments/Comments';

const html = (node: React.ReactNode): string => renderToStaticMarkup(<>{node}</>);

describe('comment link card', () => {
  it('the first external link becomes the card; later links stay LinkButtons', () => {
    const body = 'like this https://youtube.com/watch?v=1 and https://canva.com/d';
    const text = html(renderCommentBody(body, () => null, [], 'https://youtube.com/watch?v=1'));
    expect(text).not.toContain('youtube.com');
    expect(text).toContain('href="https://canva.com/d"');
    const card = html(<CommentLinkCard body={body} />);
    expect(card).toContain('data-link-card=""');
    expect(card).toContain('youtube.com');
    expect(card).not.toContain('canva.com');
  });

  it('no card and no X for a comment without a link', () => {
    expect(html(<CommentLinkCard body="Noted. Brand colours from here" />)).toBe('');
    expect(html(<CommentLinkCard body="https://g00gle-docs-share.top/x" />)).toContain(
      'data-card-type="unsafe"',
    );
    expect(html(<CommentLinkCard body="https://example.com/x" />)).not.toContain('Remove preview');
  });

  it('a later unsafe link is a warning button, not a live link', () => {
    const body = 'see https://a.com/x and http://192.168.1.1/admin';
    const text = html(renderCommentBody(body, () => null, [], 'https://a.com/x'));
    expect(text).toContain('data-unsafe-link=""');
    expect(text).not.toContain('href="http://192.168.1.1/admin"');
  });

  it('without a card url every link stays a LinkButton (unchanged)', () => {
    const text = html(renderCommentBody('go https://a.com/x', () => null));
    expect(text).toContain('href="https://a.com/x"');
  });

  it('a [text](url) link shows its text as an underlined link, never the raw markup', () => {
    const text = html(
      renderCommentBody('see [the deck](https://a.com/d) and https://b.com/x', () => null),
    );
    expect(text).toMatch(/<a [^>]*href="https:\/\/a.com\/d"[^>]*>the deck<\/a>/);
    expect(text).toContain('underline text-accent');
    expect(text).not.toContain('](');
    expect(text).toContain('href="https://b.com/x"');
  });

  it('lists and quotes render as blocks in a comment', () => {
    const text = html(renderCommentBody('- one\n- two\n> said', () => null));
    expect(text).toMatch(/<ul[^>]*><li>one<\/li><li>two<\/li><\/ul>/);
    expect(text).toMatch(/<blockquote[^>]*>said<\/blockquote>/);
  });

  it('the card picks a [text](url) link like a pasted one', () => {
    const text = html(<CommentLinkCard body="read [this](https://c.com/a)" />);
    expect(text).not.toBe('');
  });
});
