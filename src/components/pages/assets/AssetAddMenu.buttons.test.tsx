import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssetAddMenu } from '@/components/pages/assets/AssetAddMenu';

// Button system regression: "New asset" is the shared primary Button.

describe('AssetAddMenu buttons', () => {
  it('renders New asset as a 44px, 8px-radius primary button', () => {
    const html = renderToStaticMarkup(<AssetAddMenu onUploadFiles={() => {}} onAddLink={() => {}} />);
    const tag = (html.match(/<button\b[^>]*>/) ?? [''])[0];
    expect(tag).toContain('h-11');
    expect(tag).toContain('rounded-lg');
    expect(tag).toContain('bg-accent');
    expect(tag).not.toMatch(/\b(rounded-md|h-9|h-12|font-semibold)\b/);
  });
});
