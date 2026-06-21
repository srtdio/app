// Full-screen, no-chrome onboarding profile setup. A brand-new user (just past an
// invite) must finish this before the app is reachable: choose + crop a photo,
// enter their name (required) and designation (optional), and set the daily
// catch-up email preference. On save the cropped PNG goes to the avatar-upload
// Worker and the returned URL plus the fields are written via user_profile_update;
// the shell gate (AppLayout) then falls the user through into the Pipeline.
//
// All network goes through injected, tested helpers (uploadAvatarFile +
// submitProfileSetup); this file owns only the form state, the live previews and
// the submit wiring. Colors are tokens only so light/dark parity is automatic.

import { useRef, useState } from 'react';
import { userProfileUpdate } from '@srtdio/rpc';
import { AvatarCropper, type AvatarCropperHandle } from '@/components/onboarding/AvatarCropper';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { logger } from '@/lib/logger';
import { submitProfileSetup } from '@/lib/submit-profile-setup';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { uploadAvatarFile } from '@/lib/avatar-upload';

interface OnboardingProfileFormProps {
  initialDisplayName: string;
  initialDesignation: string | null;
  initialEmailOptIn: boolean;
  onComplete: () => void;
}

export function OnboardingProfileForm({
  initialDisplayName,
  initialDesignation,
  initialEmailOptIn,
  onComplete,
}: OnboardingProfileFormProps): React.ReactElement {
  const newTrace = useNewTrace();
  const cropperRef = useRef<AvatarCropperHandle>(null);

  const [name, setName] = useState(initialDisplayName);
  const [designation, setDesignation] = useState(initialDesignation ?? '');
  const [emailOptIn, setEmailOptIn] = useState(initialEmailOptIn);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [photoLoaded, setPhotoLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const endpoint = env.VITE_AVATAR_UPLOAD_URL;
  const uploadConfigured = endpoint !== undefined;

  const trimmedName = name.trim();
  const trimmedDesignation = designation.trim();
  const canSubmit = photoLoaded && trimmedName.length >= 1 && uploadConfigured && !submitting;

  async function handleSubmit(): Promise<void> {
    if (endpoint === undefined) return;
    const cropper = cropperRef.current;
    if (!cropper) return;

    setSubmitting(true);
    setError(null);

    const file = await cropper.exportPng();
    if (!file) {
      setError('Could not read the photo. Choose it again');
      setSubmitting(false);
      return;
    }

    const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
    const uploadAvatar = (toUpload: File) =>
      uploadAvatarFile(toUpload, {
        endpoint,
        token,
        fetcher: (input, init) => fetchWithTrace(input, init, newTrace()),
      });

    const result = await submitProfileSetup({
      client: supabase,
      file,
      displayName: trimmedName,
      designation: trimmedDesignation === '' ? null : trimmedDesignation,
      emailOptIn,
      uploadAvatar,
      saveProfile: userProfileUpdate,
      newTrace,
    });

    if (!result.ok) {
      logger.error('onboarding profile save failed', { error: result.error.message });
      setError(result.error.message);
      setSubmitting(false);
      return;
    }
    onComplete();
  }

  const previewName = trimmedName.length > 0 ? trimmedName : 'Your name';
  const avatarSrcProps = previewUrl !== null ? { src: previewUrl } : {};

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-bg"
      style={{
        paddingTop: 'max(1.5rem, env(safe-area-inset-top))',
        paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))',
        paddingLeft: 'max(1rem, env(safe-area-inset-left))',
        paddingRight: 'max(1rem, env(safe-area-inset-right))',
      }}
    >
      <div className="mx-auto w-full max-w-[480px] rounded-xl border border-border bg-panel p-6">
        <h1 className="text-lg font-semibold text-fg">Set up your profile</h1>
        <p className="mt-1.5 text-sm text-fg-2">
          Your photo and name appear on every comment, approval and notification. Finishing this is
          required to enter the app.
        </p>

        <div className="mt-6">
          <AvatarCropper
            ref={cropperRef}
            onPhotoChange={(info) => {
              setPhotoLoaded(info.hasPhoto);
              setPreviewUrl(info.previewUrl);
            }}
          />
        </div>

        <div className="mt-6 space-y-4">
          <Field label="Full name" htmlFor="onboarding-name" required>
            <Input
              id="onboarding-name"
              value={name}
              maxLength={80}
              placeholder="e.g. Ada Lovelace"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <Field label="Designation" htmlFor="onboarding-designation" hint="Optional">
            <Input
              id="onboarding-designation"
              value={designation}
              maxLength={80}
              placeholder="e.g. Brand Manager"
              onChange={(event) => setDesignation(event.target.value)}
            />
          </Field>

          <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-panel-2 p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg">Email me the daily catch-up</p>
              <p className="mt-0.5 text-[11px] text-fg-3">One digest, 9am to 9pm your time.</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={emailOptIn}
              aria-label="Email me the daily catch-up"
              onClick={() => setEmailOptIn((value) => !value)}
              className={cn(
                'relative inline-flex h-11 w-[60px] shrink-0 items-center rounded-full px-1 transition-colors',
                emailOptIn ? 'bg-accent' : 'bg-panel-3',
              )}
            >
              <span
                className={cn(
                  'h-7 w-7 rounded-full bg-panel transition-transform',
                  emailOptIn ? 'translate-x-[26px]' : 'translate-x-0',
                )}
              />
            </button>
          </div>
        </div>

        <div className="mt-6">
          <p className="mb-2 text-xs font-medium text-fg-2">How you will appear</p>
          <div className="space-y-2">
            {/* Comment-style row */}
            <div className="flex items-center gap-2.5 rounded-md border border-border bg-panel-2 p-2.5">
              <Avatar name={previewName} {...avatarSrcProps} size="md" />
              <p className="min-w-0 truncate text-sm text-fg">
                <span className="font-medium">{previewName}</span>
                <span className="text-fg-3"> commented on a post</span>
              </p>
            </div>

            {/* Notification-style row */}
            <div className="flex items-center gap-2.5 rounded-md border border-border bg-panel-2 p-2.5">
              <Avatar name={previewName} {...avatarSrcProps} size="md" />
              <p className="min-w-0 truncate text-sm text-fg-2">
                <span className="font-medium text-fg">{previewName}</span> approved your post
              </p>
            </div>

            {/* Workspace-chip row */}
            <div className="inline-flex items-center gap-2 rounded-full border border-border bg-panel-2 px-2.5 py-1.5">
              <Avatar name={previewName} {...avatarSrcProps} size="sm" />
              <span className="text-sm font-medium text-fg">{previewName}</span>
              <span className="text-xs text-fg-3">
                {trimmedDesignation.length > 0 ? trimmedDesignation : 'Set a designation'}
              </span>
            </div>
          </div>
        </div>

        {!uploadConfigured ? (
          <p className="mt-4 text-sm text-bad">
            Photo upload is not configured, so the profile cannot be saved yet. Contact your admin.
          </p>
        ) : null}

        {error !== null ? <p className="mt-4 text-sm text-bad">{error}</p> : null}

        <Button
          type="button"
          variant="primary"
          size="lg"
          disabled={!canSubmit}
          onClick={() => void handleSubmit()}
          className="mt-6 w-full"
          style={{ minHeight: 52 }}
        >
          {submitting ? 'Saving...' : 'Save and continue'}
        </Button>
      </div>
    </div>
  );
}
