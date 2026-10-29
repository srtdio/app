// Settings -> Profile editor. The photo is optional: the user can rename or
// re-title without re-uploading. It orchestrates its own upload-then-save, only uploading when the cropper actually holds a new photo and
// otherwise sending NULL for the photo (the proc keeps the current one).
//
// The Catch-up emails tick box saves on tick (no Save button) with the SAVED
// name, designation and photo, only p_email_opt_in changed; unsaved form edits
// are never sent and stay in the form. It is optimistic: the shared profile
// store is patched at once (setProfileEmailOptIn) and a failure reverts it and
// toasts. No read follows the write.
//
// The photo carries a camera badge that opens the shared PhotoOptionsSheet ("Your
// photo"). The photo saves on its own, like WhatsApp: a picked file opens the
// AvatarCropper with "Use photo" and "Cancel"; Use photo crops, uploads
// (uploadAvatarFile) and saves (user_profile_update) at once with the SAVED name,
// designation and email preference, never unsaved form input. Save profile saves
// only the text fields and always sends NULL for the photo. Remove photo sends ''
// for the photo, which the proc treats as clear; only Remove sends ''. Every
// change refetches the shared profile store, so the header avatar follows.
// After a save that replaced or cleared a saved photo succeeds, the old object
// is handed to the avatar-upload worker's cleanup route (fire and forget).
//
// Network goes through the same tested helpers as onboarding (uploadAvatarFile +
// the @srtdio/rpc userProfileUpdate wrapper); colors are tokens only so light/dark
// parity is automatic.

import { useEffect, useRef, useState } from 'react';
import type { Client, Result, UserProfileUpdateArgs } from '@srtdio/rpc';
import { userProfileUpdate } from '@srtdio/rpc';
import { AvatarCropper, type AvatarCropperHandle } from '@/components/onboarding/AvatarCropper';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { UsernameField } from '@/components/settings/UsernameField';
import { Field } from '@/components/ui/Field';
import { IconCamera, ICON_SIZE } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { PhotoOptionsSheet } from '@/components/ui/PhotoOptionsSheet';
import { useOptionalToast } from '@/components/ui/toast';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { fireAvatarCleanup, makeAvatarCleanup, uploadAvatarFile } from '@/lib/avatar-upload';
import { generateTraceId } from '@/lib/trace';
import { useSession } from '@/lib/session-context';
import {
  setProfileEmailOptIn,
  useCurrentProfile,
  type CurrentProfile,
} from '@/lib/use-current-profile';

/** What a save does to the photo: leave it, replace it, or clear it. */
type PhotoChange = { kind: 'keep' } | { kind: 'set'; url: string } | { kind: 'clear' };

/** p_avatar_url for a change: NULL keeps the current photo, '' clears it. Pure. */
function avatarArg(change: PhotoChange): string | null {
  if (change.kind === 'keep') return null;
  if (change.kind === 'clear') return '';
  return change.url;
}

/** The user_profile_update args for one save. Pure. */
function profileUpdateArgs(input: {
  displayName: string;
  designation: string;
  emailOptIn: boolean;
  photo: PhotoChange;
  traceId: string;
}): UserProfileUpdateArgs {
  return {
    p_display_name: input.displayName,
    // The proc treats a blank designation as leave-unchanged, matching the
    // null intent; the generated arg type is a plain string, so blank stays ''.
    p_designation: input.designation,
    // The generated arg is `string`, but the proc takes NULL to keep the photo.
    p_avatar_url: avatarArg(input.photo) as string,
    p_email_opt_in: input.emailOptIn,
    p_trace_id: input.traceId,
  };
}

/** How the photo is sourced for a save: keep, clear, or upload a staged file. */
export type PhotoIntent =
  | { kind: 'keep' }
  | { kind: 'clear' }
  | { kind: 'upload'; upload: () => Promise<Result<{ avatarUrl: string }>> };

/**
 * Upload (when a new photo is staged) then save. Never throws; the first failing
 * step's error comes back. Dependencies are injected so it runs without a DOM.
 */
