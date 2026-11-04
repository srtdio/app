// Guard: every email Sorted sends carries one look, from one shell
// (packages/inbox/src/email-shell.ts): both color-scheme metas, a
// prefers-color-scheme dark block, lit card edges drawn with borders (mail
// clients drop shadows), the Sorted wordmark image (never a blank square), a
// readable code box. Black and white only; every colour comes from the shell's
// light/dark token pairs, so no builder carries a #000000/#ffffff literal.
//
// Edge functions hold verbatim copies of the shell (email-shell.sync.test.ts);
// the Supabase Auth templates are generated from auth-templates.ts and must
// match it byte for byte. Rendered light/dark checks per email live beside each
// builder (email-look.render.test.ts).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EMAIL_DARK,
  EMAIL_LIGHT,
  EMAIL_STYLE,
  EMAIL_WORDMARK,
} from '../../packages/inbox/src/email-shell';
import { AUTH_TEMPLATES, renderAuthCodeTemplate } from '../../packages/inbox/src/auth-templates';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

/** Every builder of an outgoing email and the shell it imports. */
const BUILDERS: readonly (readonly [string, string])[] = [
  ['supabase/functions/invite-send/handler.ts', "from './email-shell.ts'"],
  ['supabase/functions/brand-request-send/handler.ts', "from './email-shell.ts'"],
  ['supabase/functions/book-call-send/mail.ts', "from './email-shell.ts'"],
  ['supabase/functions/demo-request-send/mail.ts', "from './email-shell.ts'"],
  ['packages/inbox/src/catchup.ts', "from './email-shell'"],
  ['packages/inbox/src/auth-templates.ts', "from './email-shell'"],
];

const TEMPLATES = Object.values(AUTH_TEMPLATES);

/** Everything that ends up in a sent email: builders, shell copies, templates. */
const ALL: readonly string[] = [
  ...BUILDERS.map(([rel]) => rel),
  'packages/inbox/src/email-shell.ts',
  'supabase/functions/invite-send/email-shell.ts',
  'supabase/functions/brand-request-send/email-shell.ts',
  'supabase/functions/book-call-send/email-shell.ts',
  'supabase/functions/demo-request-send/email-shell.ts',
  ...TEMPLATES,
];

const PURE_BW = /#(?:000000|ffffff|000|fff)\b/i;

/** The blank square that stood in for a logo: an inline-block span with a fill and only &nbsp;. */
const BLANK_LOGO =
  /<span[^>]*display:\s*inline-block[^>]*background(?:-color)?:[^>]*>\s*&nbsp;\s*<\/span>/i;

