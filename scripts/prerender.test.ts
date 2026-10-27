import { describe, expect, it } from 'vitest';
import { injectAppPreloads, type Manifest } from './prerender.ts';

// A built dist/index.html, trimmed: inline canvas <style>, theme script, title,
// then the entry script and the one modulepreload Vite adds itself.
const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>
      html { background-color: #f7f8f9; }
    </style>
    <script>
      document.documentElement.classList.add('pre-dark');
    </script>
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Sorted</title>
    <link rel="icon" href="/favicon.ico" sizes="32x32" />
    <script type="module" crossorigin src="/assets/index-ENTRY.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-react-R.js">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

const MANIFEST: Manifest = {
  'index.html': {
    file: 'assets/index-ENTRY.js',
    imports: ['_vendor-react-R.js'],
  },
  'src/index.css': { file: 'assets/index-CSS.css' },
  'src/App.tsx': {
    file: 'assets/App-A.js',
    imports: ['index.html', '_vendor-react-R.js', '_vendor-supabase-S.js', '_session-X.js'],
  },
  '_vendor-react-R.js': { file: 'assets/vendor-react-R.js' },
  '_vendor-supabase-S.js': { file: 'assets/vendor-supabase-S.js' },
  // Reached twice (App and vendor-supabase both import it): preloaded once.
  '_session-X.js': {
    file: 'assets/session-X.js',
    imports: ['_vendor-supabase-S.js', '_zod-Z.js'],
  },
  '_zod-Z.js': { file: 'assets/zod-Z.js' },
  // A route chunk App only imports dynamically: never preloaded.
  'src/components/pages/PipelinePage.tsx': { file: 'assets/PipelinePage-P.js' },
};

function without(key: string): Manifest {
  return Object.fromEntries(Object.entries(MANIFEST).filter(([k]) => k !== key));
}

// One injected modulepreload line (Vite's own vendor-react line is kept).
const INJECTED_PRELOAD = / {4}<link rel="modulepreload"(?![^\n]*vendor-react)[^\n]*\n/g;

function preloads(html: string): string[] {
  return [...html.matchAll(/<link rel="modulepreload" crossorigin href="([^"]+)">/g)].map(
    (m) => m[1] ?? '',
  );
}

describe('injectAppPreloads', () => {
  const out = injectAppPreloads(SHELL, MANIFEST);

  it('links the app stylesheet after the inline <style> and before <title>', () => {
    const link = '<link rel="stylesheet" href="/assets/index-CSS.css">';
    expect(out).toContain(`${link}\n    <title>Sorted</title>`);
    expect(out.indexOf('</style>')).toBeLessThan(out.indexOf(link));
    expect(out.indexOf('pre-dark')).toBeLessThan(out.indexOf(link));
  });

  it('preloads App and its static imports once, skipping what the HTML already loads', () => {
    expect(preloads(out)).toEqual([
      '/assets/vendor-react-R.js',
      '/assets/App-A.js',
      '/assets/vendor-supabase-S.js',
      '/assets/session-X.js',
      '/assets/zod-Z.js',
    ]);
    expect(out).not.toContain('PipelinePage');
    expect(out).not.toContain('href="/assets/index-ENTRY.js"');
    expect(out.match(/index-ENTRY\.js/g)).toHaveLength(1);
  });

  it('puts the new modulepreloads in <head>, after the ones Vite wrote', () => {
    const head = out.split('</head>')[0] ?? '';
    expect(head).toContain('<link rel="modulepreload" crossorigin href="/assets/zod-Z.js">');
    expect(head.indexOf('vendor-react-R.js')).toBeLessThan(head.indexOf('App-A.js'));
    expect(out).toContain(
      '<link rel="modulepreload" crossorigin href="/assets/zod-Z.js">\n  </head>',
    );
  });

  it('leaves #root empty and the rest of the shell as it was', () => {
    expect(out).toContain('<div id="root"></div>');
    const removed = out
      .replace('<link rel="stylesheet" href="/assets/index-CSS.css">\n    ', '')
      .replace(INJECTED_PRELOAD, '');
    expect(removed).toBe(SHELL);
  });

  it('is idempotent on a second run', () => {
    expect(injectAppPreloads(out, MANIFEST)).toBe(out);
  });

  it('throws when the manifest lacks the App entry or the stylesheet', () => {
    expect(() => injectAppPreloads(SHELL, without('src/App.tsx'))).toThrow(/src\/App\.tsx/);
    expect(() => injectAppPreloads(SHELL, without('src/index.css'))).toThrow(/src\/index\.css/);
  });

  it('throws when the shell has no <title> after the inline <style>', () => {
    const untitled = SHELL.replace('<title>Sorted</title>', '');
    expect(() => injectAppPreloads(untitled, MANIFEST)).toThrow(/<title>Sorted<\/title>/);
  });
});
