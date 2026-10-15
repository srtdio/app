// Full-screen pre-app screens, one question per screen, before the shell. The
// shell (AppLayout) shows them to anyone whose profile is unfinished, and to an
// approver who signed up alone and is waiting for their team. Everything after
// them happens on the real screens with the guide on top (src/components/induction).
//
// Which screens a person walks comes from stepsFor (src/lib/onboarding.ts):
//   self sign-up, Creator:  side, name, role, then the shell (make the workspace)
//   self sign-up, Approver: side, name, role, brand, waiting
//   invitee:                password, name, role, then the shell
//
// Nothing here refetches the profile or the workspace list until the very end
// (finish), because either refetch flips the shell gate and would unmount the
// flow mid-way. Colors are tokens only, so light and dark both hold.

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { userOnboardingSave, usernameAvailable } from '@srtdio/rpc';
import type { Json } from '@srtdio/schemas';
import { AvatarCropper, type AvatarCropperHandle } from '@/components/onboarding/AvatarCropper';
import { isValidInviteEmail } from '@/components/pages/settings/MembersInviteForm';
import { Wordmark } from '@/components/home/Wordmark';
import { readLatestBrandRequest, requestBrandTeam } from '@/components/induction/induction-data';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { uploadAvatarFile } from '@/lib/avatar-upload';
import { cn } from '@/lib/cn';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import {
  APPROVER_BRAND_STEP,
  APPROVER_WAITING_STEP,
  brandRequestErrorMessage,
  WORKSPACE_STEP,
  type ApproverStage,
} from '@/lib/induction';
import { logger } from '@/lib/logger';
import {
  AGE_RANGES,
  OTHER_ROLE,
  ROLE_TILES,
  SIDE_TILES,
  designationFor,
  normalizeUsernameInput,
  progressSteps,
  stepsFor,
  suggestUsername,
  usernameFormat,
  type OnboardingStep,
  type Side,
} from '@/lib/onboarding';
import { useSession } from '@/lib/session-context';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import type { CurrentProfile } from '@/lib/use-current-profile';
import { MIN_PASSWORD_LENGTH } from '@/components/auth/SignUpPage';

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
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const email = session?.user.email ?? '';
  const invitee = joinedWorkspaceId !== null;

  // The side: picked on the first screen, or the invite's role for an invitee.
  const [side, setSide] = useState<Side | null>(approverStage !== 'none' ? 'approver' : null);
  const [inviteSide, setInviteSide] = useState<Side>('creator');
  const shownSide: Side = invitee ? inviteSide : (side ?? 'creator');
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
  const [password, setPassword] = useState('');
  // A new account's display_name is the email's local part (signup trigger), not
  // a real name: start blank then, so nobody becomes "connect" by default.
  const [name, setName] = useState(() => {
    const current = profile?.display_name ?? '';
    return current === email.split('@')[0] ? '' : current;
  });
  const [username, setUsername] = useState('');
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [nameCheck, setNameCheck] = useState<NameCheck>('idle');
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const cropperRef = useRef<AvatarCropperHandle>(null);
  // The cropped photo, taken when the person leaves the name screen (the
  // cropper unmounts after that), uploaded with the profile save.
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [role, setRole] = useState('');
  const [roleOther, setRoleOther] = useState('');
  const [age, setAge] = useState('');
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

  // Invitee: their side comes from the invite's role.
  useEffect(() => {
    if (joinedWorkspaceId === null || userId === null) return;
    let cancelled = false;
    void supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', joinedWorkspaceId)
      .eq('user_id', userId)
      .eq('active', true)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setInviteSide(data?.role === 'client' ? 'approver' : 'creator');
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

  async function savePassword(): Promise<void> {
    setBusy(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    next();
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
      age_range: age,
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

  /** Keep the cropped photo before the name screen (and its cropper) goes away. */
  async function leaveNameStep(): Promise<void> {
    const cropper = cropperRef.current;
    if (cropper !== null && cropper.hasPhoto()) {
      setBusy(true);
      const file = await cropper.exportPng();
      setBusy(false);
      if (file === null) {
        setError("We couldn't read that photo. Try another one.");
        return;
      }
      setPhotoFile(file);
    }
    next();
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

  /** The approver makes the posts after all: the Creator path, workspace first. */
  async function switchToCreator(): Promise<void> {
    setBusy(true);
    const stored = await onStep(WORKSPACE_STEP);
    if (!stored) {
      setBusy(false);
      setError("We couldn't switch that. Try again.");
      return;
    }
    finish(SHELL_HOME);
  }

  // ---------- screens ----------

  let body: ReactNode;
  let primary: ReactNode = null;
  let preview: ReactNode = (
    <PersonPreview
      name={name}
      role={designation}
      username={shownUsername}
      photo={photoPreview}
      workspace={joinedWorkspaceName ?? ''}
    />
  );

  if (step === 'password') {
    body = (
      <>
        <Heading
          title={`Join ${joinedWorkspaceName ?? 'your workspace'}`}
          lead="Set a password and you're in. Next time, sign in with it."
        />
        <Labeled label="Email" htmlFor="ob-email">
          <Input id="ob-email" value={email} readOnly className="text-fg-2" />
        </Labeled>
        <Labeled label="Password" htmlFor="ob-password" hint="At least 8 characters.">
          <Input
            id="ob-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Labeled>
      </>
    );
    primary = (
      <Primary
        disabled={busy || password.length < MIN_PASSWORD_LENGTH}
        onClick={() => void savePassword()}
      >
        Continue
      </Primary>
    );
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
        <div className="rounded-lg border border-border bg-panel p-4">
          <AvatarCropper
            ref={cropperRef}
            onPhotoChange={(info) => {
              // A fresh cropper (after Back) starts empty: keep the photo already taken.
              if (info.hasPhoto) setPhotoPreview(info.previewUrl);
            }}
          />
          <p className="mt-2 text-[11px] text-fg-3">
            {photoPreview !== null
              ? 'Looks good. People see it next to your comments.'
              : 'Add a photo to continue. People see it next to your comments.'}
          </p>
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
    primary = (
      <Primary
        disabled={
          busy ||
          photoPreview === null ||
          name.trim().length === 0 ||
          format !== 'ok' ||
          nameCheck !== 'free'
        }
        onClick={() => void leaveNameStep()}
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
        <ChipGroup
          label="Your age range"
          hint="Never shown to anyone."
          options={AGE_RANGES.map((value) => ({ value, label: value }))}
          value={age}
          onChange={setAge}
        />
      </>
    );
    primary = (
      <Primary
        disabled={busy || designation.length === 0 || age === ''}
        onClick={() => void saveProfile()}
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
    body = (
      <WaitingBody
        email={teamEmail}
        resent={resent}
        busy={busy}
        onSwitch={() => void switchToCreator()}
      />
    );
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
    index > 0 && (step === 'name' || step === 'role') && previous !== 'password' && !busy;

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
      className="h-[50px] w-full rounded-lg bg-fg text-[15px] font-semibold text-bg hover:opacity-90 disabled:opacity-35"
    >
      {children}
    </button>
  );
}

function ChipGroup({
  label,
  hint,
  options,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">{label}</p>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            onClick={() => onChange(value === option.value ? '' : option.value)}
            className={cn(
              'min-h-[44px] rounded-full border px-4 text-sm font-medium',
              value === option.value ? 'border-fg bg-fg text-bg' : 'border-border bg-panel text-fg',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      {hint !== undefined ? <p className="text-[11px] text-fg-3">{hint}</p> : null}
    </div>
  );
}

const WAITING_LINES: readonly string[] = [
  'We email them to set up your brand on Sorted.',
  'They invite you as the approver. You get an email too.',
  'Their first post lands here for you to read and approve.',
];

function WaitingBody({
  email,
  resent,
  busy,
  onSwitch,
}: {
  email: string;
  resent: boolean;
  busy: boolean;
  onSwitch: () => void;
}): ReactElement {
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
      <Button variant="ghost" size="lg" disabled={busy} onClick={onSwitch} className="self-start">
        I make the posts after all
      </Button>
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
