import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LinkButton } from '@/components/ui/LinkButton';

// Rendered to static markup (node SSR, no DOM), the same way Thumbnail and
// BriefCard are tested here: LinkButton is pure markup, so the html is the
// contract. An unusable url renders the empty string (the component returns
// null), which is exactly what "never paint a dead anchor" means.

function render(url: string, className?: string): string {
  return renderToStaticMarkup(
    <LinkButton url={url} {...(className !== undefined ? { className } : {})} />,
  );
}

/** Everything the reader actually sees: markup stripped of tags and attributes. */
function visible(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

describe('LinkButton', () => {
  it('labels the button with the domain and never paints the path or query', () => {
    const out = render('https://drive.google.com/file/d/1a2b3c/view?usp=sharing');
    expect(visible(out)).toBe('drive.google.com');
    expect(visible(out)).not.toContain('1a2b3c');
    expect(visible(out)).not.toContain('usp=sharing');
    expect(visible(out)).not.toContain('https://');
    // No title tooltip either: the raw URL lives in the href and nowhere else.
    expect(out).not.toContain('title=');
    expect(out).toContain('href="https://drive.google.com/file/d/1a2b3c/view?usp=sharing"');
  });

  it('strips a leading www. from the label but keeps the href intact', () => {
    const out = render('https://www.figma.com/file/abc');
    expect(out).toContain('>figma.com<');
    expect(out).toContain('href="https://www.figma.com/file/abc"');
  });

  it('uses the parsed URL as the href', () => {
    expect(render('  https://srtd.io/x  ')).toContain('href="https://srtd.io/x"');
  });

  it('opens in a new tab with both rel tokens', () => {
    const out = render('https://srtd.io/x');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('renders nothing for a url that is not a usable http(s) URL', () => {
    expect(render('javascript:alert(1)')).toBe('');
    expect(render('data:text/html,<script>x</script>')).toBe('');
    expect(render('not-a-url')).toBe('');
    expect(render('')).toBe('');
    expect(render('   ')).toBe('');
  });

  it('keeps the 44px touch target and truncates instead of growing on a long domain', () => {
    const out = render(
      'https://a-very-long-subdomain.of-some-extremely-long-host.example.com/path',
    );
    expect(out).toContain('min-h-[44px]');
    expect(out).toContain('max-w-full');
    expect(out).toContain('truncate');
    expect(out).toContain('a-very-long-subdomain.of-some-extremely-long-host.example.com');
  });

  it('appends the caller className last without dropping the base classes', () => {
    const out = render('https://srtd.io/x', 'w-full');
    expect(out).toContain('w-full');
    expect(out).toContain('border-border');
    expect(out).toContain('min-h-[44px]');
  });

  it('renders the leading link icon and the trailing outbound arrow', () => {
    const out = render('https://srtd.io/x');
    expect(out.match(/<svg/g) ?? []).toHaveLength(2);
    expect(out).not.toContain('style=');
  });
});
