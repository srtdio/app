import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssetAddMenu } from '@/components/pages/assets/AssetAddMenu';
import { INDUCTION_KEYS } from '@/lib/induction';

// Decision A: the Assets add control is the top bar's filled "+" (TopbarPlus),
// icon only, named "New file", opening the add menu.

describe('AssetAddMenu trigger', () => {
  const html = renderToStaticMarkup(<AssetAddMenu onUploadFiles={() => {}} onAddLink={() => {}} />);
  const tag = (html.match(/<button\b[^>]*>/) ?? [''])[0];

  it('is the TopbarPlus: a 44 round primary button named "New file", a menu opener', () => {
    expect(tag).toContain('data-topbar-plus=""');
    expect(tag).toContain('aria-label="New file"');
    expect(tag).toContain('aria-haspopup="menu"');
    expect(tag).toContain('aria-expanded="false"');
    expect(tag).toContain('h-11');
    expect(tag).toContain('w-11');
    expect(tag).toContain('bg-accent');
  });

  it('keeps the old tour key on the new control', () => {
    expect(tag).toContain(`data-induction="${INDUCTION_KEYS.assetsAdd}"`);
  });

  it('icon only: IconPlus at the control size, no visible label', () => {
    expect(html).toMatch(/<button\b[^>]*><svg[^>]*width="20"[^]*?<\/svg><\/button>/);
    expect(html).not.toMatch(/<\/svg>New file<\/button>/);
  });
});
