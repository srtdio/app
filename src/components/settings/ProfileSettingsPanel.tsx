// Settings -> Profile editor. Unlike onboarding, the photo is OPTIONAL here: the
// user can rename or re-title without re-uploading. So this panel does NOT reuse
// submit-profile-setup (which hard-requires a file); it orchestrates its own
// upload-then-save, only uploading when the cropper actually holds a new photo and
// otherwise re-passing the existing avatar_url (harmless). The email preference is
// passed through unchanged because there is no toggle on this screen.
//
// Network goes through the same tested helpers as onboarding (uploadAvatarFile +
// the @srtdio/rpc userProfileUpdate wrapper); colors are tokens only so light/dark
// parity is automatic.

import { useEffect, useRef, useState } from 'react';
import { userProfileUpdate } from '@srtdio/rpc';
import { AvatarCropper, type AvatarCropperHandle } from '@/components/onboarding/AvatarCropper';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { uploadAvatarFile } from '@/lib/avatar-upload';
import { useCurrentProfile } from '@/lib/use-current-profile';

export function ProfileSettingsPanel(): React.ReactElement {
  const newTrace = useNewTrace();
  const { profile, loading, error, refetch } = useCurrentProfile();
  const cropperRef = useRef<AvatarCropperHandle>(null);

  const [name, setName] = useState('');
  const [designation, setDesignation] = useState('');
  // The cropper's live object URL once a new photo is staged; null until then so
  // the existing avatar_url stays visible.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Prefill once the profile loads (and whenever a refetch lands a new row).
  useEffect(() => {
    if (profile === null) return;
    setName(profile.display_name);
    setDesignation(profile.designation ?? '');
  }, [profile]);

  const trimmedName = name.trim();
  const canSave = !loading && profile !== null && !submitting && trimmedName.length >= 1;

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
      const trimmedDesignation = designation.trim();
      // Default: keep the existing photo by re-passing its URL unchanged.
      let avatarUrl = profile.avatar_url ?? '';

      // Only upload when the user actually picked a new photo.
      if (cropperRef.current?.hasPhoto() === true) {
        const endpoint = env.VITE_AVATAR_UPLOAD_URL;
        if (endpoint === undefined) {
          setFormError('Photo upload is not configured');
          return;
        }
        const file = await cropperRef.current.exportPng();
        if (file === null) {
          setFormError('Could not read the photo. Choose it again');
          return;
        }
        const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
        const up = await uploadAvatarFile(file, {
          endpoint,
          token,
          fetcher: (input, init) => fetchWithTrace(input, init, newTrace()),
        });
        if (!up.ok) {
          setFormError(up.error.message);
          return;
        }
        avatarUrl = up.data.avatarUrl;
      }

      const result = await userProfileUpdate(supabase, {
        p_display_name: trimmedName,
        // The proc treats a blank designation as leave-unchanged, matching the
        // null intent; the generated arg type is a plain string, so blank stays ''.
        p_designation: trimmedDesignation,
        p_avatar_url: avatarUrl,
        // No toggle here: pass the loaded preference through unchanged.
        p_email_opt_in: profile.email_opt_in,
        p_trace_id: newTrace(),
      });
      if (!result.ok) {
        logger.error('settings profile save failed', { error: result.error.message });
        setFormError(result.error.message);
        return;
      }

      setSaved(true);
      // Propagate the new name/photo to the rest of the app (header, comments).
      refetch();
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <div className="max-w-[520px] text-sm text-fg-3">Loading</div>;
  }

  if (error || profile === null) {
    return (
      <div className="max-w-[520px] flex flex-col gap-3">
        <p className="text-sm text-bad">Could not load your profile.</p>
        <div>
          <Button onClick={refetch}>Retry</Button>
        </div>
      </div>
    );
  }

  const avatarSrcProps =
    previewUrl !== null
      ? { src: previewUrl }
      : profile.avatar_url
        ? { src: profile.avatar_url }
        : {};

  return (
    <div className="max-w-[520px] flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Avatar
          size="lg"
          name={trimmedName.length > 0 ? trimmedName : profile.display_name}
          {...avatarSrcProps}
        />
        <AvatarCropper
          ref={cropperRef}
          onPhotoChange={(info) => {
            setPreviewUrl(info.previewUrl);
            setSaved(false);
          }}
        />
      </div>

      <Field label="Display name" htmlFor="settings-display-name">
        <Input
          id="settings-display-name"
          value={name}
          maxLength={80}
          placeholder="Your name"
          onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
          }}
        />
      </Field>

      <Field label="Designation" htmlFor="settings-designation">
        <Input
          id="settings-designation"
          value={designation}
          maxLength={80}
          placeholder="e.g. Brand Manager"
          onChange={(event) => {
            setDesignation(event.target.value);
            setSaved(false);
          }}
        />
      </Field>

      {formError !== null ? <p className="text-sm text-bad">{formError}</p> : null}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="primary"
          size="lg"
          disabled={!canSave}
          onClick={() => void handleSave()}
        >
          {submitting ? 'Saving...' : 'Save profile'}
        </Button>
        {saved ? <span className="text-sm text-fg-2">Saved</span> : null}
      </div>
    </div>
  );
}
