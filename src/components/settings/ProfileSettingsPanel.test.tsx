import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import type { Client, Result, UserProfileUpdateArgs } from '@srtdio/rpc';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CameraBadge,
  PHOTO_VIEW_INITIAL,
  PhotoPickActions,
  TEXT_FIELDS_INITIAL,
  canRemovePhoto,
  panelMode,
  prefillFields,
  reconcilePhotoView,
  submitTextFields,
  submitUsePhoto,
  profileErrorMessage,
  settlePhotoChange,
  shownPhoto,
  submitProfileChange,
  type PhotoIntent,
  type PhotoView,
} from '@/components/settings/ProfileSettingsPanel';
import type { CurrentProfile } from '@/lib/use-current-profile';

const client = {} as Client;
const TRACE = '01927c3e-0000-7000-8000-000000000000';
const URL_SAVED = 'https://cdn.srtd.io/u-me/old.png';
const URL_NEW = 'https://cdn.srtd.io/u-me/new.png';

function run(photo: PhotoIntent, saveResult: Result<string> = { ok: true, data: 'u-me' }) {
  const save = vi.fn<(c: Client, a: UserProfileUpdateArgs) => Promise<Result<string>>>(() =>
    Promise.resolve(saveResult),
  );
  const done = submitProfileChange({
    client,
    save,
    newTrace: () => TRACE,
    displayName: 'Asha Rao',
    designation: 'Brand Manager',
    emailOptIn: false,
    photo,
  });
  return { save, done };
}

