import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// index.html is the one place the viewport and the Safari toolbar tint live;
// the app never writes these metas (src/lib/theme.ts only syncs their content).
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

function metas(name: string): string[] {
  return [...html.matchAll(/<meta\s+[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes(`name="${name}"`));
}

describe('index.html viewport (pinch zoom works)', () => {
  it('has one viewport meta that never locks the scale', () => {
    const [viewport, ...rest] = metas('viewport');
    expect(rest).toEqual([]);
    expect(viewport).toBeDefined();
    expect(viewport).toContain('width=device-width');
    expect(viewport).toContain('initial-scale=1');
    expect(viewport).toContain('viewport-fit=cover');
    expect(viewport).not.toContain('maximum-scale');
    expect(viewport).not.toContain('user-scalable');
  });
});

describe('index.html theme-color (FT7)', () => {
  it('has one meta per colour scheme, each the --bg value the stylesheet paints', () => {
    const tags = metas('theme-color');
    expect(tags).toHaveLength(2);
    const light = tags.find((t) => t.includes('media="(prefers-color-scheme: light)"'));
    const dark = tags.find((t) => t.includes('media="(prefers-color-scheme: dark)"'));
    expect(light).toContain('content="#f7f8f9"');
    expect(dark).toContain('content="#0c0d10"');
  });

  it('the values match the pre-CSS canvas colours in the same file', () => {
    expect(html).toContain('background-color: #f7f8f9; /* --bg light');
    expect(html).toContain('background-color: #0c0d10; /* --bg dark');
  });
});