export async function submitProfileChange(deps: {
  client: Client;
  save: typeof userProfileUpdate;
  newTrace: () => string;
  displayName: string;
  designation: string;
  emailOptIn: boolean;
  photo: PhotoIntent;
  /** The avatar_url saved before this change; cleaned up once it is replaced. */
  previousAvatarUrl?: string | null;
  /** Deletes a replaced avatar object; started, never awaited, after a good save. */
  cleanup?: (oldUrl: string) => Promise<void>;
}): Promise<Result<void>> {
  let change: PhotoChange = { kind: 'keep' };
  if (deps.photo.kind === 'clear') change = { kind: 'clear' };
  if (deps.photo.kind === 'upload') {
    const up = await deps.photo.upload();
    if (!up.ok) return up;
    change = { kind: 'set', url: up.data.avatarUrl };
  }
  const saved = await deps.save(
    deps.client,
    profileUpdateArgs({
      displayName: deps.displayName,
      designation: deps.designation,
      emailOptIn: deps.emailOptIn,
      photo: change,
      traceId: deps.newTrace(),
    }),
  );
  if (!saved.ok) return saved;
  if (change.kind !== 'keep' && deps.cleanup !== undefined) {
    fireAvatarCleanup(
      deps.cleanup,
      deps.previousAvatarUrl,
      change.kind === 'set' ? change.url : '',
    );
  }
  return { ok: true, data: undefined };
}

/** The saved fields a photo-only change writes back unchanged. */
type SavedFields = Pick<CurrentProfile, 'display_name' | 'designation' | 'email_opt_in'> & {
  /** The saved photo, cleaned up once the new one is saved. */
  avatar_url?: string | null;
};

/**
 * Use photo: crop, upload, then save with the SAVED fields (never unsaved form
 * input). `onExported` hands the cropped file over for the optimistic preview
 * before the upload starts. Never throws. Dependencies are injected so it runs
 * without a DOM.
 */
export async function submitUsePhoto(deps: {
  client: Client;
  save: typeof userProfileUpdate;
  newTrace: () => string;
  saved: SavedFields;
  exportPng: () => Promise<File | null>;
  upload: (file: File) => Promise<Result<{ avatarUrl: string }>>;
  onExported: (file: File) => void;
  /** Deletes the replaced avatar object; started, never awaited, after a good save. */
  cleanup?: (oldUrl: string) => Promise<void>;
}): Promise<Result<{ avatarUrl: string }>> {
  const file = await deps.exportPng();
  if (file === null) {
    return {
      ok: false,
      error: { code: 'unknown', message: "Couldn't read the photo. Try again." },
    };
  }
  deps.onExported(file);
  let avatarUrl = '';
  const result = await submitProfileChange({
    client: deps.client,
    save: deps.save,
    newTrace: deps.newTrace,
    displayName: deps.saved.display_name,
    designation: deps.saved.designation ?? '',
    emailOptIn: deps.saved.email_opt_in,
    previousAvatarUrl: deps.saved.avatar_url ?? null,
    ...(deps.cleanup !== undefined ? { cleanup: deps.cleanup } : {}),
    photo: {
      kind: 'upload',
      upload: async () => {
        const up = await deps.upload(file);
        if (up.ok) avatarUrl = up.data.avatarUrl;
        return up;
      },
    },
  });
  if (!result.ok) return result;
  return { ok: true, data: { avatarUrl } };
}

/** Save profile: the text fields only; the photo is always NULL (keep). */
export function submitTextFields(deps: {
  client: Client;
  save: typeof userProfileUpdate;
  newTrace: () => string;
  displayName: string;
  designation: string;
  emailOptIn: boolean;
}): Promise<Result<void>> {
  return submitProfileChange({ ...deps, photo: { kind: 'keep' } });
}

/**
 * Catch-up emails tick: save with the SAVED fields (never unsaved form input),
 * the photo kept (NULL), only p_email_opt_in changed. Never throws.
 */
export function submitEmailOptIn(deps: {
  client: Client;
  save: typeof userProfileUpdate;
  newTrace: () => string;
  saved: Pick<CurrentProfile, 'display_name' | 'designation'>;
  emailOptIn: boolean;
}): Promise<Result<void>> {
  return submitProfileChange({
    client: deps.client,
    save: deps.save,
    newTrace: deps.newTrace,
    displayName: deps.saved.display_name,
    designation: deps.saved.designation ?? '',
    emailOptIn: deps.emailOptIn,
    photo: { kind: 'keep' },
  });
}

export const EMAIL_OPT_IN_FAILED = "Couldn't save. Try again.";

/**
 * One tick: apply `next` at once, save, and on failure revert to `previous` and
 * report, unless a newer tick has started (it owns the value now). Never throws.
 */
