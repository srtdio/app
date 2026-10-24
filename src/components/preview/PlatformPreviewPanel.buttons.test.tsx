import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreviewChip } from '@/components/preview/PlatformPreviewPanel';

function chip(): string {
  return renderToStaticMarkup(<PreviewChip platform="instagram" onClick={() => undefined} />);
}

function classOf(html: string): string {
  const match = /<button[^>]*class="([^"]*)"/.exec(html);
  return match?.[1] ?? '';
}

describe('PreviewChip buttons', () => {
  it('renders one 44px, 8px-radius, 14/500 button', () => {
    const html = chip();
    expect(html.match(/<button/g)?.length).toBe(1);
    const cls = classOf(html).split(/\s+/);
    expect(cls).toContain('h-11');
    expect(cls).toContain('rounded-lg');
    expect(cls).toContain('text-base');
    expect(cls).toContain('font-medium');
    expect(html).toContain('Instagram preview');
    expect(html).toContain('type="button"');
  });

  it('has no old pill sizing anywhere', () => {
    const html = chip();
    for (const old of [
      'h-7',
      'h-9',
      'h-12',
      'rounded-md',
      'rounded-full',
      'text-sm',
      'font-semibold',
    ]) {
      expect(html.split(/[\s"]/)).not.toContain(old);
    }
  });
});
