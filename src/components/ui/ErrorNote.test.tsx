import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ErrorNote } from '@/components/ui/ErrorNote';
import { ErrorNote as BarrelErrorNote } from '@/components/ui';

describe('ErrorNote', () => {
  it('renders the one bad-toned alert box around its copy', () => {
    const html = renderToStaticMarkup(<ErrorNote>Couldn't save. Try again.</ErrorNote>);
    expect(html).toBe(
      '<div role="alert" class="rounded-lg border border-bad bg-bad-soft px-3 py-2 text-base text-bad">Couldn&#x27;t save. Try again.</div>',
    );
  });

  it('appends layout classes from className', () => {
    const html = renderToStaticMarkup(
      <ErrorNote className="mt-3 flex items-center gap-3">Couldn't post.</ErrorNote>,
    );
    expect(html).toContain(
      'class="rounded-lg border border-bad bg-bad-soft px-3 py-2 text-base text-bad mt-3 flex items-center gap-3"',
    );
  });

  it('is exported from the ui barrel', () => {
    expect(BarrelErrorNote).toBe(ErrorNote);
  });
});