export async function tickEmailOptIn(deps: {
  previous: boolean;
  next: boolean;
  apply: (value: boolean) => void;
  submit: () => Promise<Result<void>>;
  isLatest: () => boolean;
  onFail: (message: string) => void;
}): Promise<void> {
  deps.apply(deps.next);
  const result = await deps.submit();
  if (result.ok || !deps.isLatest()) return;
  deps.apply(deps.previous);
  deps.onFail(result.error.message);
}

/** The panel's local photo override on top of the loaded avatar_url. */
export interface PhotoView {
  /** Object URL of the cropped PNG being (or just) saved. */
  previewUrl: string | null;
  /** The photo was removed here; show initials until the refetch lands. */
  removed: boolean;
  /**
   * The avatar_url the store should hold once the saved change is read back
   * ('' for a removal). While set, the override waits for that refetch.
   */
  expect: string | null;
}

export const PHOTO_VIEW_INITIAL: PhotoView = { previewUrl: null, removed: false, expect: null };

const SAVE_FALLBACK = "Couldn't save your profile. Try again.";

/** One readable line for a server / upload error. Pure. */
export function profileErrorMessage(message: string): string {
  const line = message.split('\n')[0]?.trim() ?? '';
  if (line.length === 0 || /^[a-z_]+$/.test(line)) return SAVE_FALLBACK;
  return line;
}

/**
 * The photo view and message once a change settles: success keeps `next`; a
 * failure reverts to `previous` (the photo shown before the change) and yields
 * the one-line message. Pure.
 */
export function settlePhotoChange<T>(
  result: Result<T>,
  previous: PhotoView,
  next: PhotoView,
): { photo: PhotoView; error: string | null } {
  if (result.ok) return { photo: next, error: null };
  return { photo: previous, error: profileErrorMessage(result.error.message) };
}

/**
 * Drop the override once the store holds the saved change, so the panel shows
 * the store's profile again and later photo changes (from anywhere) show. An
 * override with nothing expected (a change still in flight) is kept. Pure.
 */
export function reconcilePhotoView(view: PhotoView, avatarUrl: string | null): PhotoView {
  if (view.expect === null) return view;
  if ((avatarUrl ?? '') !== view.expect) return view;
  return PHOTO_VIEW_INITIAL;
}

/** The src the photo shows for a loaded avatar_url and the local view. Pure. */
export function shownPhoto(avatarUrl: string | null, view: PhotoView): string | null {
  if (view.previewUrl !== null) return view.previewUrl;
  if (view.removed) return null;
  return avatarUrl !== null && avatarUrl !== '' ? avatarUrl : null;
}

/**
 * Whether Remove photo is offered: only for a SAVED photo. A pick staged in the
 * cropper never feeds the view, so it never counts. Pure.
 */
export function canRemovePhoto(avatarUrl: string | null, view: PhotoView): boolean {
  return shownPhoto(avatarUrl, view) !== null;
}

/** The text fields and which of them the user has typed into. */
interface TextFields {
  name: string;
  designation: string;
  nameEdited: boolean;
  designationEdited: boolean;
  /** The user these fields were prefilled for; null before the first load. */
  prefilledFor: string | null;
}

export const TEXT_FIELDS_INITIAL: TextFields = {
  name: '',
  designation: '',
  nameEdited: false,
  designationEdited: false,
  prefilledFor: null,
};

/**
 * Prefill name and designation only on the first load for this user, never over
 * a field the user has edited. A later refetch (after Remove or Use photo) keeps
 * whatever is typed. Pure.
 */
export function prefillFields(
  fields: TextFields,
  userId: string | null,
  profile: CurrentProfile | null,
): TextFields {
  if (userId === null || profile === null || fields.prefilledFor === userId) return fields;
  return {
    name: fields.nameEdited ? fields.name : profile.display_name,
    designation: fields.designationEdited ? fields.designation : (profile.designation ?? ''),
    nameEdited: fields.nameEdited,
    designationEdited: fields.designationEdited,
    prefilledFor: userId,
  };
}

/**
 * What the panel renders. A kept profile always renders the panel, even when a
 * later read failed; the full error view is only for no profile at all. Pure.
 */
export function panelMode(
  loading: boolean,
  profile: CurrentProfile | null,
): 'loading' | 'error' | 'ready' {
  if (profile !== null) return 'ready';
  return loading ? 'loading' : 'error';
}

function revokeIfOwned(url: string | null): void {
  if (url !== null && url.startsWith('blob:')) URL.revokeObjectURL(url);
}

