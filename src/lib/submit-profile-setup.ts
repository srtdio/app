// Submit orchestration for the onboarding profile-setup screen. Mirrors the
// extracted-and-tested submitCreatePost pattern (src/components/pages/CreatePostSheet.tsx):
// every dependency is injected so the two-step wiring (upload avatar, then save
// profile) is unit-testable without a canvas or a real network. Surfaces the
// first failing step's error; never throws.

import type { Client, Result } from '@srtdio/rpc';
import { userProfileUpdate } from '@srtdio/rpc';

export interface SubmitProfileSetupDeps {
  client: Client;
  file: File;
  displayName: string;
  designation: string | null;
  emailOptIn: boolean;
  uploadAvatar: (file: File) => Promise<Result<{ avatarUrl: string }>>;
  /** Injected for testing; the app passes the @srtdio/rpc wrapper. */
  saveProfile: typeof userProfileUpdate;
  newTrace: () => string;
}

/**
 * Upload the cropped avatar, then save the profile with the returned URL. If the
 * upload fails we return that error and never touch saveProfile (no half-written
 * profile pointing at a missing avatar). The proc requires a string designation,
 * so a null (no designation) is sent as the empty string the proc coalesces.
 */
export async function submitProfileSetup(deps: SubmitProfileSetupDeps): Promise<Result<void>> {
  const up = await deps.uploadAvatar(deps.file);
  if (!up.ok) return up;

  const saved = await deps.saveProfile(deps.client, {
    p_display_name: deps.displayName,
    p_designation: deps.designation ?? '',
    p_avatar_url: up.data.avatarUrl,
    p_email_opt_in: deps.emailOptIn,
    p_trace_id: deps.newTrace(),
  });
  if (!saved.ok) return saved;

  return { ok: true, data: undefined };
}
