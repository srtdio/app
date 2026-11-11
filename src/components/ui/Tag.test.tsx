import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tag, tagClass } from '@/components/ui/Tag';
import { IconMail, IconMailOff } from '@/components/ui/icons';

describe('Tag', () => {
  it('with no icon renders exactly the markup it did before the icon slot', () => {
    expect(renderToStaticMarkup(<Tag label="Approver" />)).toBe(
      '<span class="lit-pill inline-flex h-5 items-center rounded-md px-2 text-xs font-medium max-w-full overflow-hidden bg-panel-2 text-fg-2">Approver</span>',
    );
    expect(renderToStaticMarkup(<Tag label="Not delivered" tone="bad" />)).toBe(
      '<span class="lit-pill inline-flex h-5 items-center rounded-md px-2 text-xs font-medium max-w-full overflow-hidden bg-bad-soft text-bad">Not delivered</span>',
    );
    expect(renderToStaticMarkup(<Tag label="Review" dot="review" />)).toBe(
      '<span class="lit-pill inline-flex h-5 items-center rounded-md px-2 text-xs font-medium max-w-full overflow-hidden bg-panel-2 text-fg-2 gap-2"><span aria-hidden="true" class="h-2 w-2 shrink-0 rounded-full bg-stage-review"></span>Review</span>',
    );
  });

  it('with an icon renders it first, at text size, with a small gap', () => {
    const out = renderToStaticMarkup(<Tag label="On" icon={IconMail} />);
    expect(
      out.startsWith(
        '<span class="lit-pill inline-flex h-5 items-center rounded-md px-2 text-xs font-medium max-w-full overflow-hidden bg-panel-2 text-fg-2 gap-1"><svg',
      ),
    ).toBe(true);
    expect(out.indexOf('<svg')).toBeLessThan(out.indexOf('On'));
    expect(out).toContain('width="12"');
    expect(out).toContain('aria-hidden="true"');
    expect(out.endsWith('On</span>')).toBe(true);
    const off = renderToStaticMarkup(<Tag label="Emails off" icon={IconMailOff} />);
    expect(off.indexOf('<svg')).toBeLessThan(off.indexOf('Emails off'));
  });

  it('cut: one line that ends in an ellipsis, words still bare; never wider than its place', () => {
    const out = renderToStaticMarkup(<Tag label="A very long tag that cannot fit" cut />);
    for (const c of [
      'max-w-full',
      'inline-block',
      'overflow-hidden',
      'text-ellipsis',
      'whitespace-nowrap',
    ]) {
      expect(out).toContain(c);
    }
    expect(out).toContain(tagClass('neutral'));
    expect(out).toMatch(/">A very long tag that cannot fit<\/span>$/);
    expect(renderToStaticMarkup(<Tag label="Draft" />)).not.toContain('text-ellipsis');
  });
});
