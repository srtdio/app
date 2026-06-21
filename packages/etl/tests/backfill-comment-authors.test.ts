import { describe, it, expect } from 'vitest';
import {
  LEGACY_NAME_MAX,
  legacyEmail,
  legacyName,
  parseBackfillMode,
} from '../src/backfill-comment-authors.ts';

// Pure-function tests for the legacy comment-author backfill. No database: these
// cover only the derivations the backfill applies per v1 row before staging.
// Mirrors the etl transform test style.

describe('legacyName', () => {
  it('prefers the resolved v1 profile display name', () => {
    expect(legacyName('Jane Doe', 'jane@example.com')).toBe('Jane Doe');
  });

  it('falls back to the trimmed raw author when there is no profile name', () => {
    expect(legacyName(null, '  Test Client  ')).toBe('Test Client');
  });

  it('treats a blank profile name as absent and uses the author', () => {
    expect(legacyName('   ', 'jane@example.com')).toBe('jane@example.com');
  });

  it('returns null when both profile name and author are null/blank', () => {
    expect(legacyName(null, null)).toBeNull();
    expect(legacyName('   ', '   ')).toBeNull();
    expect(legacyName('', null)).toBeNull();
  });

  it('truncates the name to 120 characters from either source', () => {
    const long = 'a'.repeat(200);
    expect(legacyName(long, null)).toHaveLength(LEGACY_NAME_MAX);
    expect(legacyName(null, long)).toHaveLength(LEGACY_NAME_MAX);
  });

  it('keeps a name at the 120 limit unchanged', () => {
    const exact = 'b'.repeat(LEGACY_NAME_MAX);
    expect(legacyName(exact, null)).toBe(exact);
  });
});

describe('legacyEmail', () => {
  it('lower-cases and trims a standard email address', () => {
    expect(legacyEmail('  Jane@Example.COM ')).toBe('jane@example.com');
  });

  it('returns null for a non-email author such as a display name', () => {
    expect(legacyEmail('Test Client')).toBeNull();
  });

  it('returns null for an incomplete address (no domain dot)', () => {
    expect(legacyEmail('jane@example')).toBeNull();
  });

  it('returns null for a null or blank author', () => {
    expect(legacyEmail(null)).toBeNull();
    expect(legacyEmail('   ')).toBeNull();
  });
});

// A non-email author keeps its name but yields no email: the two derivations are
// independent, so "Test Client" attributes a name without inventing an address.
describe('non-email author keeps the name, drops the email', () => {
  it('derives a name but a null email', () => {
    expect(legacyName(null, 'Test Client')).toBe('Test Client');
    expect(legacyEmail('Test Client')).toBeNull();
  });
});

describe('parseBackfillMode', () => {
  it('defaults to dry-run with no flags', () => {
    expect(parseBackfillMode([])).toBe('dry-run');
  });

  it('parses --mode=apply and --mode=dry-run', () => {
    expect(parseBackfillMode(['--mode=apply'])).toBe('apply');
    expect(parseBackfillMode(['--mode=dry-run'])).toBe('dry-run');
  });

  it('accepts the bare --apply alias and ignores a lone --', () => {
    expect(parseBackfillMode(['--', '--apply'])).toBe('apply');
  });

  it('throws on an invalid mode or an unknown flag', () => {
    expect(() => parseBackfillMode(['--mode=wipe'])).toThrow(/Invalid --mode/);
    expect(() => parseBackfillMode(['--nope'])).toThrow(/Unknown argument/);
  });
});
