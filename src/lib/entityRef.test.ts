import { describe, expect, it } from 'vitest';
import { parseEntityRef, formatEntityRef, entityUrlPath } from '@/lib/entityRef';

describe('parseEntityRef', () => {
  it('parses a valid reference and uppercases the key', () => {
    expect(parseEntityRef('GBL-142')).toEqual({ key: 'GBL', number: 142 });
  });

  it('accepts lowercase and surrounding whitespace', () => {
    expect(parseEntityRef('  gbl-142  ')).toEqual({ key: 'GBL', number: 142 });
  });

  it('normalizes leading zeros on the number', () => {
    expect(parseEntityRef('cv-007')).toEqual({ key: 'CV', number: 7 });
  });

  it('accepts a digit inside the key', () => {
    expect(parseEntityRef('a1-9')).toEqual({ key: 'A1', number: 9 });
  });

  it('rejects a zero number', () => {
    expect(parseEntityRef('GBL-0')).toBeNull();
    expect(parseEntityRef('GBL-000')).toBeNull();
  });

  it('rejects garbage input', () => {
    expect(parseEntityRef('not a ref')).toBeNull();
    expect(parseEntityRef('')).toBeNull();
  });

  it('rejects a missing hyphen', () => {
    expect(parseEntityRef('GBL142')).toBeNull();
  });

  it('rejects a 6+ character key', () => {
    expect(parseEntityRef('ABCDEF-1')).toBeNull();
  });

  it('rejects a single-character key', () => {
    expect(parseEntityRef('A-1')).toBeNull();
  });

  it('rejects a key that starts with a digit', () => {
    expect(parseEntityRef('1AB-1')).toBeNull();
  });

  it('rejects a 10+ digit number', () => {
    expect(parseEntityRef('GBL-1234567890')).toBeNull();
  });
});

describe('formatEntityRef', () => {
  it('renders KEY-N uppercase with no leading zeros', () => {
    expect(formatEntityRef('gbl', 142)).toBe('GBL-142');
    expect(formatEntityRef('CV', 7)).toBe('CV-7');
  });
});

describe('entityUrlPath', () => {
  it('builds the lowercased /p and /b paths', () => {
    expect(entityUrlPath('post', 'GBL', 142)).toBe('/p/gbl-142');
    expect(entityUrlPath('brief', 'CV', 7)).toBe('/b/cv-7');
  });
});