describe('email look: one shell for every email', () => {
  it.each(BUILDERS)('%s builds its html with the shell', (rel, from) => {
    const src = read(rel);
    expect(src, `${rel} must import the shell`).toContain(from);
    expect(src, `${rel} must render through emailDocument`).toMatch(/emailDocument\(/);
    expect(src, `${rel} must not hand-build a head`).not.toMatch(/<!doctype html/i);
    expect(src, `${rel} must not hand-build a <style>`).not.toMatch(/<style/i);
  });

  it.each(BUILDERS)('%s carries no #000000/#ffffff literal (tokens live in the shell)', (rel) => {
    expect(read(rel)).not.toMatch(PURE_BW);
  });

  it.each(ALL)('%s has no box-shadow', (rel) => {
    expect(read(rel)).not.toMatch(/box-shadow/i);
  });

  it.each(ALL)('%s has no blank logo square', (rel) => {
    expect(read(rel)).not.toMatch(BLANK_LOGO);
  });

  it.each(TEMPLATES)('%s is generated from auth-templates.ts', (rel) => {
    expect(read(rel)).toBe(renderAuthCodeTemplate());
  });

  it.each(TEMPLATES)(
    '%s has both color-scheme metas, the dark block, the wordmark and the code box',
    (rel) => {
      const html = read(rel);
      expect(html).toContain('<meta name="color-scheme" content="light dark">');
      expect(html).toContain('<meta name="supported-color-schemes" content="light dark">');
      expect(html).toContain('@media (prefers-color-scheme: dark)');
      expect(html).toContain(`src="${EMAIL_WORDMARK.light}"`);
      expect(html).toContain(`src="${EMAIL_WORDMARK.dark}"`);
      expect(html).toContain('alt="Sorted"');
      expect(html).toContain('class="code"');
      expect(html).toMatch(/font-size:28px;[^"]*letter-spacing:\.2em/);
      expect(html).toContain('{{ .Token }}');
    },
  );
});

describe('email look: the shell', () => {
  it('has both schemes for every token', () => {
    expect(Object.keys(EMAIL_DARK).sort()).toEqual(Object.keys(EMAIL_LIGHT).sort());
  });

  it('pure black and white appear only in the token pairs', () => {
    const shell = read('packages/inbox/src/email-shell.ts');
    const tokens =
      /export const EMAIL_LIGHT[\s\S]*?as const;\s*export const EMAIL_DARK[\s\S]*?as const;/.exec(
        shell,
      )?.[0] ?? '';
    expect(tokens).not.toBe('');
    expect(shell.replace(tokens, '')).not.toMatch(PURE_BW);
  });

  it('no pure #000000 rim anywhere', () => {
    expect(Object.values(EMAIL_LIGHT)).not.toContain('#000000');
    expect(Object.values(EMAIL_DARK)).not.toContain('#000000');
  });

  it('card edge is quiet, code box and buttons get the 3:1 line', () => {
    expect(EMAIL_LIGHT.edge).toBe('#d7dade');
    expect(EMAIL_DARK.edge).toBe('#2a2b2f');
    expect(EMAIL_LIGHT.line).toBe('#868b94');
    expect(EMAIL_DARK.line).toBe('#6b7079');
    expect(EMAIL_LIGHT.codeFill).toBe('#f2f3f5');
    expect(EMAIL_DARK.codeFill).toBe('#16171a');
  });

  it('buttons: ink fill and white text in light, white fill and ink text in dark', () => {
    expect(EMAIL_LIGHT.btnFill).toBe(EMAIL_LIGHT.fg);
    expect(EMAIL_LIGHT.btnInk).toBe(EMAIL_LIGHT.panel);
    expect(EMAIL_DARK.btnInk).toBe(EMAIL_LIGHT.fg);
    expect(EMAIL_STYLE).toMatch(
      /\.btn \{ background:#ffffff !important; color:#08090a !important;/,
    );
  });

  it('the dark block covers every shell class, with an Outlook mirror', () => {
    for (const cls of [
      'bg',
      'panel',
      'rowlink',
      'rule',
      'fg',
      'fg2',
      'fg3',
      'accent',
      'btn',
      'code',
      'wm-l',
      'wm-d',
    ]) {
      expect(EMAIL_STYLE, cls).toContain(`.${cls} {`);
      expect(EMAIL_STYLE, cls).toContain(`[data-ogsc] .${cls} {`);
    }
  });

  it('the wordmark files exist and the shell points at them on srtd.io', () => {
    expect(EMAIL_WORDMARK.light).toBe('https://srtd.io/email/wordmark-light.png');
    expect(EMAIL_WORDMARK.dark).toBe('https://srtd.io/email/wordmark-dark.png');
    for (const f of ['public/email/wordmark-light.png', 'public/email/wordmark-dark.png']) {
      const png = readFileSync(fileURLToPath(new URL(`../../${f}`, import.meta.url)));
      expect(png.subarray(1, 4).toString('ascii'), f).toBe('PNG');
      // 2x of the 64x24 the shell declares.
      expect(png.readUInt32BE(16), f).toBe(EMAIL_WORDMARK.width * 2);
      expect(png.readUInt32BE(20), f).toBe(EMAIL_WORDMARK.height * 2);
    }
  });
});
