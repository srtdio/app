import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every edge function that sends mail carries a verbatim copy of email-shell.ts
// (edge functions are self-contained). Only the leading header comment may
// differ, and it must end with "change both together" and one blank line.

const COPIES: readonly string[] = [
  'supabase/functions/invite-send/email-shell.ts',
  'supabase/functions/brand-request-send/email-shell.ts',
  'supabase/functions/book-call-send/email-shell.ts',
  'supabase/functions/demo-request-send/email-shell.ts',
];

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');
}

/** Everything after the header comment that ends with "change both together" and its blank line. */
function body(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const end = lines.findIndex((line) => /change both together/i.test(line));
  expect(end, 'header must end with "change both together"').toBeGreaterThanOrEqual(0);
  expect(lines.slice(0, end + 1).every((line) => line.startsWith('//'))).toBe(true);
  expect(lines[end + 1], 'the header is followed by exactly one blank line').toBe('');
  return lines.slice(end + 2).join('\n');
}

describe('email-shell.ts copies', () => {
  const source = read('packages/inbox/src/email-shell.ts');

  it('the source compares real code', () => {
    expect(body(source)).toContain('export function emailDocument');
    expect(body(source)).toContain('export const EMAIL_DARK');
  });

  it.each(COPIES)(
    '%s is identical to packages/inbox/src/email-shell.ts below the header',
    (rel) => {
      const copy = read(rel);
      expect(copy).toMatch(/VERBATIM COPY of packages\/inbox\/src\/email-shell\.ts/);
      expect(body(copy)).toBe(body(source));
    },
  );
});
