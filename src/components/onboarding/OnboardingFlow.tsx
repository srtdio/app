// Full-screen pre-app screens, one question per screen, before the shell. The
// shell (AppLayout) shows them to anyone whose profile is unfinished, and to an
// approver who signed up alone and is waiting for their team. Everything after
// them happens on the real screens with the guide on top (src/components/induction).
//
// Which screens a person walks comes from stepsFor (src/lib/onboarding.ts):
//   self sign-up, Creator:  side, name, role, then the shell (make the workspace)
//   self sign-up, Approver: side, name, role, brand, waiting
// An approver who picked the wrong side goes back to the side screen from the
// brand screen ("Wrong role? Change it") or leaves the wait as a Creator.
//   invitee:                welcome, name, role, then the shell
//
// The invitee's link already signed them in and invite-accept already ran, so
// the welcome only greets them: workspace, platform, who invited them and the
// signed-in email. Their side comes only from workspace_members.role; the role
// dropdown is a designation and never changes permissions.
//
// Nothing here refetches the profile or the workspace list until the very end
// (finish), because either refetch flips the shell gate and would unmount the
// flow mid-way. Colors are tokens only, so light and dark both hold.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { PLATFORM_LABELS, isPostPlatform } from '@srtdio/posts';
import { userOnboardingSave } from '@srtdio/rpc';
import type { Json } from '@srtdio/schemas';
import { AvatarCropper, type AvatarCropperHandle } from '@/components/onboarding/AvatarCropper';
import { isValidInviteEmail } from '@/components/pages/settings/MembersInviteForm';
import { Wordmark } from '@/components/home/Wordmark';
import { EntryHand } from '@/components/induction/EntryHand';
import { readLatestBrandRequest, requestBrandTeam } from '@/components/induction/induction-data';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { PlatformMark } from '@/components/ui/PlatformMark';
import { Select } from '@/components/ui/Select';
import { Sheet } from '@/components/ui/Sheet';
import { uploadAvatarFile } from '@/lib/avatar-upload';
import { cn } from '@/lib/cn';
import { env } from '@/lib/env';
import { SIGNOUT_EVENT, dispatchSorted } from '@/lib/events';
import { fetchWithTrace } from '@/lib/fetch';
import { ONBOARDING_COPY, WELCOME_COPY, fillCopy } from '@/lib/induction-copy';
import {
  APPROVER_BRAND_STEP,
  APPROVER_WAITING_STEP,
  brandRequestErrorMessage,
  INDUCTION_KEYS,
  WORKSPACE_STEP,
  type ApproverStage,
  type InductionKey,
} from '@/lib/induction';
import { logger } from '@/lib/logger';
import { clearDraft, readDraft, writeDraft } from '@/lib/onboarding-draft';
import {
  OTHER_ROLE,
  ROLE_TILES,
  SIDE_TILES,
  designationFor,
  entryCopyContext,
  entryHandTarget,
  normalizeUsernameInput,
  notYouPath,
  progressSteps,
  setupCounter,
  sideForMemberRole,
  stepsFor,
  suggestUsername,
  usernameFormat,
  type OnboardingStep,
  type Side,
} from '@/lib/onboarding';
import { performSignout, useSession } from '@/lib/session-context';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { checkUsername } from '@/lib/username-check';
import type { CurrentProfile } from '@/lib/use-current-profile';

interface OnboardingFlowProps {
  profile: CurrentProfile | null;
  /** The invitee's workspace (already joined); null for a self sign-up. */
  workspaceId: string | null;
  workspaceName: string | null;
  /** An approver who signed up alone: resume on naming their team, or on the wait. */
  approverStage: ApproverStage;
  /** Store the induction step (induction_step_set); resolves false when it did not save. */
  onStep: (step: string) => Promise<boolean>;
  /**
   * Done: the shell refetches profile and workspaces, then opens `to`. The flow
   * stays mounted (busy) until both have landed, so nothing flickers.
   */
  onFinish: (to: string) => void;
  /** Set when the finish refetch failed: the flow re-enables and shows it. */
  finishError: string | null;
}

type NameCheck = 'idle' | 'checking' | 'free' | 'taken' | 'error';

/** Where a finished Creator or invitee lands: the shell takes it from there. */
const SHELL_HOME = '/pipeline';

/** What the invited welcome shows, read once for the joined workspace. */
interface WelcomeFacts {
  loaded: boolean;
  /** workspace_members.id, which is also the invite id invite-accept took. */
  inviteId: string;
  side: Side;
  /** users.display_name of workspace_members.invited_by; '' when unknown. */
  inviter: string;
  /** workspaces.name; '' until read. */
  brand: string;
  /** workspaces.platform; '' until read. */
  platform: string;
}

