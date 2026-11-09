import { describe, expect, it } from 'vitest';
import {
  DISPLAY_NAME_COUNTER_FROM,
  DISPLAY_NAME_MAX,
  NAME_TOO_LONG,
  capDisplayName,
  isNameTooLong,
  nameCounter,
} from '@/lib/display-name';

describe('display-name cap', () => {
  it('caps at 25 and counts from 20', () => {
    expect(DISPLAY_NAME_MAX).toBe(25);
    expect(DISPLAY_NAME_COUNTER_FROM).toBe(20);
    expect(NAME_TOO_LONG).toBe('Names can be up to 25 characters.');
    expect(NAME_TOO_LONG).not.toContain('—');
  });
});

describe('nameCounter', () => {
  it('is null under 20 characters', () => {
    expect(nameCounter('')).toBeNull();
    expect(nameCounter('a'.repeat(19))).toBeNull();
  });

  it('shows n/25 from 20 characters', () => {
    expect(nameCounter('a'.repeat(20))).toBe('20/25');
    expect(nameCounter('a'.repeat(24))).toBe('24/25');
    expect(nameCounter('a'.repeat(25))).toBe('25/25');
  });
});

describe('capDisplayName', () => {
  it('keeps a short name and cuts a long one to 25', () => {
    expect(capDisplayName('Riya Menon')).toBe('Riya Menon');
    expect(capDisplayName('a'.repeat(30))).toBe('a'.repeat(25));
  });
});

describe('isNameTooLong', () => {
  it('recognises the constraint name in the message or details', () => {
    expect(
      isNameTooLong({
        code: 'unknown',
        message:
          'new row for relation "users" violates check constraint "users_display_name_max25"',
      }),
    ).toBe(true);
    expect(isNameTooLong({ message: 'x', details: 'users_display_name_max25' })).toBe(true);
    expect(isNameTooLong('violates check constraint "users_display_name_max25"')).toBe(true);
  });

  it('recognises the check_violation code 23514', () => {
    expect(isNameTooLong({ code: '23514', message: '' })).toBe(true);
    expect(isNameTooLong({ code: '23514' })).toBe(true);
  });

  it('ignores another check constraint and other errors', () => {
    expect(
      isNameTooLong({
        code: '23514',
        message: 'violates check constraint "users_username_format"',
      }),
    ).toBe(false);
    expect(isNameTooLong({ code: 'unknown', message: 'username_taken' })).toBe(false);
    expect(isNameTooLong(null)).toBe(false);
    expect(isNameTooLong(undefined)).toBe(false);
    expect(isNameTooLong(new Error('network'))).toBe(false);
    expect(isNameTooLong('network down')).toBe(false);
  });
});
