import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Repo copies of the Supabase auth email templates (Magic Link, Confirm signup).
// Sign in and sign up are by 6-digit code typed in the same tab: the email
// carries {{ .Token }} only, never a link or a button.
const TEMPLATES_DIR = fileURLToPath(new URL('../../../../supabase/templates/', import.meta.url));

const CODE_TEMPLATES = ['magic-link.html', 'confirm-signup.html'];

const templates = readdirSync(TEMPLATES_DIR)
  .filter((name) => name.endsWith('.html'))
  .map((name) => ({ name, html: readFileSync(`${TEMPLATES_DIR}${name}`, 'utf8') }));

const codeTemplates = templates.filter((t) => CODE_TEMPLATES.includes(t.name));

/** Visible text: tags, head and style blocks stripped, entities kept, whitespace collapsed. */
function visibleText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('auth email templates', () => {
  it('has both code templates', () => {
    expect(codeTemplates.map((t) => t.name).sort()).toEqual([...CODE_TEMPLATES].sort());
  });

  it.each(templates)('$name never builds a link from {{ .SiteURL }}', ({ html }) => {
    expect(html).not.toContain('.SiteURL');
  });

  it.each(templates)('$name never uses {{ .ConfirmationURL }} or an em-dash', ({ html }) => {
    expect(html).not.toContain('.ConfirmationURL');
    expect(visibleText(html)).not.toMatch(/[\u2013\u2014]/);
  });

  it.each(codeTemplates)('$name carries the code and no token link', ({ html }) => {
    expect(html).toContain('{{ .Token }}');
    expect(html).not.toContain('{{ .TokenHash }}');
    expect(html).not.toMatch(/<a\s[^>]*href="[^"]*Token/i);
    expect(html).not.toMatch(/<a\s/i);
    expect(html).not.toContain('/auth/callback');
  });

  it.each(codeTemplates)('$name shows the code alone in a monospace box', ({ html }) => {
    const cell = html.match(/<td[^>]*>\s*\{\{ \.Token \}\}\s*<\/td>/)?.[0] ?? '';
    expect(cell).toContain('border:1px solid');
    expect(cell).toContain('monospace');
    expect(cell).toContain('letter-spacing');
  });

  it.each(codeTemplates)('$name carries the approved copy', ({ html }) => {
    const text = visibleText(html);
    expect(text).toContain('srtd.');
    expect(text).toContain('Enter this code in Sorted to sign in.');
    expect(text).toContain('The code expires in 1 hour.');
    expect(text).toContain('Don&rsquo;t share it with anyone.');
    expect(text).toContain('Didn&rsquo;t ask for this? Ignore this email.');
    expect(text).toContain('Sent to {{ .Email }} &middot; srtd.io');
  });

  it.each(codeTemplates)('$name keeps the dark-mode CSS and no subject comment', ({ html }) => {
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).not.toMatch(/<!--/);
  });
});