const NO_WELCOME_FACTS: WelcomeFacts = {
  loaded: false,
  inviteId: '',
  side: 'creator',
  inviter: '',
  brand: '',
  platform: '',
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The person's active membership in the joined workspace (RLS: own rows). */
async function readMembership(ids: {
  workspaceId: string;
  userId: string;
}): Promise<{ id: string; role: string; invitedBy: string }> {
  const { data, error } = await supabase
    .from('workspace_members')
    .select('id, role, invited_by')
    .eq('workspace_id', ids.workspaceId)
    .eq('user_id', ids.userId)
    .eq('active', true)
    .maybeSingle();
  if (error) logger.warn('welcome: membership read failed', { error: error.message });
  const row: Record<string, unknown> = data ?? {};
  return { id: text(row.id), role: text(row.role), invitedBy: text(row.invited_by) };
}

/** The joined workspace's own name and platform. */
async function readWorkspace(workspaceId: string): Promise<{ name: string; platform: string }> {
  const { data, error } = await supabase
    .from('workspaces')
    .select('name, platform')
    .eq('id', workspaceId)
    .maybeSingle();
  if (error) logger.warn('welcome: workspace read failed', { error: error.message });
  const row: Record<string, unknown> = data ?? {};
  return { name: text(row.name), platform: text(row.platform) };
}

/** A co-member's display name (users is readable by co-members); '' when unread. */
async function readDisplayName(userId: string): Promise<string> {
  if (userId === '') return '';
  const { data, error } = await supabase
    .from('users')
    .select('display_name')
    .eq('id', userId)
    .maybeSingle();
  if (error) logger.warn('welcome: inviter read failed', { error: error.message });
  const row: Record<string, unknown> = data ?? {};
  return text(row.display_name);
}

async function readWelcomeFacts(ids: {
  workspaceId: string;
  userId: string;
}): Promise<WelcomeFacts> {
  const [member, workspace] = await Promise.all([
    readMembership(ids),
    readWorkspace(ids.workspaceId),
  ]);
  const inviter = await readDisplayName(member.invitedBy);
  return {
    loaded: true,
    inviteId: member.id,
    side: sideForMemberRole(member.role),
    inviter,
    brand: workspace.name,
    platform: workspace.platform,
  };
}

export function OnboardingFlow({
  profile,
  workspaceId: joinedWorkspaceId,
  workspaceName: joinedWorkspaceName,
  approverStage,
  onStep,
  onFinish,
  finishError,
}: OnboardingFlowProps): ReactElement {
  const newTrace = useNewTrace();
  const navigate = useNavigate();
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const email = session?.user.email ?? '';
  const invitee = joinedWorkspaceId !== null;
  // Answers kept on this device from before a refresh, read once.
  const [draft] = useState(() => readDraft(userId));
  // Set once the profile is saved: nothing more is kept on the device after that.
  const draftDone = useRef(false);

  // The side: picked on the first screen, or the invite's role for an invitee.
  const [side, setSide] = useState<Side | null>(
    approverStage !== 'none' ? 'approver' : (draft?.side ?? null),
  );
  // Back on the side screen after the profile is saved, to change a wrong side.
  const [changingSide, setChangingSide] = useState(false);
  const [welcome, setWelcome] = useState<WelcomeFacts>(NO_WELCOME_FACTS);
  const shownSide: Side = invitee ? welcome.side : (side ?? 'creator');
  // Fixed at mount except for the approver's tail, which follows the side picked.
  const [profileIncomplete] = useState(profile === null || profile.profile_completed_at === null);
  const steps = stepsFor({
    profileIncomplete,
    hasWorkspace: invitee,
    side: shownSide,
    approverStage,
  });
  // After a refresh, the screen the person was on (when it is still one of theirs).
  const [index, setIndex] = useState(() => {
    const at = draft === undefined ? -1 : steps.indexOf(draft.step);
    return at < 0 ? 0 : at;
  });
  const step: OnboardingStep = changingSide ? 'side' : (steps[index] ?? 'waiting');

  // Profile answers
  // A new account's display_name is the email's local part (signup trigger), not
  // a real name: start blank then, so nobody becomes "connect" by default.
  const [name, setName] = useState(() => {
    if (draft !== undefined) return draft.name;
    const current = profile?.display_name ?? '';
    return current === email.split('@')[0] ? '' : current;
  });
  const [username, setUsername] = useState(draft?.username ?? '');
  const [usernameEdited, setUsernameEdited] = useState(draft?.usernameEdited ?? false);
  const [nameCheck, setNameCheck] = useState<NameCheck>('idle');
  // The photo: picked from the device, positioned in a sheet (so the name and
  // username stay on screen), kept as the cropped file and uploaded with the
  // profile save.
  const [photoPreview, setPhotoPreview] = useState<string | null>(
    draft !== undefined && draft.avatarUrl !== '' ? draft.avatarUrl : null,
  );
  // The uploaded photo's URL, kept so a refresh does not ask for the photo again.
  const [uploadedAvatar, setUploadedAvatar] = useState(draft?.avatarUrl ?? '');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  // The photo's upload, started when it is applied so it is done (or nearly)
  // by the time the title is saved.
  const photoUpload = useRef<{ file: File; url: Promise<string | null> } | null>(null);
  const [cropOpen, setCropOpen] = useState(false);
  // The positioning sheet's photo has loaded and can be used.
  const [cropReady, setCropReady] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cropperRef = useRef<AvatarCropperHandle | null>(null);
  const pickedRef = useRef<File | null>(null);
  // The cropper mounts inside the sheet: hand it the picked file as soon as it exists.
  const attachCropper = useCallback((handle: AvatarCropperHandle | null) => {
    cropperRef.current = handle;
    const picked = pickedRef.current;
    if (handle !== null && picked !== null) {
      // After the mount settles: a remount in development would cancel an
      // image that started loading during the first mount.
      window.setTimeout(() => {
        if (pickedRef.current !== picked) return;
        pickedRef.current = null;
        cropperRef.current?.loadFile(picked);
      }, 0);
    }
  }, []);
  const [role, setRole] = useState(draft?.role ?? '');
  const [roleOther, setRoleOther] = useState(draft?.roleOther ?? '');
  const [emailOptIn] = useState(profile?.email_opt_in ?? true);

  // The approver who signed up alone: who makes their posts.
  const [teamEmail, setTeamEmail] = useState(draft?.teamEmail ?? '');
  const [brandName, setBrandName] = useState(draft?.brandName ?? '');
  const [resent, setResent] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A photo that did not upload: the profile saved without it, and this says so.
  const [photoNotice, setPhotoNotice] = useState<string | null>(null);
  // A Creator whose photo did not upload stays to read that, then goes on.
  const [readyForShell, setReadyForShell] = useState(false);

  const shownUsername = usernameEdited ? username : suggestUsername(name);
  const format = usernameFormat(shownUsername);
  const designation = designationFor(role, roleOther);

  // Live username check, debounced; only well-formed names reach the server.
  useEffect(() => {
    if (format !== 'ok') {
      setNameCheck('idle');
      return;
    }
    setNameCheck('checking');
    let cancelled = false;
    const id = window.setTimeout(() => {
      void checkUsername(shownUsername, newTrace).then((result) => {
        if (!cancelled) setNameCheck(result);
      });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [shownUsername, format, newTrace]);

  // Invitee: the welcome facts, and their side, which comes only from the membership role.
  useEffect(() => {
    if (joinedWorkspaceId === null || userId === null) return;
    let cancelled = false;
    void readWelcomeFacts({ workspaceId: joinedWorkspaceId, userId })
      .then((facts) => {
        if (!cancelled) setWelcome(facts);
      })
      .catch((err: unknown) => {
        logger.warn('welcome: read failed', { error: String(err) });
        if (!cancelled) setWelcome({ ...NO_WELCOME_FACTS, loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, [joinedWorkspaceId, userId]);

  // The waiting screen after a reload: the last request, for Resend.
  useEffect(() => {
    if (step !== 'waiting' || userId === null || teamEmail !== '') return;
    let cancelled = false;
    void readLatestBrandRequest(supabase, userId).then((found) => {
      if (cancelled || found === undefined) return;
      setTeamEmail(found.email);
      setBrandName(found.brandName);
    });
    return () => {
      cancelled = true;
    };
  }, [step, userId, teamEmail]);

  useEffect(() => {
    if (finishError === null) return;
    setBusy(false);
    setError(finishError);
  }, [finishError]);

  // Keep every answer on this device until the profile is saved (refresh-safe).
  useEffect(() => {
    if (!profileIncomplete || draftDone.current) return;
    writeDraft(userId, {
      step,
      side,
      name,
      username,
      usernameEdited,
      role,
      roleOther,
      avatarUrl: uploadedAvatar,
      teamEmail,
      brandName,
    });
  }, [
    profileIncomplete,
    userId,
    step,
    side,
    name,
    username,
    usernameEdited,
    role,
    roleOther,
    uploadedAvatar,
    teamEmail,
    brandName,
  ]);

  const progress = progressSteps(steps);
  const progressAt = changingSide ? -1 : progress.indexOf(step);

  function next(): void {
    setError(null);
    if (index < steps.length - 1) setIndex(index + 1);
    else finish(SHELL_HOME);
  }

  function back(): void {
    setError(null);
    if (changingSide) {
      // Changed their mind about changing: still the approver they saved as.
      setChangingSide(false);
      setSide('approver');
      return;
    }
    if (step === 'brand') {
      setChangingSide(true);
      return;
    }
    if (index > 0) setIndex(index - 1);
  }

  /** The side saved after the profile: stored as the first save stored it (the induction step). */
  async function confirmSide(): Promise<void> {
    if (side === 'creator') {
      await switchToCreator();
      return;
    }
    setBusy(true);
    setError(null);
    const saved = await onStep(APPROVER_BRAND_STEP);
    setBusy(false);
    if (!saved) {
      setError("We couldn't save that. Try again.");
      return;
    }
    setChangingSide(false);
    setIndex(Math.max(0, steps.indexOf('brand')));
  }

  /** An approver who makes the posts after all: on to the shell to make the workspace. */
  async function switchToCreator(): Promise<void> {
    setBusy(true);
    setError(null);
    const saved = await onStep(WORKSPACE_STEP);
    if (!saved) {
      setBusy(false);
      setError("We couldn't save that. Try again.");
      return;
    }
    finish(SHELL_HOME);
  }

  /** Signed up with the wrong email: sign out on this device, then sign up again. */
  async function startOverWithNewEmail(): Promise<void> {
    setBusy(true);
    await performSignout(supabase);
    navigate('/signup', { replace: true });
  }

  function finish(to: string): void {
    draftDone.current = true;
    clearDraft(userId);
    setBusy(true);
    onFinish(to);
  }

  /** "Not you?": sign out on this device, then sign in again on the way back to the invite. */
  async function notYou(): Promise<void> {
    setBusy(true);
    await performSignout(supabase);
    navigate(notYouPath(welcome.inviteId), { replace: true });
  }

  /** The photo's upload: the one already started for this file, or a new one. */
  function uploadPhoto(file: File): Promise<string | null> {
    const started = photoUpload.current;
    if (started !== null && started.file === file) return started.url;
    const endpoint = env.VITE_AVATAR_UPLOAD_URL;
    const url =
      endpoint === undefined
        ? Promise.resolve(null)
        : supabase.auth
            .getSession()
            .then(({ data }) =>
              uploadAvatarFile(file, {
                endpoint,
                token: data.session?.access_token ?? null,
                fetcher: (input, init) => fetchWithTrace(input, init, newTrace()),
              }),
            )
            .then((up) => (up.ok ? up.data.avatarUrl : null))
            .catch(() => null);
    const entry = { file, url };
    photoUpload.current = entry;
    // A failed upload is not kept: the next save tries again.
    void url.then((done) => {
      if (photoUpload.current !== entry) return;
      if (done === null) photoUpload.current = null;
      else setUploadedAvatar(done);
    });
    return url;
  }

  /** The photo (already uploading since it was applied), then the whole profile in one call. */
  async function saveProfile(): Promise<void> {
    setBusy(true);
    setError(null);
    // A photo uploaded before a refresh is already there: no file to send again.
    let avatarUrl: string | null =
      photoFile === null && uploadedAvatar !== '' ? uploadedAvatar : null;
    // The photo is optional: one that did not upload never holds up the profile.
    let photoFailed = false;
    if (photoFile !== null && env.VITE_AVATAR_UPLOAD_URL !== undefined) {
      avatarUrl = await uploadPhoto(photoFile);
      photoFailed = avatarUrl === null;
    }
    const payload: Record<string, Json> = {
      display_name: name.trim(),
      username: shownUsername,
      designation,
      email_opt_in: emailOptIn,
    };
    if (avatarUrl !== null) payload.avatar_url = avatarUrl;
    const saved = await userOnboardingSave(supabase, {
      p_payload: payload as Json,
      p_trace_id: newTrace(),
    });
    if (!saved.ok) {
      setBusy(false);
      if (saved.error.message.includes('username_taken')) {
        setNameCheck('taken');
        setIndex(steps.indexOf('name'));
        setError('That username was just taken. Pick another.');
        return;
      }
      logger.error('onboarding save failed', { error: saved.error.message });
      setError("We couldn't save that. Try again.");
      return;
    }
    // Saved: the profile itself now says where to resume, the draft is done.
    draftDone.current = true;
    clearDraft(userId);
    if (photoFailed) {
      setPhotoFile(null);
      setPhotoPreview(null);
      setPhotoNotice(ONBOARDING_COPY.photoUploadFailed);
    }
    // A Creator makes the workspace in the shell; an approver goes on to name their team.
    if (!invitee && shownSide === 'creator') {
      await onStep(WORKSPACE_STEP);
      if (photoFailed) {
        setBusy(false);
        setReadyForShell(true);
        return;
      }
      finish(SHELL_HOME);
      return;
    }
    if (invitee && photoFailed) {
      setBusy(false);
      setReadyForShell(true);
      return;
    }
    if (!invitee) await onStep(APPROVER_BRAND_STEP);
    setBusy(false);
    next();
  }

  /** The positioned photo becomes the profile photo; the sheet closes. */
  async function applyPhoto(): Promise<void> {
    const cropper = cropperRef.current;
    if (cropper === null || !cropper.hasPhoto()) return;
    const file = await cropper.exportPng();
    if (file === null) {
      setError("We couldn't read that photo. Try another one.");
      setCropOpen(false);
      return;
    }
    setError(null);
    setPhotoFile(file);
    setUploadedAvatar('');
    setPhotoPreview(URL.createObjectURL(file));
    setCropOpen(false);
    void uploadPhoto(file);
  }

  /** brand_agency_request, then the wait is stored so a reload opens on it. */
  async function askTeam(): Promise<void> {
    setBusy(true);
    setError(null);
    const sent = await requestBrandTeam(supabase, {
      email: teamEmail,
      brandName,
      traceId: newTrace(),
    });
    if (!sent.ok) {
      setBusy(false);
      setError(brandRequestErrorMessage(sent.error.message));
      return;
    }
    await onStep(APPROVER_WAITING_STEP);
    setBusy(false);
    if (step === 'brand') next();
    else setResent(true);
  }

  // ---------- screens ----------

  let body: ReactNode;
  let primary: ReactNode = null;
  // The name screen's Continue is enabled: the hand may show on it.
  let continueEnabled = false;
  let preview: ReactNode = (
    <PersonPreview
      name={name}
      role={designation}
      username={shownUsername}
      photo={photoPreview}
      workspace={joinedWorkspaceName ?? ''}
    />
  );

  if (step === 'welcome') {
    const brand = welcome.brand || (joinedWorkspaceName ?? '');
    const subline =
      welcome.side === 'approver' ? WELCOME_COPY.approverSubline : WELCOME_COPY.creatorSubline;
    body = (
      <WelcomeBody
        heading={fillCopy(WELCOME_COPY.heading, entryCopyContext({ brand }))}
        platform={welcome.platform}
        subline={
          welcome.loaded
            ? // An empty inviter falls back to "The team" (WELCOME_COPY.fallbackInviter).
              fillCopy(subline, entryCopyContext({ inviter: welcome.inviter.trim() }))
            : ''
        }
        joiningAs={fillCopy(WELCOME_COPY.joiningAs, entryCopyContext({ email }))}
      />
    );
    primary = (
      <>
        <Primary disabled={busy} onClick={next}>
          {WELCOME_COPY.continue}
        </Primary>
        <TextAction disabled={busy} onClick={() => void notYou()}>
          {WELCOME_COPY.notYou}
        </TextAction>
      </>
    );
    preview = null;
  } else if (step === 'side') {
    body = (
      <>
        <Heading
          title={ONBOARDING_COPY.sideTitle}
          lead="Creators make the posts. Approvers evaluate them, share feedback and approve them."
        />
        <div
          role="radiogroup"
          aria-label={ONBOARDING_COPY.sideTitle}
          className="flex flex-col gap-3"
        >
          {SIDE_TILES.map((tile) => (
            <button
              key={tile.side}
              type="button"
              role="radio"
              aria-checked={side === tile.side}
              onClick={() => setSide(tile.side)}
              className={cn(
                'flex min-h-[56px] flex-col items-start justify-center gap-0.5 rounded-md border px-3.5 py-2.5 text-left',
                side === tile.side
                  ? 'border-accent bg-accent-soft ring-1 ring-accent'
                  : 'border-border bg-panel-2',
              )}
            >
              <span className="text-sm font-semibold text-fg">{tile.title}</span>
              <span className="text-xs text-fg-2">{tile.sub}</span>
            </button>
          ))}
        </div>
      </>
    );
    continueEnabled = side !== null && !changingSide;
    primary = (
      <Primary
        disabled={busy || side === null}
        onClick={changingSide ? () => void confirmSide() : next}
        anchor={INDUCTION_KEYS.onboardingSideContinue}
      >
        {busy ? 'Saving' : 'Continue'}
      </Primary>
    );
  } else if (step === 'name') {
    const hint =
      format === 'empty'
        ? 'People @mention you with this.'
        : format === 'invalid'
          ? 'Use up to 20 lowercase letters, numbers, dots or underscores.'
          : format === 'reserved'
            ? `@${shownUsername} is reserved. Try another.`
            : nameCheck === 'checking'
              ? 'Checking...'
              : nameCheck === 'taken'
                ? `@${shownUsername} is taken. Try another.`
                : nameCheck === 'error'
                  ? `We'll check @${shownUsername} when you continue.`
                  : `@${shownUsername} is yours.`;
    const hintTone =
      format === 'ok' && nameCheck === 'free'
        ? 'text-good'
        : format === 'invalid' || format === 'reserved' || nameCheck === 'taken'
          ? 'text-warn'
          : 'text-fg-3';
    body = (
      <>
        <Heading
          title="Your name"
          lead="This is how people see you in notifications, comments and chat."
        />
        <div className="flex items-center gap-4">
          {photoPreview !== null ? (
            <Avatar name={name || 'You'} src={photoPreview} size="xl" />
          ) : (
            <Avatar size="xl" />
          )}
          <div className="flex min-w-0 flex-col gap-1">
            <Button size="lg" onClick={() => photoInputRef.current?.click()}>
              {photoPreview !== null ? ONBOARDING_COPY.changePhoto : ONBOARDING_COPY.addPhoto}
            </Button>
            <p className="text-xs text-fg-3">{ONBOARDING_COPY.photoHint}</p>
          </div>
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            aria-label="Choose a photo"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file === undefined) return;
              pickedRef.current = file;
              setCropReady(false);
              setCropOpen(true);
            }}
          />
        </div>
        <Labeled label="Full name" htmlFor="ob-name">
          <Input
            id="ob-name"
            autoComplete="name"
            maxLength={80}
            placeholder="Your full name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Labeled>
        <div>
          <label htmlFor="ob-username" className="mb-1.5 block text-sm font-medium">
            Username
          </label>
          <div className="flex h-11 items-center rounded-md border border-border bg-panel-2 pl-3 focus-within:border-accent-line focus-within:ring-2 focus-within:ring-accent-soft">
            <span className="text-sm text-fg-3">@</span>
            <input
              id="ob-username"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              placeholder="your.name"
              value={shownUsername}
              onChange={(event) => {
                setUsernameEdited(true);
                setUsername(normalizeUsernameInput(event.target.value));
              }}
              className="h-full min-w-0 flex-1 bg-transparent pl-0.5 pr-3 text-sm text-fg outline-none placeholder:text-fg-3"
            />
          </div>
          <p className={cn('mt-1.5 text-xs', hintTone)} aria-live="polite">
            {hint}
          </p>
        </div>
      </>
    );
    continueEnabled =
      !busy &&
      name.trim().length > 0 &&
      format === 'ok' &&
      // A check that got no answer does not block: the save refuses a taken name.
      (nameCheck === 'free' || nameCheck === 'error');
    primary = (
      <Primary
        disabled={!continueEnabled}
        onClick={next}
        anchor={INDUCTION_KEYS.onboardingNameContinue}
      >
        Continue
      </Primary>
    );
  } else if (step === 'role') {
    const options = [...ROLE_TILES[shownSide], OTHER_ROLE].map((value) => ({
      value,
      label: value,
    }));
    body = (
      <>
        <Heading title="Your title" lead="It shows under your name, so people know who to ask." />
        <div>
          <p className="mb-1.5 block text-sm font-medium">{ONBOARDING_COPY.jobTitleLabel}</p>
          <Select
            label="Job title"
            value={role}
            options={options}
            placeholder="Pick your job title"
            onChange={setRole}
          />
        </div>
        {role === OTHER_ROLE ? (
          <Labeled label="Tell us your job title" htmlFor="ob-role-other">
            <Input
              id="ob-role-other"
              maxLength={80}
              placeholder="Type your job title"
              value={roleOther}
              onChange={(event) => setRoleOther(event.target.value)}
            />
          </Labeled>
        ) : null}
      </>
    );
    // The title is optional: Continue always works; the hand waits for a pick.
    continueEnabled = !busy && !readyForShell && designation.length > 0;
    primary = (
      <Primary
        disabled={busy}
        onClick={readyForShell ? () => finish(SHELL_HOME) : () => void saveProfile()}
        anchor={INDUCTION_KEYS.onboardingRoleContinue}
      >
        {busy ? 'Saving' : 'Continue'}
      </Primary>
    );
  } else if (step === 'brand') {
    const valid = isValidInviteEmail(teamEmail) && brandName.trim().length > 0;
    body = (
      <>
        <Heading
          title="Who makes your posts?"
          lead="The team, freelancer or studio behind your posts. We ask them to set up Sorted with you."
        />
        <Labeled label="Their email" htmlFor="ob-team-email">
          <Input
            id="ob-team-email"
            type="email"
            autoComplete="off"
            placeholder="name@theirteam.com"
            value={teamEmail}
            onChange={(event) => setTeamEmail(event.target.value)}
          />
        </Labeled>
        <Labeled label="Brand name" htmlFor="ob-brand" hint="The brand they make posts for.">
          <Input
            id="ob-brand"
            maxLength={80}
            placeholder="Ramy Group"
            value={brandName}
            onChange={(event) => setBrandName(event.target.value)}
          />
        </Labeled>
      </>
    );
    primary = (
      <>
        <Primary disabled={busy || !valid} onClick={() => void askTeam()}>
          {busy ? 'Sending' : 'Ask them to join'}
        </Primary>
        {!invitee ? (
          <TextAction disabled={busy} onClick={() => setChangingSide(true)}>
            {ONBOARDING_COPY.changeRole}
          </TextAction>
        ) : null}
      </>
    );
  } else {
    // waiting
    body = <WaitingBody email={teamEmail} resent={resent} />;
    primary = (
      <>
        <Primary
          disabled={busy || !isValidInviteEmail(teamEmail) || brandName.trim() === ''}
          onClick={() => void askTeam()}
        >
          {busy ? 'Sending' : 'Resend'}
        </Primary>
        <TextAction disabled={busy} onClick={() => void switchToCreator()}>
          {ONBOARDING_COPY.makePostsAfterAll}
        </TextAction>
        <TextAction disabled={busy} onClick={() => void startOverWithNewEmail()}>
          {ONBOARDING_COPY.differentEmail}
        </TextAction>
        <TextAction disabled={busy} onClick={() => dispatchSorted(SIGNOUT_EVENT)}>
          {ONBOARDING_COPY.signOut}
        </TextAction>
      </>
    );
    preview = null;
  }

  // Back is offered between the profile screens, and from a self sign-up's brand
  // screen to the side (a saved profile is not undone, only the side is changed).
  const previous = steps[index - 1];
  const canGoBack =
    !busy &&
    (changingSide ||
      (step === 'brand' && !invitee) ||
      (index > 0 && (step === 'name' || step === 'role') && previous !== 'welcome'));

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-bg md:grid md:grid-cols-2 md:overflow-hidden">
      <div
        className="flex min-h-full flex-col md:h-full md:overflow-y-auto"
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'env(safe-area-inset-bottom)',
          paddingLeft: 'env(safe-area-inset-left)',
          paddingRight: 'env(safe-area-inset-right)',
        }}
      >
        <div className="mx-auto flex w-full max-w-[440px] flex-1 flex-col px-6">
          <header className="flex min-h-[56px] items-center justify-between pt-2">
            {canGoBack ? (
              <button
                type="button"
                onClick={back}
                aria-label="Back"
                className="-ml-3 grid h-11 w-11 place-items-center rounded-md text-fg hover:bg-panel-2"
              >
                <BackGlyph />
              </button>
            ) : (
              <span className="block text-fg [&_svg]:h-6 [&_svg]:w-auto [&_.mark-dot]:fill-accent">
                <Wordmark />
              </span>
            )}
          </header>

          {/* Sorted's card: one white box on the page, the step under the title,
              grey option boxes and the blue Continue inside it. */}
          <main className="flex flex-1 flex-col py-4">
            <StepLabel.Provider
              value={progressAt >= 0 ? setupCounter(progressAt + 1, progress.length) : null}
            >
              <div className="flex flex-col gap-5 rounded-2xl border border-border bg-panel p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_40px_-12px_rgba(0,0,0,0.12)]">
                {body}
                {photoNotice !== null && (step === 'brand' || readyForShell) ? (
                  <p role="status" className="text-sm text-fg-2 [text-wrap:pretty]">
                    {photoNotice}
                  </p>
                ) : null}
                {error !== null ? (
                  <p role="alert" className="text-sm text-bad [text-wrap:pretty]">
                    {error}
                  </p>
                ) : null}
                {primary}
              </div>
            </StepLabel.Provider>
          </main>
        </div>
      </div>

      <aside className="hidden h-full flex-col items-center justify-center gap-3.5 border-l border-border bg-panel-2 p-8 md:flex">
        {preview ?? <WaitingPreview />}
      </aside>

      <Sheet
        open={cropOpen}
        onClose={() => setCropOpen(false)}
        title="Position your photo"
        footer={
          <>
            <Button size="lg" onClick={() => setCropOpen(false)}>
              Cancel
            </Button>
            <span className="ml-auto">
              <Button
                variant="primary"
                size="lg"
                disabled={!cropReady}
                onClick={() => void applyPhoto()}
              >
                Use this photo
              </Button>
            </span>
          </>
        }
      >
        <AvatarCropper
          ref={attachCropper}
          hidePicker
          onPhotoChange={(info) => setCropReady(info.hasPhoto)}
        />
      </Sheet>
      <EntryHand
        target={entryHandTarget({
          step,
          signUp: !invitee && approverStage === 'none',
          creatorRoute: !invitee && shownSide === 'creator' && approverStage === 'none',
          continueEnabled,
        })}
      />
    </div>
  );
}

// ---------- pieces ----------

/** "Setup 1 of 3" for the screen in view, shown under its title; null off the counted steps. */
const StepLabel = createContext<string | null>(null);

function Heading({ title, lead }: { title: string; lead: string }): ReactElement {
  const stepLabel = useContext(StepLabel);
  return (
    <div>
      <h1 className="text-lg font-semibold tracking-tight text-fg [text-wrap:balance]">{title}</h1>
      {stepLabel !== null ? (
        <p data-onboarding-step="" className="mt-1 text-sm text-fg-3">
          {stepLabel}
        </p>
      ) : null}
      <p className="mt-2 text-sm text-fg-2 [text-wrap:balance]">{lead}</p>
    </div>
  );
}

function Labeled({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint !== undefined ? <p className="mt-1.5 text-xs text-fg-3">{hint}</p> : null}
    </div>
  );
}

function Primary({
  disabled,
  onClick,
  anchor,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  /** The guide's data-induction key, where the hand can sit on it. */
  anchor?: InductionKey;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      data-induction={anchor}
      disabled={disabled}
      onClick={onClick}
      className="h-11 w-full rounded-md bg-accent text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** A secondary way on, as a 44px text button under the primary. */
function TextAction({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="min-h-[44px] w-full text-sm font-medium text-accent hover:underline disabled:opacity-35"
    >
      {children}
    </button>
  );
}

/** The platform as the app shows it elsewhere: the letter mark and its label. */
function PlatformTag({ platform }: { platform: string }): ReactElement {
  const label = isPostPlatform(platform) ? PLATFORM_LABELS[platform] : platform;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-fg-2">
      <PlatformMark platform={platform} />
      <span>{label}</span>
    </span>
  );
}

function WelcomeBody({
  heading,
  platform,
  subline,
  joiningAs,
}: {
  heading: string;
  platform: string;
  subline: string;
  joiningAs: string;
}): ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold tracking-tight text-fg [text-wrap:balance]">
        {heading}
      </h1>
      {platform !== '' ? <PlatformTag platform={platform} /> : null}
      <p className="min-h-[20px] text-sm text-fg-2 [text-wrap:balance]" aria-live="polite">
        {subline}
      </p>
      <p className="rounded-lg border border-border bg-panel px-4 py-3 text-sm text-fg">
        {joiningAs}
      </p>
    </div>
  );
}

const WAITING_LINES: readonly string[] = [
  'We email them to set up your brand on Sorted.',
  'They invite you as the approver. You get an email too.',
  'Their first post lands here for you to read and approve.',
];

/**
 * An approver who signed up alone waits here: there is no workspace to tour
 * yet. Their tour starts on the real post the day their team invites them.
 */
function WaitingBody({ email, resent }: { email: string; resent: boolean }): ReactElement {
  return (
    <>
      <Heading
        title="Your team is on its way"
        lead="The real work starts the day they raise your first post: it lands here, you read it, you approve it."
      />
      <ol className="flex flex-col gap-3">
        {WAITING_LINES.map((line, i) => (
          <li
            key={line}
            className="flex items-center gap-3 rounded-lg border border-border bg-panel p-3.5"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-soft font-mono text-sm font-semibold text-accent">
              {i + 1}
            </span>
            <span className="text-sm text-fg [text-wrap:pretty]">{line}</span>
          </li>
        ))}
      </ol>
      {email !== '' ? (
        <p className="text-sm text-fg-2" aria-live="polite">
          {resent ? `Sent again to ${email}.` : `We asked ${email}.`}
        </p>
      ) : null}
    </>
  );
}

function PreviewCard({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="w-full max-w-[340px] rounded-2xl border border-border bg-panel p-3.5 shadow-[0_12px_30px_-16px_rgba(17,17,20,0.25)]">
      <p className="mb-2 text-xs text-fg-3">{label}</p>
      {children}
    </div>
  );
}

function PreviewLabel({ children }: { children: ReactNode }): ReactElement {
  return <p className="text-xs font-semibold uppercase tracking-[0.06em] text-fg-3">{children}</p>;
}

function PersonPreview({
  name,
  role,
  username,
  photo,
  workspace,
}: {
  name: string;
  role: string;
  username: string;
  photo: string | null;
  workspace: string;
}): ReactElement {
  const shown = name.trim() || 'Your name';
  const where = workspace || 'your workspace';
  const avatar =
    photo !== null ? (
      <Avatar name={shown} src={photo} size="md" />
    ) : (
      <Avatar name={shown} size="md" />
    );
  return (
    <>
      <PreviewLabel>How you will appear</PreviewLabel>
      <PreviewCard label="Comment on a post">
        <div className="flex gap-2.5">
          {avatar}
          <div className="min-w-0">
            <p className="text-sm font-semibold text-fg">
              {shown}
              {role !== '' ? <span className="font-normal text-fg-3"> · {role}</span> : null}
            </p>
            <p className="text-sm text-fg [text-wrap:balance]">Warm the skin tone here, please.</p>
          </div>
        </div>
      </PreviewCard>
      <PreviewCard label={`Chat in ${where}`}>
        <p className="text-sm text-fg [text-wrap:balance]">
          Thanks <span className="font-semibold text-accent">@{username || 'you'}</span>, updating
          it now.
        </p>
      </PreviewCard>
      <PreviewCard label="Notification">
        <p className="text-sm text-fg [text-wrap:balance]">
          <span className="font-semibold">{shown}</span> approved a post in {where}.
        </p>
      </PreviewCard>
    </>
  );
}

function WaitingPreview(): ReactElement {
  return (
    <>
      <PreviewLabel>What comes next</PreviewLabel>
      <PreviewCard label="Review">
        <p className="text-sm text-fg-2">
          Your first post waits here with its caption and creative, ready for your approval.
        </p>
      </PreviewCard>
    </>
  );
}

function BackGlyph(): ReactElement {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}