describe('profile photo args', () => {
  it('Remove sends p_avatar_url as the empty string', async () => {
    const { save, done } = run({ kind: 'clear' });
    expect(await done).toEqual({ ok: true, data: undefined });
    expect(save).toHaveBeenCalledWith(client, {
      p_display_name: 'Asha Rao',
      p_designation: 'Brand Manager',
      p_avatar_url: '',
      p_email_opt_in: false,
      p_trace_id: TRACE,
    });
  });

  it('Save with an unchanged photo sends NULL, never the empty string', async () => {
    const { save, done } = run({ kind: 'keep' });
    await done;
    expect(save.mock.calls[0]?.[1].p_avatar_url).toBeNull();
  });

  it('a new upload sends the uploaded https URL', async () => {
    const upload = vi.fn(() =>
      Promise.resolve<Result<{ avatarUrl: string }>>({ ok: true, data: { avatarUrl: URL_NEW } }),
    );
    const { save, done } = run({ kind: 'upload', upload });
    await done;
    expect(upload).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[1].p_avatar_url).toBe(URL_NEW);
  });

  it('a failed upload never saves', async () => {
    const upload = () =>
      Promise.resolve<Result<{ avatarUrl: string }>>({
        ok: false,
        error: { code: 'unknown', message: 'Upload failed. Check your connection and retry' },
      });
    const { save, done } = run({ kind: 'upload', upload });
    expect((await done).ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('server error', () => {
  it('reverts the photo and shows the message', async () => {
    const { done } = run(
      { kind: 'clear' },
      { ok: false, error: { code: 'unknown', message: 'Profile write refused' } },
    );
    const result = await done;
    const previous: PhotoView = PHOTO_VIEW_INITIAL;
    const next: PhotoView = { previewUrl: null, removed: true, expect: '' };
    const settled = settlePhotoChange(result, previous, next);
    expect(settled.photo).toEqual(previous);
    expect(settled.error).toBe('Profile write refused');
    expect(shownPhoto(URL_SAVED, settled.photo)).toBe(URL_SAVED);
  });

  it('keeps the new photo on success', () => {
    const next: PhotoView = { previewUrl: null, removed: true, expect: '' };
    const settled = settlePhotoChange({ ok: true, data: undefined }, PHOTO_VIEW_INITIAL, next);
    expect(settled).toEqual({ photo: next, error: null });
    expect(shownPhoto(URL_SAVED, settled.photo)).toBeNull();
  });

  it('turns raw codes and multi-line errors into one readable line', () => {
    expect(profileErrorMessage('invalid_payload')).toBe('Could not save your profile. Try again');
    expect(profileErrorMessage('')).toBe('Could not save your profile. Try again');
    expect(profileErrorMessage('Bad thing\nstack here')).toBe('Bad thing');
  });
});

describe('shownPhoto', () => {
  it('prefers a staged preview, then removal, then the saved url', () => {
    expect(shownPhoto(URL_SAVED, { previewUrl: 'blob:x', removed: false, expect: null })).toBe(
      'blob:x',
    );
    expect(shownPhoto(URL_SAVED, { previewUrl: null, removed: true, expect: null })).toBeNull();
    expect(shownPhoto(URL_SAVED, PHOTO_VIEW_INITIAL)).toBe(URL_SAVED);
    expect(shownPhoto(null, PHOTO_VIEW_INITIAL)).toBeNull();
    expect(shownPhoto('', PHOTO_VIEW_INITIAL)).toBeNull();
  });
});

const SAVED: CurrentProfile = {
  display_name: 'Asha Rao',
  designation: 'Brand Manager',
  avatar_url: URL_SAVED,
  email_opt_in: false,
  profile_completed_at: '2026-09-01T00:00:00Z',
  username: 'asha.rao',
};

function saveMock(result: Result<string> = { ok: true, data: 'u-me' }) {
  return vi.fn<(c: Client, a: UserProfileUpdateArgs) => Promise<Result<string>>>(() =>
    Promise.resolve(result),
  );
}

describe('Use photo', () => {
  const cropped = new File(['png'], 'avatar.png', { type: 'image/png' });

  it('uploads the cropped file and saves its URL with the SAVED fields, not typed input', async () => {
    const save = saveMock();
    const upload = vi.fn<(file: File) => Promise<Result<{ avatarUrl: string }>>>(() =>
      Promise.resolve({ ok: true, data: { avatarUrl: URL_NEW } }),
    );
    const onExported = vi.fn();
    // The form holds unsaved "Typed Name"; the helper only sees the saved row.
    const result = await submitUsePhoto({
      client,
      save,
      newTrace: () => TRACE,
      saved: SAVED,
      exportPng: () => Promise.resolve(cropped),
      upload,
      onExported,
    });
    expect(result).toEqual({ ok: true, data: { avatarUrl: URL_NEW } });
    expect(onExported).toHaveBeenCalledWith(cropped);
    expect(upload).toHaveBeenCalledWith(cropped);
    expect(save).toHaveBeenCalledWith(client, {
      p_display_name: 'Asha Rao',
      p_designation: 'Brand Manager',
      p_avatar_url: URL_NEW,
      p_email_opt_in: false,
      p_trace_id: TRACE,
    });
  });

  it('a failed save reverts to the previous photo with one readable line', async () => {
    const result = await submitUsePhoto({
      client,
      save: saveMock({
        ok: false,
        error: { code: 'unknown', message: 'Profile write refused\nat x' },
      }),
      newTrace: () => TRACE,
      saved: SAVED,
      exportPng: () => Promise.resolve(cropped),
      upload: () =>
        Promise.resolve<Result<{ avatarUrl: string }>>({ ok: true, data: { avatarUrl: URL_NEW } }),
      onExported: () => {},
    });
    const settled = settlePhotoChange(result, PHOTO_VIEW_INITIAL, {
      previewUrl: 'blob:cropped',
      removed: false,
      expect: URL_NEW,
    });
    expect(settled.photo).toEqual(PHOTO_VIEW_INITIAL);
    expect(settled.error).toBe('Profile write refused');
    expect(shownPhoto(URL_SAVED, settled.photo)).toBe(URL_SAVED);
  });

  it('no cropped file means no upload and no save', async () => {
    const save = saveMock();
    const upload = vi.fn();
    const result = await submitUsePhoto({
      client,
      save,
      newTrace: () => TRACE,
      saved: SAVED,
      exportPng: () => Promise.resolve(null),
      upload,
      onExported: () => {},
    });
    expect(result.ok).toBe(false);
    expect(upload).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('Use photo and Cancel are 44px buttons, both disabled while in flight', () => {
    const idle = renderToStaticMarkup(
      <PhotoPickActions busy={false} onUse={() => {}} onCancel={() => {}} />,
    );
    expect(idle).toContain('Use photo');
    expect(idle).toContain('Cancel');
    expect(idle.match(/h-11/g)).toHaveLength(2);
    expect(idle).not.toContain('disabled=""');
    const busy = renderToStaticMarkup(
      <PhotoPickActions busy onUse={() => {}} onCancel={() => {}} />,
    );
    expect(busy.match(/disabled=""/g)).toHaveLength(2);
    // The camera badge is disabled too, so no second pick starts mid-upload.
    const badge = renderToStaticMarkup(<CameraBadge disabled onPress={() => {}} />);
    expect(badge).toContain('disabled=""');
  });

  it('Cancel uploads nothing: its handler is the only thing pressed', () => {
    const onUse = vi.fn();
    const onCancel = vi.fn();
    const out = renderToStaticMarkup(
      <PhotoPickActions busy={false} onUse={onUse} onCancel={onCancel} />,
    );
    expect(out).toContain('data-action="cancel-photo"');
    // Nothing renders or runs an upload until Use photo is pressed.
    expect(onUse).not.toHaveBeenCalled();
  });
});

describe('Save profile', () => {
  it('always sends NULL for the photo', async () => {
    const save = saveMock();
    await submitTextFields({
      client,
      save,
      newTrace: () => TRACE,
      displayName: 'New Name',
      designation: 'Lead',
      emailOptIn: true,
    });
    expect(save.mock.calls[0]?.[1]).toEqual({
      p_display_name: 'New Name',
      p_designation: 'Lead',
      p_avatar_url: null,
      p_email_opt_in: true,
      p_trace_id: TRACE,
    });
  });
});

describe('Remove photo visibility', () => {
  it('is hidden with only a staged pick (no saved photo)', () => {
    // A pick in the cropper never feeds the view, so the view stays initial.
    expect(canRemovePhoto(null, PHOTO_VIEW_INITIAL)).toBe(false);
    expect(canRemovePhoto('', PHOTO_VIEW_INITIAL)).toBe(false);
  });

  it('is shown with a saved photo', () => {
    expect(canRemovePhoto(URL_SAVED, PHOTO_VIEW_INITIAL)).toBe(true);
  });
});

describe('override clears after the refetch (F2)', () => {
  it('a saved Use photo gives way to the store once it holds the URL', () => {
    const view: PhotoView = { previewUrl: 'blob:c', removed: false, expect: URL_NEW };
    expect(reconcilePhotoView(view, URL_SAVED)).toBe(view);
    expect(reconcilePhotoView(view, URL_NEW)).toEqual(PHOTO_VIEW_INITIAL);
  });

  it('a saved Remove gives way once the store holds no photo, so a later photo shows', () => {
    const view: PhotoView = { previewUrl: null, removed: true, expect: '' };
    expect(reconcilePhotoView(view, URL_SAVED)).toBe(view);
    const cleared = reconcilePhotoView(view, null);
    expect(cleared).toEqual(PHOTO_VIEW_INITIAL);
    expect(shownPhoto(URL_NEW, cleared)).toBe(URL_NEW);
  });

  it('an in-flight change (nothing expected yet) is kept', () => {
    const view: PhotoView = { previewUrl: 'blob:c', removed: false, expect: null };
    expect(reconcilePhotoView(view, URL_SAVED)).toBe(view);
  });
});

describe('prefill (F3)', () => {
  it('fills on the first load for the user', () => {
    const out = prefillFields(TEXT_FIELDS_INITIAL, 'u-me', SAVED);
    expect(out).toMatchObject({ name: 'Asha Rao', designation: 'Brand Manager' });
  });

  it('a refetch never overwrites what the user typed', () => {
    const first = prefillFields(TEXT_FIELDS_INITIAL, 'u-me', SAVED);
    const typed = { ...first, name: 'Asha R', nameEdited: true };
    const refetched = prefillFields(typed, 'u-me', { ...SAVED, avatar_url: null });
    expect(refetched).toBe(typed);
    expect(refetched.name).toBe('Asha R');
  });

  it('never overwrites an edited field even on the first load', () => {
    const typed = { ...TEXT_FIELDS_INITIAL, designation: 'Lead', designationEdited: true };
    const out = prefillFields(typed, 'u-me', SAVED);
    expect(out).toMatchObject({ name: 'Asha Rao', designation: 'Lead' });
  });
});

describe('error view (F4)', () => {
  it('shows only when there is no profile', () => {
    expect(panelMode(false, null)).toBe('error');
    expect(panelMode(true, null)).toBe('loading');
    expect(panelMode(false, SAVED)).toBe('ready');
  });
});

describe('tokens', () => {
  it('the camera badge ring is the page canvas token; no hex or dark: literals', () => {
    const badge = renderToStaticMarkup(<CameraBadge disabled={false} onPress={() => {}} />);
    expect(badge).toContain('ring-bg');
    expect(badge).not.toContain('ring-panel');
    expect(badge).toContain('h-11 w-11');
    const actions = renderToStaticMarkup(
      <PhotoPickActions busy={false} onUse={() => {}} onCancel={() => {}} />,
    );
    for (const out of [badge, actions]) {
      expect(out).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(out).not.toContain('dark:');
    }
  });
});
