import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tag } from '@/components/ui/Tag';
import { IconMail, IconMailOff } from '@/components/ui/icons';

describe('Tag', () => {
  it('with no icon renders exactly the markup it did before the icon slot', () => {
    expect(renderToStaticMarkup(<Tag label="Approver" />)).toBe(
      '<span class="inline-flex h-5 items-center rounded-md px-2 text-xs font-medium bg-panel-2 text-fg-2">Approver</span>',
    );
    expect(renderToStaticMarkup(<Tag label="Not delivered" tone="bad" />)).toBe(
      '<span class="inline-flex h-5 items-center rounded-md px-2 text-xs font-medium bg-bad-soft text-bad">Not delivered</span>',
    );
    expect(renderToStaticMarkup(<Tag label="Review" dot="review" />)).toBe(
      '<span class="inline-flex h-5 items-center rounded-md px-2 text-xs font-medium bg-panel-2 text-fg-2 gap-1.5"><span aria-hidden="true" class="h-2 w-2 shrink-0 rounded-full bg-stage-review"></span>Review</span>',
    );
  });

  it('with an icon renders it first, at text size, with a small gap', () => {
    const out = renderToStaticMarkup(<Tag label="On" icon={IconMail} />);
    expect(
      out.startsWith(
        '<span class="inline-flex h-5 items-center rounded-md px-2 text-xs font-medium bg-panel-2 text-fg-2 gap-1"><svg',
      ),
    ).toBe(true);
    expect(out.indexOf('<svg')).toBeLessThan(out.indexOf('On'));
    expect(out).toContain('width="12"');
    expect(out).toContain('aria-hidden="true"');
    expect(out.endsWith('On</span>')).toBe(true);
    const off = renderToStaticMarkup(<Tag label="Emails off" icon={IconMailOff} />);
    expect(off.indexOf('<svg')).toBeLessThan(off.indexOf('Emails off'));
  });
});
