// The display-name cap (users.display_name CHECK char_length <= 25, constraint
// users_display_name_max25). Every input that writes users.display_name uses
// these: maxLength={DISPLAY_NAME_MAX}, the live counter from nameCounter()
// (ui/Input `counter`), and NAME_TOO_LONG where the save error shows.
// Guard: src/__tests__/display-name-cap-guard.test.ts.

/** The longest display name the database accepts. */
export const DISPLAY_NAME_MAX = 25;

/** The counter shows once the name is this long. */
export const DISPLAY_NAME_COUNTER_FROM = 20;

/** The DB constraint the server names when a name is too long. */
export const DISPLAY_NAME_CONSTRAINT = 'users_display_name_max25';

/** The line a too-long name shows (server refusal mapped to words). */
export const NAME_TOO_LONG = 'Names can be up to 25 characters.';

/** "n/25" once the name reaches DISPLAY_NAME_COUNTER_FROM characters, else null. Pure. */
export function nameCounter(value: string): string | null {
  const len = value.length;
  return len >= DISPLAY_NAME_COUNTER_FROM ? `${len}/${DISPLAY_NAME_MAX}` : null;
}

/** A name cut to the cap, for prefills (a draft or an older, longer value). Pure. */
export function capDisplayName(value: string): string {
  return value.length > DISPLAY_NAME_MAX ? value.slice(0, DISPLAY_NAME_MAX) : value;
}

function field(error: object, key: string): string {
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Whether a save error is the server refusing a too-long display name: the
 * message or details name users_display_name_max25, or the Postgres
 * check_violation code 23514 when the text names no other constraint. Pure.
 */
export function isNameTooLong(error: unknown): boolean {
  if (typeof error === 'string') return error.includes(DISPLAY_NAME_CONSTRAINT);
  if (error === null || typeof error !== 'object') return false;
  const text = `${field(error, 'message')} ${field(error, 'details')}`;
  if (text.includes(DISPLAY_NAME_CONSTRAINT)) return true;
  if (field(error, 'code') !== '23514') return false;
  // Another CHECK (a username rule, say) is not this one.
  return !/constraint\s+"/.test(text);
}
