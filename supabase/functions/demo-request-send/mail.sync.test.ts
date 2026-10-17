import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// demo-request-send/mail.ts is a verbatim copy of book-call-send/mail.ts (edge
// functions are self-contained). Only the leading header comment may differ,
// and it must end with "change both together" followed by exactly one blank line.

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

/** Everything after the header comment that ends with "change both together" and its blank line. */
function body(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const end = lines.findIndex((line) => /change both together/i.test(line));
  expect(end, 'header must end with "change both together"').toBeGreaterThanOrEqual(0);
  const header = lines.slice(0, end + 1);
  expect(header.every((line) => line.startsWith('//'))).toBe(true);
  expect(lines[end + 1], 'the header is followed by exactly one blank line').toBe('');
  return lines.slice(end + 2).join('\n');
}

describe('mail.ts copies', () => {
  const source = read('../book-call-send/mail.ts');
  const copy = read('./mail.ts');

  it('demo-request-send/mail.ts is identical to book-call-send/mail.ts below the header', () => {
    expect(body(copy)).toBe(body(source));
  });

  it('the first line below the header matches', () => {
    expect(body(copy).split('\n')[0]).toBe(body(source).split('\n')[0]);
    expect(body(source).split('\n')[0]).not.toBe('');
  });

  it('compares real code, not an empty remainder', () => {
    expect(body(source)).toContain('export function requestEmailBody');
    expect(body(source)).toContain('export async function sha256Hex');
  });

  it('the copy names its source of truth', () => {
    expect(copy).toMatch(/VERBATIM COPY of supabase\/functions\/book-call-send\/mail\.ts/);
  });
});