export function ProfileSettingsPanel(): React.ReactElement {
  const newTrace = useNewTrace();
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const { profile, loading, refetch } = useCurrentProfile();
  const cropperRef = useRef<AvatarCropperHandle>(null);

  const [fields, setFields] = useState<TextFields>(TEXT_FIELDS_INITIAL);
  const [photoView, setPhotoViewState] = useState<PhotoView>(PHOTO_VIEW_INITIAL);
  // The view's object URL, mirrored in a ref so replacement and unmount revoke it.
  const viewUrlRef = useRef<string | null>(null);
  // A pick sits in the cropper waiting for Use photo or Cancel.
  const [staged, setStaged] = useState(false);
  // Bumped by Cancel (and a saved photo) to remount the cropper empty.
  const [cropperKey, setCropperKey] = useState(0);
  const [photoSheetOpen, setPhotoSheetOpen] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const photoBusyRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const toast = useOptionalToast();
  // Only the newest tick may revert, so a late failure never undoes a later tick.
  const emailSeqRef = useRef(0);

  useEffect(
    () => () => {
      revokeIfOwned(viewUrlRef.current);
      viewUrlRef.current = null;
    },
    [],
  );

  // First load for this user fills the fields; later refetches keep the typing.
  useEffect(() => {
    setFields((current) => prefillFields(current, userId, profile));
  }, [userId, profile]);

  // Once the store holds the saved photo change, drop the local override.
  const avatarUrl = profile?.avatar_url ?? null;
  useEffect(() => {
    const next = reconcilePhotoView(photoView, avatarUrl);
    if (next === photoView) return;
    revokeIfOwned(viewUrlRef.current);
    viewUrlRef.current = next.previewUrl;
    setPhotoViewState(next);
  }, [photoView, avatarUrl]);

  const trimmedName = fields.name.trim();
  const busy = submitting || photoBusy;
  const canSave = profile !== null && !busy && trimmedName.length >= 1;

  function uploadFile(file: File): Promise<Result<{ avatarUrl: string }>> {
    return (async () => {
      const endpoint = env.VITE_AVATAR_UPLOAD_URL;
      if (endpoint === undefined) {
        return {
          ok: false,
          error: { code: 'unknown', message: "Couldn't upload the photo. Try again." },
        };
      }
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      return uploadAvatarFile(file, {
        endpoint,
        token,
        fetcher: (input, init) => fetchWithTrace(input, init, newTrace(), { timeoutMs: null }),
      });
    })();
  }

  // Fire and forget: one fresh trace per cleanup call, sent as X-Trace-Id.
  const cleanupAvatar = makeAvatarCleanup({
    endpoint: env.VITE_AVATAR_UPLOAD_URL,
    getToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
    apiKey: env.VITE_SUPABASE_PUBLISHABLE_KEY,
    fetcher: (input, init) => fetchWithTrace(input, init, generateTraceId()),
  });

  async function handleUsePhoto(): Promise<void> {
    if (profile === null || photoBusyRef.current) return;
    photoBusyRef.current = true;
    setPhotoBusy(true);
    setFormError(null);
    const previous = photoView;
    let optimisticUrl: string | null = null;
    try {
      const result = await submitUsePhoto({
        client: supabase,
        save: userProfileUpdate,
        newTrace,
        saved: profile,
        exportPng: async () => (await cropperRef.current?.exportPng()) ?? null,
        upload: uploadFile,
        cleanup: cleanupAvatar,
        onExported: (file) => {
          // Show the CROPPED png at once, never the raw original. The previous
          // URL is kept alive (not revoked) until the change settles.
          optimisticUrl = URL.createObjectURL(file);
          viewUrlRef.current = optimisticUrl;
          setPhotoViewState({ previewUrl: optimisticUrl, removed: false, expect: null });
        },
      });
      if (!result.ok) {
        logger.error('settings photo save failed', { error: result.error.message });
      }
      const settled = settlePhotoChange(result, previous, {
        previewUrl: optimisticUrl,
        removed: false,
        expect: result.ok ? result.data.avatarUrl : null,
      });
      if (settled.photo.previewUrl !== optimisticUrl) revokeIfOwned(optimisticUrl);
      else if (previous.previewUrl !== optimisticUrl) revokeIfOwned(previous.previewUrl);
      viewUrlRef.current = settled.photo.previewUrl;
      setPhotoViewState(settled.photo);
      setFormError(settled.error);
      if (!result.ok) return;
      setStaged(false);
      setCropperKey((key) => key + 1);
      refetch();
    } finally {
      photoBusyRef.current = false;
      setPhotoBusy(false);
    }
  }

  function handleEmailOptIn(next: boolean): void {
    if (profile === null || userId === null) return;
    const owner = userId;
    emailSeqRef.current += 1;
    const seq = emailSeqRef.current;
    // Fire and forget: the tick already shows the new value.
    void tickEmailOptIn({
      previous: profile.email_opt_in,
      next,
      apply: (value) => setProfileEmailOptIn(owner, value),
      submit: () =>
        submitEmailOptIn({
          client: supabase,
          save: userProfileUpdate,
          newTrace,
          saved: profile,
          emailOptIn: next,
        }),
      isLatest: () => seq === emailSeqRef.current,
      onFail: (message) => {
        logger.error('settings email opt-in save failed', { error: message });
        toast?.show({ title: EMAIL_OPT_IN_FAILED, tone: 'error' });
      },
    });
  }

  function handleCancelPhoto(): void {
    if (photoBusyRef.current) return;
    // Discard the pick: remount the cropper empty; nothing is uploaded.
    setStaged(false);
    setCropperKey((key) => key + 1);
    setFormError(null);
  }

  async function handleSave(): Promise<void> {
    if (profile === null) return;
    if (trimmedName.length < 1) {
      setFormError('Display name is required');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    setSaved(false);
    try {
      const result = await submitTextFields({
        client: supabase,
        save: userProfileUpdate,
        newTrace,
        displayName: trimmedName,
        designation: fields.designation.trim(),
        emailOptIn: profile.email_opt_in,
      });
      if (!result.ok) {
        logger.error('settings profile save failed', { error: result.error.message });
        setFormError(profileErrorMessage(result.error.message));
        return;
      }
      setSaved(true);
      // Propagate the new name to the rest of the app (header, comments).
      refetch();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemove(): Promise<void> {
    if (profile === null || photoBusyRef.current) return;
    photoBusyRef.current = true;
    setPhotoBusy(true);
    setFormError(null);
    const previous = photoView;
    // Removal paints the initials right away; a failure reverts below.
    const next: PhotoView = { previewUrl: null, removed: true, expect: '' };
    viewUrlRef.current = null;
    setPhotoViewState({ ...next, expect: null });
    try {
      // Clear with the saved fields so unsaved edits are not written by Remove.
      const result = await submitProfileChange({
        client: supabase,
        save: userProfileUpdate,
        newTrace,
        displayName: profile.display_name,
        designation: profile.designation ?? '',
        emailOptIn: profile.email_opt_in,
        photo: { kind: 'clear' },
        previousAvatarUrl: profile.avatar_url,
        cleanup: cleanupAvatar,
      });
      if (!result.ok) {
        logger.error('settings photo remove failed', { error: result.error.message });
      }
      const settled = settlePhotoChange(result, previous, next);
      if (result.ok) revokeIfOwned(previous.previewUrl);
      viewUrlRef.current = settled.photo.previewUrl;
      setPhotoViewState(settled.photo);
      setFormError(settled.error);
      if (result.ok) refetch();
    } finally {
      photoBusyRef.current = false;
      setPhotoBusy(false);
    }
  }

  const mode = panelMode(loading, profile);
  if (mode === 'loading') {
    return <div className="max-w-[520px] text-base text-fg-3">Loading</div>;
  }

  if (mode === 'error' || profile === null) {
    return (
      <div className="max-w-[520px] flex flex-col gap-3">
        <p className="text-base text-bad">{"Couldn't load your profile. Try again."}</p>
        <div>
          <Button onClick={refetch}>Retry</Button>
        </div>
      </div>
    );
  }

  const photoSrc = shownPhoto(profile.avatar_url, photoView);

  return (
    <div className="max-w-[520px] flex flex-col gap-4">
      <div className="flex flex-col items-start gap-3">
        <div className="relative h-[72px] w-[72px]">
          <Avatar
            key={photoSrc ?? 'none'}
            role="profile"
            name={trimmedName.length > 0 ? trimmedName : profile.display_name}
            {...(photoSrc !== null ? { src: photoSrc } : {})}
          />
          <CameraBadge disabled={busy} onPress={() => setPhotoSheetOpen(true)} />
        </div>
        {/* Always mounted so a picked file can be handed in; shown only while a
            pick waits for Use photo or Cancel. */}
        <div className={staged ? 'flex flex-col gap-3' : 'hidden'}>
          <AvatarCropper
            key={cropperKey}
            ref={cropperRef}
            hidePicker
            onPhotoChange={(info) => {
              setStaged(info.hasPhoto);
              setSaved(false);
            }}
          />
          <PhotoPickActions
            busy={photoBusy}
            onUse={() => void handleUsePhoto()}
            onCancel={handleCancelPhoto}
          />
        </div>
      </div>

      <PhotoOptionsSheet
        open={photoSheetOpen}
        onClose={() => setPhotoSheetOpen(false)}
        title="Your photo"
        hasPhoto={canRemovePhoto(profile.avatar_url, photoView)}
        onFile={(file) => {
          setFormError(null);
          cropperRef.current?.loadFile(file);
        }}
        onRemove={() => void handleRemove()}
      />

      <Field label="Display name" htmlFor="settings-display-name">
        <Input
          id="settings-display-name"
          value={fields.name}
          maxLength={80}
          placeholder="Your name"
          onChange={(event) => {
            const value = event.target.value;
            setFields((current) => ({ ...current, name: value, nameEdited: true }));
            setSaved(false);
          }}
        />
      </Field>

      <UsernameField current={profile?.username ?? null} onSaved={refetch} />

      <Field label="Designation" htmlFor="settings-designation">
        <Input
          id="settings-designation"
          value={fields.designation}
          maxLength={80}
          placeholder="e.g. Brand Manager"
          onChange={(event) => {
            const value = event.target.value;
            setFields((current) => ({ ...current, designation: value, designationEdited: true }));
            setSaved(false);
          }}
        />
      </Field>

      <EmailOptInRow checked={profile.email_opt_in} onChange={handleEmailOptIn} />

      {formError !== null ? <p className="text-base text-bad">{formError}</p> : null}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="primary"
          disabled={!canSave}
          onClick={() => void handleSave()}
        >
          {submitting ? 'Saving...' : 'Save profile'}
        </Button>
        {saved ? <span className="text-base text-fg-2">Saved</span> : null}
      </div>
    </div>
  );
}

/**
 * The camera badge. Its ring is the Settings page canvas (bg, the token html,
 * body and #root paint), so the badge reads as cut out of the page in light and
 * dark alike.
 */
export function CameraBadge(props: { disabled: boolean; onPress: () => void }): React.ReactElement {
  return (
    <Button
      type="button"
      variant="ghost"
      shape="round"
      aria-label="Change photo"
      disabled={props.disabled}
      onClick={props.onPress}
      className="absolute -bottom-1 -right-1"
    >
      <span
        data-camera-badge=""
        aria-hidden="true"
        className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-accent-fg ring-2 ring-bg"
      >
        <IconCamera size={ICON_SIZE.inline} />
      </span>
    </Button>
  );
}

/**
 * Catch-up emails: the same native tick box as sign-up. The whole label is the
 * 44px tap target; the helper sits under the label text.
 */
export function EmailOptInRow(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
}): React.ReactElement {
  return (
    <label
      htmlFor="settings-email-opt-in"
      className="flex min-h-11 cursor-pointer items-start gap-3 py-1"
    >
      <span className="flex h-6 shrink-0 items-center">
        <input
          id="settings-email-opt-in"
          type="checkbox"
          checked={props.checked}
          aria-describedby="settings-email-opt-in-help"
          onChange={(event) => props.onChange(event.target.checked)}
          className="m-0 h-4 w-4 shrink-0 accent-accent"
        />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-base text-fg">Catch-up emails</span>
        <span id="settings-email-opt-in-help" className="text-sm text-fg-2">
          Unread updates by email, weekdays. Sign-in codes and invites always arrive.
        </span>
      </span>
    </label>
  );
}

/** Use photo (primary) and Cancel under the cropper; both disabled mid-upload. */
export function PhotoPickActions(props: {
  busy: boolean;
  onUse: () => void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-3">
      <Button
        type="button"
        variant="primary"
        data-action="use-photo"
        disabled={props.busy}
        onClick={props.onUse}
      >
        {props.busy ? 'Saving...' : 'Use photo'}
      </Button>
      <Button
        type="button"
        data-action="cancel-photo"
        disabled={props.busy}
        onClick={props.onCancel}
      >
        Cancel
      </Button>
    </div>
  );
}
