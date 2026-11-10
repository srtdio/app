import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssetAddMenu } from '@/components/pages/assets/AssetAddMenu';
import { INDUCTION_KEYS } from '@/lib/induction';

// Decision A: the Assets add control is the top bar's "+" (TopbarPlus), named
// "New file", opening the add menu. 10 Nov 2026: below md an outlined 22
// square on a 36 strip; md and up the 112 x 32 Main face "+ New file".

describe('AssetAddMenu trigger', () => {
  const html = renderToStaticMarkup(<AssetAddMenu onUploadFiles={() => {}} onAddLink={() => {}} />);
  const tag = (html.match(/<button\b[^>]*>/) ?? [''])[0];

  it('is the TopbarPlus: a 44 tall button named "New file", a menu opener', () => {
    expect(tag).toContain('data-topbar-plus=""');
    expect(tag).toContain('aria-label="New file"');
    expect(tag).toContain('aria-haspopup="menu"');
    expect(tag).toContain('aria-expanded="false"');
    expect(tag).toContain('h-11');
    expect(tag).toContain('w-topbar-key');
    expect(tag).toContain('md:w-28');
    expect(html).toMatch(/data-topbar-plus-face="laptop" class="[^"]*\bbg-accent\b/);
  });

  it('keeps the old tour key on the new control', () => {
    expect(tag).toContain(`data-induction="${INDUCTION_KEYS.assetsAdd}"`);
  });

  it('phone face: IconPlus at 14 alone; the label shows only on the aria-hidden laptop face', () => {
    expect(html).toMatch(/data-topbar-plus-face="phone"[^>]*><svg[^>]*width="14"/);
    expect(html).toMatch(
      /data-topbar-plus-face="laptop"[^>]*aria-hidden|aria-hidden="true" data-topbar-plus-face="laptop"/,
    );
    expect(html).not.toMatch(/<\/svg>New file<\/button>/);
  });
});
