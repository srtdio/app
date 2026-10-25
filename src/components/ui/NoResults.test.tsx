// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NoResults, noResultsCopy } from '@/components/ui/NoResults';

function markup(query: string | undefined, filtersActive: boolean): string {
  return renderToStaticMarkup(
    <NoResults
      {...(query !== undefined ? { query } : {})}
      filtersActive={filtersActive}
      onClear={() => undefined}
    />,
  );
}

describe('NoResults', () => {
  it('query only: another word, Clear search', () => {
    expect(noResultsCopy('zzqxv', false)).toEqual({
      title: 'Try another word for "zzqxv".',
      action: 'Clear search',
    });
    const html = markup('zzqxv', false);
    expect(html).toContain('Try another word for &quot;zzqxv&quot;.');
    expect(html).toContain('Clear search');
  });

  it('filters only: fewer filters, Clear filters', () => {
    expect(noResultsCopy(undefined, true)).toEqual({
      title: 'Try fewer filters.',
      action: 'Clear filters',
    });
    expect(noResultsCopy('   ', true).action).toBe('Clear filters');
    const html = markup(undefined, true);
    expect(html).toContain('Try fewer filters.');
    expect(html).toContain('Clear filters');
  });

  it('both: another word or fewer filters, Clear all', () => {
    expect(noResultsCopy('zzqxv', true)).toEqual({
      title: 'Try another word or fewer filters.',
      action: 'Clear all',
    });
    const html = markup('zzqxv', true);
    expect(html).toContain('Try another word or fewer filters.');
    expect(html).toContain('Clear all');
  });
});
