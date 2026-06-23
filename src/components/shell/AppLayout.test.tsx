import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// AppLayout pulls in router + workspace + profile + chat/inbox/toast providers and
// renders under a DOM-less vitest node environment, so mounting it cleanly is
// impractical and no existing shell harness covers it. This regression instead
// reads the source and asserts the page-content scroll <main> keeps BOTH axis
// rules: overflow-y-auto for vertical scrolling and overflow-x-hidden so the
// container can never drift sideways (the Activity filter-row bleed report). The
// internal overflow-x-auto scrollers are their own elements and are not asserted
// here.
const source = readFileSync(fileURLToPath(new URL('./AppLayout.tsx', import.meta.url)), 'utf8');

function mainClassName(src: string): string {
  const match = src.match(/<main className="([^"]*)"/);
  if (match === null) throw new Error('AppLayout has no <main className="...">');
  return match[1] ?? '';
}

describe('AppLayout page-content scroll container', () => {
  it('locks scrolling to the vertical axis on the <main> element', () => {
    const className = mainClassName(source);
    expect(className).toContain('overflow-y-auto');
    expect(className).toContain('overflow-x-hidden');
  });
});
