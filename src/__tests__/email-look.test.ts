// Guard: every email Sorted sends carries one look. Canvas #f4f5f6, white card
// with lit edges drawn as borders (mail clients drop shadows), ink #08090a,
// black button with a #000000 bottom rim. No box-shadow anywhere. The catch-up
// email also keeps its dark-mode block with the dark palette.
//
// Each file inlines the same values (edge functions are self-contained), so the
// check reads the source of all seven.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

const EMAILS: readonly string[] = [
  'supabase/functions/invite-send/handler.ts',
  'supabase/functions/brand-request-send/handler.ts',
  'supabase/functions/book-call-send/mail.ts',
  'supabase/functions/demo-request-send/mail.ts',
  'packages/inbox/src/catchup.ts',
  'supabase/templates/magic-link.html',
  'supabase/templates/confirm-signup.html',
];

// Canvas, card, lit top edge, lit bottom rim, ink.
const LOOK: readonly string[] = ['#f4f5f6', '#ffffff', '#eceef1', '#c9ced5', '#08090a'];

// The button's bottom rim (and the dark card rim in the templates). The
// book-call and demo-request mails go to the team inbox as a plain card with
// no button and no dark block, so they carry no #000000.
const WITH_BLACK_RIM: readonly string[] = EMAILS.filter((rel) => !rel.endsWith('/mail.ts'));

const CATCHUP_DARK: readonly string[] = [
  'prefers-color-scheme: dark',
  '#1a1c21',
  '#26282e',
  '#f7f8f8',
  '#e5e5e6',
  '#c9ccd1',
];

describe('email look: one look for every email', () => {
  it.each(EMAILS)('%s carries the canvas, card, lit edges and ink', (rel) => {
    const src = read(rel).toLowerCase();
    for (const value of LOOK) expect(src, `${rel} missing ${value}`).toContain(value);
  });

  it.each(WITH_BLACK_RIM)('%s carries the #000000 bottom rim', (rel) => {
    expect(read(rel).toLowerCase()).toContain('#000000');
  });

  it.each(EMAILS)('%s has no box-shadow', (rel) => {
    expect(read(rel)).not.toMatch(/box-shadow/i);
  });

  it('the catch-up email keeps its dark-mode block with the dark palette', () => {
    const src = read('packages/inbox/src/catchup.ts').toLowerCase();
    for (const value of CATCHUP_DARK) expect(src, `catchup.ts missing ${value}`).toContain(value);
  });
});
