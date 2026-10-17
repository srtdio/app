// Full-screen pre-app screens, one question per screen, before the shell. The
// shell (AppLayout) shows them to anyone whose profile is unfinished, and to an
// approver who signed up alone and is waiting for their team. Everything after
// them happens on the real screens with the guide on top (src/components/induction).
//
// Which screens a person walks comes from stepsFor (src/lib/onboarding.ts):
//   self sign-up, Creator:  side, name, role, then the shell (make the workspace)
//   self sign-up, Approver: side, name, role, brand, waiting
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

import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { PLATFORM_LABELS, isPostPlatform } from '@srtdio/posts';
import { userOnboardingSave, usernameAvailable } from '@srtdio/rpc';
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
import { fetchWithTrace } from '@/lib/fetch';
import { WELCOME_COPY, fillCopy } from '@/lib/induction-copy';
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

  // The side: picked on the first screen, or the invite's role for an invitee.
  const [side, setSide] = useState<Side | null>(approverStage !== 'none' ? 'approver' : null);
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
  const [index, setIndex] = useState(0);
  const step: OnboardingStep = steps[index] ?? 'waiting';

  // Profile answers
  // A new account's display_name is the email's local part (signup trigger), not
  // a real name: start blank then, so nobody becomes "connect" by default.
  const [name, setName] = useState(() => {
    const current = profile?.display_name ?? '';
    return current === email.split('@')[0] ? '' : current;
  });
  const [username, setUsername] = useState('');
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [nameCheck, setNameCheck] = useState<NameCheck>('idle');
  // The photo: picked from the device, positioned in a sheet (so the name and
  // username stay on screen), kept as the cropped file and uploaded with the
  // profile save.
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
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
  const [role, setRole] = useState('');
  const [roleOther, setRoleOther] = useState('');
  const [emailOptIn] = useState(profile?.email_opt_in ?? true);

  // The approver who signed up alone: who makes their posts.
  const [teamEmail, setTeamEmail] = useState('');
  const [brandName, setBrandName] = useState('');
  const [resent, setResent] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      void usernameAvailable(supabase, { p_username: shownUsername, p_trace_id: newTrace() }).then(
        (res) => {
          if (cancelled) return;
          if (!res.ok) {
            logger.error('username check failed', { error: res.error.message });
            setNameCheck('error');
            return;
          }
          setNameCheck(res.data ? 'free' : 'taken');
        },
      );
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

  const progress = progressSteps(steps);
  const progressAt = progress.indexOf(step);

  function next(): void {
    setError(null);
    if (index < steps.length - 1) setIndex(index + 1);
    else finish(SHELL_HOME);
  }

  function back(): void {
    setError(null);
    if (index > 0) setIndex(index - 1);
  }

  function finish(to: string): void {
    setBusy(true);
    onFinish(to);
  }

  /** "Not you?": sign out on this device, then sign in again on the way back to the invite. */
  async function notYou(): Promise<void> {
    setBusy(true);
    await performSignout(supabase);
    navigate(notYouPath(welcome.inviteId), { replace: true });
  }

  /** Upload the photo, then save the whole profile in one call. */
  async function saveProfile(): Promise<void> {
    setBusy(true);
    setError(null);
    let avatarUrl: string | null = null;
    if (photoFile !== null && env.VITE_AVATAR_UPLOAD_URL !== undefined) {
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      const up = await uploadAvatarFile(photoFile, {
        endpoint: env.VITE_AVATAR_UPLOAD_URL,
        token,
        fetcher: (input, init) => fetchWithTrace(input, init, newTrace()),
      });
      if (!up.ok) {
        setBusy(false);
        setError("Your photo didn't upload. Check your connection and try again.");
        return;
      }
      avatarUrl = up.data.avatarUrl;
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
    // A Creator makes the workspace in the shell; an approver goes on to name their team.
    if (!invitee && shownSide === 'creator') {
      await onStep(WORKSPACE_STEP);
      finish(SHELL_HOME);
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
    setPhotoPreview(URL.createObjectURL(file));
    setCropOpen(false);
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
        <button
          type="button"
          disabled={busy}
          onClick={() => void notYou()}
          className="min-h-[44px] w-full text-sm font-medium text-accent hover:underline disabled:opacity-35"
        >
          {WELCOME_COPY.notYou}
        </button>
      </>
    );
    preview = null;
  } else if (step === 'side') {
    body = (
      <>
        <Heading
          title="Who are you here as?"
          lead="Creators make the posts. Approvers read them and approve them."
        />
        <div role="radiogroup" aria-label="Who are you here as?" className="flex flex-col gap-3">
          {SIDE_TILES.map((tile) => (
            <button
              key={tile.side}
              type="button"
              role="radio"
              aria-checked={side === tile.side}
              onClick={() => setSide(tile.side)}
              className={cn(
                'flex min-h-[72px] flex-col items-start justify-center rounded-xl border bg-panel px-4 py-3 text-left',
                side === tile.side ? 'border-fg ring-1 ring-fg' : 'border-border',
              )}
            >
              <span className="text-[17px] font-semibold text-fg">{tile.title}</span>
              <span className="text-sm text-fg-2">{tile.sub}</span>
            </button>
          ))}
        </div>
      </>
    );
    primary = (
      <Primary disabled={side === null} onClick={next}>
        Continue
      </Primary>
    );
  } else if (step === 'name') {
    const hint =
      format === 'empty'
        ? 'People @mention you with this.'
        : format === 'invalid'
          ? 'Use 3 to 20 lowercase letters, numbers, dots or underscores.'
          : format === 'reserved'
            ? `@${shownUsername} is reserved. Try another.`
            : nameCheck === 'checking'
              ? 'Checking...'
              : nameCheck === 'taken'
                ? `@${shownUsername} is taken. Try another.`
                : nameCheck === 'error'
                  ? "Couldn't check right now. Try again."
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
          title="What should we call you?"
          lead="This is how people see you in notifications, comments and chat."
        />
        <div className="flex items-center gap-4">
          {photoPreview !== null ? (
            <Avatar name={name || 'You'} src={photoPreview} size="xl" />
          ) : (
            <Avatar name={name || 'You'} size="xl" />
          )}
          <div className="flex min-w-0 flex-col gap-1">
            <Button size="lg" onClick={() => photoInputRef.current?.click()}>
              {photoPreview !== null ? 'Change photo' : 'Add a photo'}
            </Button>
            <p className="text-[11px] text-fg-3">
              {photoPreview !== null
                ? 'People see it next to your comments.'
                : 'Needed to continue. People see it next to your comments.'}
            </p>
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
          <p className={cn('mt-1.5 text-[11px]', hintTone)} aria-live="polite">
            {hint}
          </p>
        </div>
      </>
    );
    continueEnabled =
      !busy &&
      photoPreview !== null &&
      name.trim().length > 0 &&
      format === 'ok' &&
      nameCheck === 'free';
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
        <Heading
          title="What do you do?"
          lead="It shows under your name, so people know who to ask."
        />
        <div>
          <p className="mb-1.5 block text-sm font-medium">Your role</p>
          <Select
            label="Your role"
            value={role}
            options={options}
            placeholder="Pick your role"
            onChange={setRole}
          />
        </div>
        {role === OTHER_ROLE ? (
          <Labeled label="Tell us your role" htmlFor="ob-role-other">
            <Input
              id="ob-role-other"
              maxLength={80}
              placeholder="Type your role"
              value={roleOther}
              onChange={(event) => setRoleOther(event.target.value)}
            />
          </Labeled>
        ) : null}
      </>
    );
    primary = (
      <Primary
        disabled={busy || designation.length === 0}
        onClick={() => void saveProfile()}
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
      <Primary disabled={busy || !valid} onClick={() => void askTeam()}>
        {busy ? 'Sending' : 'Ask them to join'}
      </Primary>
    );
  } else {
    // waiting
    body = <WaitingBody email={teamEmail} resent={resent} />;
    primary = (
      <Primary
        disabled={busy || !isValidInviteEmail(teamEmail) || brandName.trim() === ''}
        onClick={() => void askTeam()}
      >
        {busy ? 'Sending' : 'Resend'}
      </Primary>
    );
    preview = null;
  }

  // Back is offered between the profile screens only; a saved profile is not undone.
  const previous = steps[index - 1];
  const canGoBack =
    index > 0 && (step === 'name' || step === 'role') && previous !== 'welcome' && !busy;

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

          {progressAt >= 0 ? (
            <div className="pt-1">
              <div
                role="progressbar"
                aria-valuemin={1}
                aria-valuemax={progress.length}
                aria-valuenow={progressAt + 1}
                aria-label={`Step ${progressAt + 1} of ${progress.length}`}
                className="flex gap-1.5"
              >
                {progress.map((s, i) => (
                  <span
                    key={s}
                    className={cn(
                      'h-1 flex-1 rounded-full',
                      i <= progressAt ? 'bg-fg' : 'bg-border',
                    )}
                  />
                ))}
              </div>
              <p className="mt-2 font-mono text-[11px] text-fg-3">
                Step {progressAt + 1} of {progress.length}
              </p>
            </div>
          ) : null}

          <main className="flex flex-1 flex-col gap-5 py-5">{body}</main>

          <footer className="sticky bottom-0 -mx-6 flex flex-col gap-2 bg-bg px-6 pb-6 pt-3">
            {error !== null ? (
              <p role="alert" className="text-sm text-bad [text-wrap:pretty]">
                {error}
              </p>
            ) : null}
            {primary}
          </footer>
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
          creatorRoute: !invitee && shownSide === 'creator' && approverStage === 'none',
          continueEnabled,
        })}
      />
    </div>
  );
}

// ---------- pieces ----------

function Heading({ title, lead }: { title: string; lead: string }): ReactElement {
  return (
    <div>
      <h1 className="text-[26px] font-bold leading-[1.15] tracking-[-0.02em] text-fg [text-wrap:balance]">
        {title}
      </h1>
      <p className="mt-2 text-[15px] leading-[1.45] text-fg-2 [text-wrap:balance]">{lead}</p>
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
      {hint !== undefined ? <p className="mt-1.5 text-[11px] text-fg-3">{hint}</p> : null}
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
      className="h-[50px] w-full rounded-lg bg-accent text-[15px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-35"
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
      <h1 className="text-[26px] font-bold leading-[1.15] tracking-[-0.02em] text-fg [text-wrap:balance]">
        {heading}
      </h1>
      {platform !== '' ? <PlatformTag platform={platform} /> : null}
      <p
        className="min-h-[22px] text-[15px] leading-[1.45] text-fg-2 [text-wrap:balance]"
        aria-live="polite"
      >
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
            <span className="text-[14px] text-fg [text-wrap:pretty]">{line}</span>
          </li>
        ))}
      </ol>
      {email !== '' ? (
        <p className="text-[13px] text-fg-2" aria-live="polite">
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
