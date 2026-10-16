import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Repo copies of the Supabase auth email templates. Links must return to the
// site the email was requested from ({{ .RedirectTo }}), never {{ .SiteURL }}.
const TEMPLATES_DIR = fileURLToPath(new URL('../../../../supabase/templates/', import.meta.url));

const templates = readdirSync(TEMPLATES_DIR)
  .filter((name) => name.endsWith('.html'))
  .map((name) => ({ name, html: readFileSync(`${TEMPLATES_DIR}${name}`, 'utf8') }));

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? '');
}

/** Visible text: tags, head and style blocks stripped, whitespace collapsed. */
function visibleText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('auth email templates', () => {
  it('has at least one template', () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  it.each(templates)('$name never builds a link from {{ .SiteURL }}', ({ html }) => {
    expect(html).not.toContain('.SiteURL');
  });

  it.each(templates)(
    '$name callback links start at {{ .RedirectTo }}/auth/callback',
    ({ html }) => {
      const callbacks = hrefs(html).filter((href) => href.includes('/auth/callback'));
      expect(callbacks.length).toBeGreaterThan(0);
      for (const href of callbacks) {
        expect(href.startsWith('{{ .RedirectTo }}/auth/callback?')).toBe(true);
      }
    },
  );

  it('magic-link keeps the exact callback path and query', () => {
    const magic = templates.find((t) => t.name === 'magic-link.html');
    expect(magic).toBeDefined();
    expect(hrefs(magic?.html ?? '')).toContain(
      '{{ .RedirectTo }}/auth/callback?token_hash={{ .TokenHash }}&type=magiclink',
    );
  });

  it('magic-link visible text is unchanged', () => {
    const magic = templates.find((t) => t.name === 'magic-link.html');
    const text = visibleText(magic?.html ?? '');
    expect(text).not.toContain('RedirectTo');
    expect(text).toContain('Sign in to Sorted');
  });
});
