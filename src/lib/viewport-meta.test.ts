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
  it('has one meta per colour scheme: light the --bg canvas, dark the --panel', () => {
    const tags = metas('theme-color');
    expect(tags).toHaveLength(2);
    const light = tags.find((t) => t.includes('media="(prefers-color-scheme: light)"'));
    const dark = tags.find((t) => t.includes('media="(prefers-color-scheme: dark)"'));
    expect(light).toContain('content="#f7f8f9"');
    expect(dark).toContain('content="#0f1011"');
  });

  it('the values are the tokens in src/index.css and the manifest theme_color', () => {
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    expect(css).toMatch(/:root \{[^}]*--bg: #f7f8f9;/);
    expect(css).toMatch(/\.dark \{[^}]*--panel: #0f1011;/);
    const manifest = JSON.parse(
      readFileSync(new URL('../../public/site.webmanifest', import.meta.url), 'utf8'),
    ) as { theme_color: string };
    expect(manifest.theme_color).toBe('#f7f8f9');
    expect(html).toContain('pre-JS fallback only');
  });

  it('the pre-CSS canvas colours are unchanged', () => {
    expect(html).toContain('background-color: #f7f8f9; /* --bg light');
    expect(html).toContain('background-color: #08090a; /* --bg dark');
  });
});
