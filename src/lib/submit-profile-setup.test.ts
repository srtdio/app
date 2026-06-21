import { describe, expect, it, vi } from 'vitest';
import type { Client, Result } from '@srtdio/rpc';
import { submitProfileSetup } from '@/lib/submit-profile-setup';

const client = {} as Client;

function file(): File {
  return new File([new Uint8Array([1])], 'avatar.png', { type: 'image/png' });
}

function okUpload(avatarUrl: string) {
  return vi.fn(
    async (): Promise<Result<{ avatarUrl: string }>> => ({
      ok: true,
      data: { avatarUrl },
    }),
  );
}

describe('submitProfileSetup', () => {
  it('uploads then saves with the avatarUrl, the fields and a trace id', async () => {
    const uploadAvatar = okUpload('https://cdn.test/me.png');
    const saveProfile = vi.fn(async (): Promise<Result<string>> => ({ ok: true, data: 'user-1' }));

    const result = await submitProfileSetup({
      client,
      file: file(),
      displayName: 'Ada Lovelace',
      designation: 'Brand Manager',
      emailOptIn: true,
      uploadAvatar,
      saveProfile,
      newTrace: () => 'trace-xyz',
    });

    expect(result).toEqual({ ok: true, data: undefined });
    expect(saveProfile).toHaveBeenCalledTimes(1);
    expect(saveProfile).toHaveBeenCalledWith(client, {
      p_display_name: 'Ada Lovelace',
      p_designation: 'Brand Manager',
      p_avatar_url: 'https://cdn.test/me.png',
      p_email_opt_in: true,
      p_trace_id: 'trace-xyz',
    });
  });

  it('sends an empty designation string when none was provided', async () => {
    const saveProfile = vi.fn(async (): Promise<Result<string>> => ({ ok: true, data: 'u' }));

    await submitProfileSetup({
      client,
      file: file(),
      displayName: 'Solo',
      designation: null,
      emailOptIn: false,
      uploadAvatar: okUpload('https://cdn.test/x.png'),
      saveProfile,
      newTrace: () => 't',
    });

    const call = saveProfile.mock.calls[0];
    if (call === undefined) throw new Error('saveProfile was not called');
    expect((call as unknown as [Client, Record<string, unknown>])[1]).toMatchObject({
      p_designation: '',
      p_email_opt_in: false,
    });
  });

  it('returns the upload error and never calls saveProfile when the upload fails', async () => {
    const uploadAvatar = vi.fn(
      async (): Promise<Result<{ avatarUrl: string }>> => ({
        ok: false,
        error: { code: 'unknown', message: 'upload boom' },
      }),
    );
    const saveProfile = vi.fn(async (): Promise<Result<string>> => ({ ok: true, data: 'u' }));

    const result = await submitProfileSetup({
      client,
      file: file(),
      displayName: 'Ada',
      designation: null,
      emailOptIn: true,
      uploadAvatar,
      saveProfile,
      newTrace: () => 't',
    });

    expect(result).toEqual({ ok: false, error: { code: 'unknown', message: 'upload boom' } });
    expect(saveProfile).not.toHaveBeenCalled();
  });

  it('returns the saveProfile error when the save fails', async () => {
    const saveProfile = vi.fn(
      async (): Promise<Result<string>> => ({
        ok: false,
        error: { code: 'invalid_payload', message: 'bad name' },
      }),
    );

    const result = await submitProfileSetup({
      client,
      file: file(),
      displayName: '',
      designation: null,
      emailOptIn: true,
      uploadAvatar: okUpload('https://cdn.test/x.png'),
      saveProfile,
      newTrace: () => 't',
    });

    expect(result).toEqual({ ok: false, error: { code: 'invalid_payload', message: 'bad name' } });
  });
});
