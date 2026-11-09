import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { profileErrorMessage } from '@/components/settings/ProfileSettingsPanel';
import { NAME_TOO_LONG } from '@/lib/display-name';

// The display-name cap (users_display_name_max25): the server's refusal reads
// as words wherever the profile save error shows.
describe('profileErrorMessage maps a too-long name', () => {
  it('the check violation reads NAME_TOO_LONG', () => {
    expect(
      profileErrorMessage(
        'new row for relation "users" violates check constraint "users_display_name_max25"',
      ),
    ).toBe(NAME_TOO_LONG);
  });

  it('other errors keep their line', () => {
    expect(profileErrorMessage('Photo too large')).toBe('Photo too large');
  });
});
