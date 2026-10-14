// Full-screen onboarding, one question per screen (Airtable), a live preview of
// how you appear (Notion), a setup question that makes something real (Slack:
// the first post), about a minute end to end (Linear). The shell (AppLayout)
// shows it to anyone whose profile is unfinished or who has no workspace.
//
// Which screens a person walks comes from stepsFor (src/lib/onboarding.ts):
//   self sign-up: name, role, quick, workspace, firstpost, invite
//   invitee:      password, name, role, ready
//   profile done, no workspace: workspace, firstpost, invite
//
// Nothing here refetches the profile or the workspace list until the very end
// (finish), because either refetch flips the shell gate and would unmount the
// flow mid-way. Colors are tokens only, so light and dark both hold; new people
// are always in light (src/lib/theme.ts).

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import {
  memberJoinGroupSet,
  stageTransition,
  userOnboardingSave,
  usernameAvailable,
  workspaceCreate,
} from '@srtdio/rpc';
import type { Json } from '@srtdio/schemas';
import { AvatarCropper, type AvatarCropperHandle } from '@/components/onboarding/AvatarCropper';
import { CreatePostSheet } from '@/components/pages/CreatePostSheet';
import { isValidInviteEmail } from '@/components/pages/settings/MembersInviteForm';
import { Wordmark } from '@/components/home/Wordmark';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { uploadAvatarFile } from '@/lib/avatar-upload';
import { cn } from '@/lib/cn';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { logger } from '@/lib/logger';
import {
  AGE_RANGES,
  HEARD_FROM,
  defaultGroupName,
  firstName,
  initialsOf,
  inviteRoleFor,
  peopleLine,
  normalizeUsernameInput,
  progressSteps,
  roleGroupsFor,
  stepsFor,
  suggestUsername,
  usernameFormat,
  type OnboardingStep,
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
  /**
   * Done: the shell refetches profile and workspaces, then opens `to`. The flow
   * stays mounted (busy) until both have landed, so nothing flickers.
   */
  onFinish: (to: string) => void;
  /** Set when the finish refetch failed: the flow re-enables and shows it. */
  finishError: string | null;
}

type Side = 'client' | 'team';
interface InviteRow {
  email: string;
  side: Side;
}
type NameCheck = 'idle' | 'checking' | 'free' | 'taken' | 'error';

const OTHER_ROLE = 'Something else';

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

export function OnboardingFlow({
  profile,
  workspaceId: joinedWorkspaceId,
  workspaceName: joinedWorkspaceName,
  onFinish,
  finishError,
}: OnboardingFlowProps): ReactElement {
  const newTrace = useNewTrace();
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const email = session?.user.email ?? '';

  // Fixed at mount: the flow does not reshuffle while the person is in it.
  const [steps] = useState<OnboardingStep[]>(() =>
    stepsFor({
      profileIncomplete: profile === null || profile.profile_completed_at === null,
      hasWorkspace: joinedWorkspaceId !== null,
    }),
  );
  const [index, setIndex] = useState(0);
  const step = steps[index] ?? 'workspace';

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
  const [photoOpen, setPhotoOpen] = useState(false);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const cropperRef = useRef<AvatarCropperHandle>(null);
  // The cropped photo, taken when the person leaves the name screen (the
  // cropper unmounts after that), uploaded with the profile save.
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [role, setRole] = useState('');
  const [roleOther, setRoleOther] = useState('');
  const [age, setAge] = useState('');
  const [heard, setHeard] = useState('');
  const [emailOptIn] = useState(profile?.email_opt_in ?? true);

  // Workspace answers
  const [wsName, setWsName] = useState('');
  const [createdWorkspaceId, setCreatedWorkspaceId] = useState<string | null>(null);
  const [postOpen, setPostOpen] = useState(false);
  const [postSent, setPostSent] = useState(false);
  // A first post that saved as a draft but did not reach review: retry the move, never re-create.
  const [draftPostId, setDraftPostId] = useState<string | null>(null);
  const [invites, setInvites] = useState<InviteRow[]>([
    { email: '', side: 'client' },
    { email: '', side: 'team' },
  ]);
  const [joinGroup, setJoinGroup] = useState(true);

  // Invitee context (ready screen, role tiles)
  const [isClient, setIsClient] = useState(false);
  const [ready, setReady] = useState<ReadyFacts | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shownUsername = usernameEdited ? username : suggestUsername(name);
  const format = usernameFormat(shownUsername);
  const designation = role === OTHER_ROLE ? roleOther.trim() : role;
  const activeWorkspaceId = joinedWorkspaceId ?? createdWorkspaceId;
  const activeWorkspaceName = joinedWorkspaceName ?? wsName.trim();

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

  // Invitee: read their side once, for client-first role tiles.
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
        if (!cancelled) setIsClient(data?.role === 'client');
      });
    return () => {
      cancelled = true;
    };
  }, [joinedWorkspaceId, userId]);

  // Invitee: what is waiting, loaded when the ready screen comes up.
  useEffect(() => {
    if (step !== 'ready' || joinedWorkspaceId === null || userId === null) return;
    let cancelled = false;
    void loadReadyFacts(joinedWorkspaceId, userId).then((facts) => {
      if (!cancelled) setReady(facts);
    });
    return () => {
      cancelled = true;
    };
  }, [step, joinedWorkspaceId, userId]);

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
    else finish('/chat');
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

  /** Upload the photo when one was chosen, then save the whole profile in one call. */
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
        setError("Your photo didn't upload. Try again, or add one later in Settings.");
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
      heard_from: heard,
    };
    if (avatarUrl !== null) payload.avatar_url = avatarUrl;
    const saved = await userOnboardingSave(supabase, {
      p_payload: payload as Json,
      p_trace_id: newTrace(),
    });
    setBusy(false);
    if (!saved.ok) {
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
    next();
  }

  /** Keep the cropped photo before the name screen (and its cropper) goes away. */
  async function leaveNameStep(): Promise<void> {
    const cropper = cropperRef.current;
    if (cropper !== null && cropper.hasPhoto()) {
      setBusy(true);
      const file = await cropper.exportPng();
      setBusy(false);
      if (file !== null) setPhotoFile(file);
    }
    next();
  }

  async function createWorkspace(): Promise<void> {
    if (createdWorkspaceId !== null) {
      next();
      return;
    }
    setBusy(true);
    setError(null);
    const tz =
      typeof session?.user.user_metadata.timezone === 'string' &&
      session.user.user_metadata.timezone !== ''
        ? session.user.user_metadata.timezone
        : detectTimezone();
    const created = await workspaceCreate(supabase, {
      p_payload: { name: wsName.trim(), timezone: tz },
      p_trace_id: newTrace(),
    });
    setBusy(false);
    if (!created.ok) {
      logger.error('onboarding workspace create failed', { error: created.error.message });
      setError("We couldn't create the workspace. Try again.");
      return;
    }
    setCreatedWorkspaceId(created.data);
    next();
  }

  async function onPostCreated(postId: string): Promise<void> {
    setPostOpen(false);
    setDraftPostId(postId);
    setBusy(true);
    setError(null);
    const moved = await stageTransition(supabase, {
      p_post_id: postId,
      p_to_stage: 'review',
      p_trace_id: newTrace(),
    });
    if (!moved.ok) {
      // The post exists as a draft; the checklist still offers sending it.
      setBusy(false);
      logger.error('onboarding first post to review failed', { error: moved.error.message });
      setError("Your post is saved, but it didn't reach review. Try sending it again.");
      return;
    }
    setBusy(false);
    setDraftPostId(null);
    setPostSent(true);
  }

  async function sendInvites(): Promise<void> {
    if (activeWorkspaceId === null) return;
    const rows = invites.filter((row) => isValidInviteEmail(row.email));
    setBusy(true);
    setError(null);
    const failed: string[] = [];
    const stillInGroup: string[] = [];
    for (const row of rows) {
      const traceId = newTrace();
      const { data, error: err } = await supabase.functions.invoke<{ invite_id?: string }>(
        'invite-send',
        {
          body: {
            workspace_id: activeWorkspaceId,
            email: row.email.trim(),
            role: inviteRoleFor(row.side),
          },
          headers: { 'x-trace-id': traceId },
        },
      );
      if (err || typeof data?.invite_id !== 'string') {
        failed.push(row.email.trim());
        continue;
      }
      if (!joinGroup) {
        const off = await memberJoinGroupSet(supabase, {
          p_member_id: data.invite_id,
          p_join: false,
          p_trace_id: newTrace(),
        });
        if (!off.ok) {
          logger.error('join group opt-out failed', { error: off.error.message });
          stillInGroup.push(row.email.trim());
        }
      }
    }
    setBusy(false);
    if (failed.length > 0 || stillInGroup.length > 0) {
      const parts: string[] = [];
      if (failed.length > 0) {
        parts.push(
          `We couldn't invite ${failed.join(', ')}. Check the address, or invite them later from Settings.`,
        );
      }
      if (stillInGroup.length > 0) {
        parts.push(
          `${stillInGroup.join(', ')} will join the chat group when they accept. Remove them from Group info if needed.`,
        );
      }
      setError(parts.join(' '));
      // Only the addresses that failed stay on screen to fix; sent ones are done.
      setInvites((prev) => prev.filter((row) => failed.includes(row.email.trim())));
      return;
    }
    finish('/chat');
  }

  const validInvites = invites.filter((row) => isValidInviteEmail(row.email)).length;

  // ---------- screens ----------

  let body: ReactNode;
  let primary: ReactNode = null;
  let skip: (() => void) | null = null;
  let preview: ReactNode = (
    <PersonPreview
      name={name}
      role={designation}
      username={shownUsername}
      photo={photoPreview}
      workspace={activeWorkspaceName}
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
    preview = <WaitingPreview workspace={joinedWorkspaceName ?? ''} />;
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
          <Button size="lg" onClick={() => setPhotoOpen(true)}>
            {photoPreview !== null ? 'Change photo' : 'Add a photo'}
          </Button>
        </div>
        {photoOpen ? (
          <div className="rounded-lg border border-border bg-panel p-4">
            <AvatarCropper
              ref={cropperRef}
              onPhotoChange={(info) => {
                // A fresh cropper (after Back) starts empty: keep the photo already taken.
                if (info.hasPhoto) setPhotoPreview(info.previewUrl);
              }}
            />
            <p className="mt-2 text-[11px] text-fg-3">
              Optional. You can add one later in Settings.
            </p>
          </div>
        ) : null}
        <Labeled label="Full name" htmlFor="ob-name">
          <Input
            id="ob-name"
            autoComplete="name"
            maxLength={80}
            placeholder="Meera Shah"
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
              placeholder="meera.shah"
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
        disabled={busy || name.trim().length === 0 || format !== 'ok' || nameCheck !== 'free'}
        onClick={() => void leaveNameStep()}
      >
        Continue
      </Primary>
    );
  } else if (step === 'role') {
    const groups = roleGroupsFor(isClient);
    const isLastProfileStep = !steps.includes('quick');
    body = (
      <>
        <Heading
          title="What do you do?"
          lead="It shows under your name, so people know who to ask."
        />
        {groups.map((group) => (
          <div key={group.label} className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.06em] text-fg-3">
              {group.label}
            </p>
            <div
              role="radiogroup"
              aria-label={`${group.label} roles`}
              className="grid grid-cols-2 gap-2"
            >
              {group.roles.map((option) => (
                <Tile key={option} checked={role === option} onClick={() => setRole(option)}>
                  {option}
                </Tile>
              ))}
            </div>
          </div>
        ))}
        <Tile checked={role === OTHER_ROLE} onClick={() => setRole(OTHER_ROLE)}>
          {OTHER_ROLE}
        </Tile>
        {role === OTHER_ROLE ? (
          <Labeled label="Your role" htmlFor="ob-role-other">
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
        onClick={() => (isLastProfileStep ? void saveProfile() : next())}
      >
        {busy ? 'Saving' : 'Continue'}
      </Primary>
    );
  } else if (step === 'quick') {
    body = (
      <>
        <Heading
          title="Two quick ones"
          lead="Both optional. They help us build Sorted for people like you."
        />
        <ChipGroup
          label="Your age range"
          hint="Never shown to anyone."
          options={AGE_RANGES.map((value) => ({ value, label: value }))}
          value={age}
          onChange={setAge}
        />
        <ChipGroup
          label="How did you hear about Sorted?"
          options={HEARD_FROM.map((option) => ({ value: option.value, label: option.label }))}
          value={heard}
          onChange={setHeard}
        />
      </>
    );
    skip = () => void saveProfile();
    primary = (
      <Primary disabled={busy} onClick={() => void saveProfile()}>
        {busy ? 'Saving' : 'Continue'}
      </Primary>
    );
  } else if (step === 'workspace') {
    const named = wsName.trim().length > 1;
    body = (
      <>
        <Heading
          title="Which brand are you starting with?"
          lead="Each client brand gets its own workspace. Add more any time."
        />
        <Labeled
          label="Workspace name"
          htmlFor="ob-ws"
          hint="Usually the brand's name. Your agency's name works too."
        >
          <Input
            id="ob-ws"
            maxLength={80}
            placeholder="Kite & Co"
            value={wsName}
            disabled={createdWorkspaceId !== null}
            onChange={(event) => setWsName(event.target.value)}
          />
        </Labeled>
        {named ? (
          <GroupLine name={defaultGroupName(wsName)} note="Chat group, made with your workspace" />
        ) : null}
      </>
    );
    primary = (
      <Primary disabled={busy || !named} onClick={() => void createWorkspace()}>
        {busy ? 'Creating' : 'Create workspace'}
      </Primary>
    );
    preview = <WorkspacePreview name={wsName.trim()} />;
  } else if (step === 'firstpost') {
    body = (
      <>
        <Heading
          title="What needs approval first?"
          lead="Add one post now. It will be waiting in review when your client joins."
        />
        {postSent || draftPostId !== null ? (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-panel p-4">
            <span
              className={cn(
                'grid h-9 w-9 place-items-center rounded-full',
                postSent ? 'bg-good-soft text-good' : 'bg-warn-soft text-warn',
              )}
            >
              <CheckGlyph />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-fg">
                {postSent ? 'Your first post is in review' : 'Your first post is saved'}
              </p>
              <p className="text-xs text-fg-2">
                {postSent
                  ? 'Your client sees it as soon as they join.'
                  : 'It still needs to go to review.'}
              </p>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setPostOpen(true)}
            className="flex min-h-[150px] w-full flex-col items-center justify-center gap-1.5 rounded-xl border-[1.5px] border-dashed border-border-strong bg-panel-2 text-sm text-fg-2 hover:bg-panel-3"
          >
            <UploadGlyph />
            <span className="text-[15px] font-semibold text-fg">Add a photo or video</span>
            <span>Then the caption</span>
          </button>
        )}
      </>
    );
    skip = postSent || draftPostId !== null ? null : next;
    primary =
      draftPostId !== null && !postSent ? (
        <Primary disabled={busy} onClick={() => void onPostCreated(draftPostId)}>
          {busy ? 'Sending' : 'Send for review again'}
        </Primary>
      ) : (
        <Primary disabled={busy || !postSent} onClick={next}>
          Continue
        </Primary>
      );
    preview = <WorkspacePreview name={activeWorkspaceName} postSent={postSent} />;
  } else if (step === 'invite') {
    body = (
      <>
        <Heading
          title={`Who works on ${activeWorkspaceName}?`}
          lead="Clients review and approve. Your team makes the posts."
        />
        <div className="flex flex-col gap-2.5">
          {invites.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <label htmlFor={`ob-invite-${i}`} className="sr-only">
                Email {i + 1}
              </label>
              <Input
                id={`ob-invite-${i}`}
                type="email"
                autoComplete="off"
                placeholder={i === 0 ? 'client@brand.com' : 'teammate@agency.com'}
                value={row.email}
                onChange={(event) =>
                  setInvites((prev) =>
                    prev.map((item, j) =>
                      j === i ? { ...item, email: event.target.value } : item,
                    ),
                  )
                }
                className="min-w-0 flex-1"
              />
              <div
                role="group"
                aria-label={`Side for email ${i + 1}`}
                className="flex shrink-0 overflow-hidden rounded-md border border-border"
              >
                {(['client', 'team'] as const).map((side) => (
                  <button
                    key={side}
                    type="button"
                    aria-pressed={row.side === side}
                    onClick={() =>
                      setInvites((prev) =>
                        prev.map((item, j) => (j === i ? { ...item, side } : item)),
                      )
                    }
                    className={cn(
                      'h-11 min-w-[56px] px-3 text-xs font-medium',
                      row.side === side ? 'bg-fg text-bg' : 'bg-panel text-fg-2',
                    )}
                  >
                    {side === 'client' ? 'Client' : 'Team'}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setInvites((prev) => [...prev, { email: '', side: 'team' }])}
            className="min-h-[44px] rounded-md border border-dashed border-border-strong text-sm font-medium text-fg-2 hover:bg-panel-2"
          >
            Add another person
          </button>
        </div>
        <Toggle
          label={`Invite them to the ${defaultGroupName(activeWorkspaceName)} chat group`}
          checked={joinGroup}
          onChange={setJoinGroup}
        />
      </>
    );
    skip = () => finish('/chat');
    primary = (
      <Primary disabled={busy || validInvites === 0} onClick={() => void sendInvites()}>
        {busy
          ? 'Sending'
          : validInvites > 0
            ? `Send ${validInvites} invite${validInvites > 1 ? 's' : ''}`
            : 'Send invites'}
      </Primary>
    );
    preview = (
      <InvitePreview
        name={name}
        rows={invites}
        group={joinGroup ? defaultGroupName(activeWorkspaceName) : null}
      />
    );
  } else {
    // ready
    body = (
      <ReadyBody
        name={name}
        isClient={isClient}
        facts={ready}
        workspace={joinedWorkspaceName ?? ''}
      />
    );
    const firstPost = ready?.firstReviewPostId ?? null;
    primary =
      isClient && firstPost !== null ? (
        <Primary disabled={busy} onClick={() => finish(`/posts/${firstPost}`)}>
          Review the first post
        </Primary>
      ) : (
        <Primary disabled={busy || ready === null} onClick={() => finish('/chat')}>
          Open {joinedWorkspaceName ?? 'your workspace'}
        </Primary>
      );
    preview = <WaitingPreview workspace={joinedWorkspaceName ?? ''} facts={ready} />;
  }

  // Back is offered inside the profile steps only; a created workspace is not undone.
  const canGoBack =
    index > 0 &&
    step !== 'ready' &&
    step !== 'firstpost' &&
    step !== 'invite' &&
    step !== 'password';

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
            {skip !== null ? (
              <button
                type="button"
                onClick={skip}
                disabled={busy}
                className="min-h-[44px] min-w-[44px] px-1 text-sm font-medium text-fg-2 hover:text-fg"
              >
                Skip
              </button>
            ) : null}
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
        {preview}
      </aside>

      {activeWorkspaceId !== null ? (
        <CreatePostSheet
          open={postOpen}
          workspaceId={activeWorkspaceId}
          onClose={() => setPostOpen(false)}
          onCreated={(postId) => void onPostCreated(postId)}
        />
      ) : null}
    </div>
  );
}

// ---------- data ----------

export interface ReadyFacts {
  inReview: number;
  firstReviewPostId: string | null;
  people: string[];
  groupName: string | null;
  inFlight: number;
}

async function loadReadyFacts(workspaceId: string, userId: string): Promise<ReadyFacts> {
  const [posts, members, group] = await Promise.all([
    supabase
      .from('posts')
      .select('id, stage, target_date')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .in('stage', ['draft', 'review'])
      .order('target_date', { ascending: true, nullsFirst: false })
      .limit(200),
    supabase
      .from('workspace_members')
      .select('user_id')
      .eq('workspace_id', workspaceId)
      .eq('active', true)
      .neq('user_id', userId)
      .limit(50),
    supabase
      .from('groups')
      .select('name')
      .eq('workspace_id', workspaceId)
      .eq('is_default', true)
      .is('deleted_at', null)
      .maybeSingle(),
  ]);
  const rows = posts.data ?? [];
  const review = rows.filter((row) => row.stage === 'review');
  const ids = (members.data ?? []).map((row) => row.user_id);
  let people: string[] = [];
  if (ids.length > 0) {
    const users = await supabase.from('users').select('display_name').in('id', ids).limit(50);
    people = (users.data ?? []).map((row) => row.display_name);
  }
  return {
    inReview: review.length,
    firstReviewPostId: review[0]?.id ?? null,
    people,
    groupName: group.data?.name ?? null,
    inFlight: rows.length,
  };
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

function Tile({
  checked,
  onClick,
  children,
}: {
  checked: boolean;
  onClick: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onClick}
      className={cn(
        'min-h-[48px] rounded-lg border bg-panel px-3 py-2 text-left text-sm leading-tight',
        checked ? 'border-fg font-semibold text-fg ring-1 ring-fg' : 'border-border text-fg',
      )}
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

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}): ReactElement {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-3 text-sm">
      <span className="[text-wrap:pretty]">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-11 w-[60px] shrink-0 items-center rounded-full px-1 transition-colors',
          checked ? 'bg-fg' : 'bg-panel-3',
        )}
      >
        <span
          className={cn(
            'h-7 w-7 rounded-full bg-panel transition-transform motion-reduce:transition-none',
            checked ? 'translate-x-[24px]' : 'translate-x-0',
          )}
        />
      </button>
    </div>
  );
}

function GroupLine({ name, note }: { name: string; note: string }): ReactElement {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-panel p-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-sm font-bold text-accent">
        {initialsOf(name)}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-fg">{name}</p>
        <p className="text-xs text-fg-3">{note}</p>
      </div>
    </div>
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

function WorkspacePreview({
  name,
  postSent = false,
}: {
  name: string;
  postSent?: boolean;
}): ReactElement {
  const group = name === '' ? 'Your brand' : defaultGroupName(name);
  return (
    <>
      <PreviewLabel>Your chat home</PreviewLabel>
      <PreviewCard label="Groups">
        <div className="flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-sm font-bold text-accent">
            {initialsOf(group)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-fg">{group}</p>
            <p className="text-xs text-fg-3">
              {postSent
                ? 'You. Your first post is in review.'
                : 'You. More join as you invite them.'}
            </p>
          </div>
        </div>
      </PreviewCard>
      <PreviewCard label="One place">
        <p className="text-sm text-fg-2">
          Every post, brief and approval for this brand lives here.
        </p>
      </PreviewCard>
    </>
  );
}

function InvitePreview({
  name,
  rows,
  group,
}: {
  name: string;
  rows: InviteRow[];
  group: string | null;
}): ReactElement {
  const valid = rows.filter((row) => isValidInviteEmail(row.email));
  return (
    <>
      <PreviewLabel>{group !== null ? `${group} chat group` : 'People'}</PreviewLabel>
      <PreviewCard label="Members">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2.5">
            <Avatar name={name || 'You'} size="md" />
            <div>
              <p className="text-sm font-semibold text-fg">{name.trim() || 'You'}</p>
              <p className="text-xs text-fg-3">Admin</p>
            </div>
          </div>
          {valid.length === 0 ? (
            <p className="text-xs text-fg-3">Add an email to see them here.</p>
          ) : (
            valid.map((row) => (
              <div key={row.email} className="flex items-center gap-2.5">
                <Avatar name={row.email} size="md" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-fg">{row.email.trim()}</p>
                  <p className="text-xs text-fg-3">
                    {row.side === 'client' ? 'Client' : 'Team'} · invited
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
      </PreviewCard>
    </>
  );
}

function WaitingPreview({
  workspace,
  facts,
}: {
  workspace: string;
  facts?: ReadyFacts | null;
}): ReactElement {
  return (
    <>
      <PreviewLabel>Waiting for you</PreviewLabel>
      <PreviewCard label="Workspace">
        <div className="flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-sm font-bold text-accent">
            {initialsOf(workspace)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-fg">{workspace}</p>
            <p className="text-xs text-fg-3">
              {facts != null
                ? `${facts.inReview} in review · ${facts.people.length + 1} people`
                : 'Ready when you are'}
            </p>
          </div>
        </div>
      </PreviewCard>
    </>
  );
}

function ReadyBody({
  name,
  isClient,
  facts,
  workspace,
}: {
  name: string;
  isClient: boolean;
  facts: ReadyFacts | null;
  workspace: string;
}): ReactElement {
  const hello = firstName(name);
  if (facts === null) {
    return (
      <Heading
        title={`You're in${hello ? `, ${hello}` : ''}`}
        lead="Getting your workspace ready."
      />
    );
  }
  const rows: { lead: ReactNode; title: string; note: string }[] = [];
  if (isClient) {
    rows.push({
      lead: <Num>{facts.inReview}</Num>,
      title: facts.inReview === 1 ? 'Post needs your review' : 'Posts need your review',
      note:
        facts.inReview === 0
          ? "You'll get an email when one is ready"
          : 'Approve or comment on each one',
    });
  }
  rows.push({
    lead: <Num>{facts.people.length}</Num>,
    title: peopleLine(facts.people),
    note: isClient ? 'Your team at the agency' : 'The people you work with here',
  });
  if (!isClient) {
    rows.push({
      lead: <Num>{facts.inFlight}</Num>,
      title: facts.inFlight === 1 ? 'Post in flight' : 'Posts in flight',
      note: `${facts.inReview} in review, ${facts.inFlight - facts.inReview} in draft`,
    });
  }
  if (facts.groupName !== null) {
    rows.push({
      lead: (
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent-soft text-xs font-bold text-accent">
          {initialsOf(facts.groupName)}
        </span>
      ),
      title: `${facts.groupName} group`,
      note: isClient ? 'Talk to the agency here' : 'Client and team, one conversation',
    });
  }
  return (
    <>
      <Heading
        title={`You're in${hello ? `, ${hello}` : ''}`}
        lead={
          isClient
            ? `Here's what's waiting for you at ${workspace}.`
            : `Here's who you'll work with on ${workspace}.`
        }
      />
      <div className="flex flex-col gap-3">
        {rows.map((row) => (
          <div
            key={row.title}
            className="flex items-center gap-3 rounded-lg border border-border bg-panel p-3.5"
          >
            <span className="flex w-9 shrink-0 justify-center">{row.lead}</span>
            <div className="min-w-0">
              <p className="text-[15px] font-semibold text-fg">{row.title}</p>
              <p className="text-[13px] text-fg-2">{row.note}</p>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function Num({ children }: { children: ReactNode }): ReactElement {
  return <span className="font-mono text-[22px] font-medium tabular-nums text-fg">{children}</span>;
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

function CheckGlyph(): ReactElement {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

function UploadGlyph(): ReactElement {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 16V4M7 9l5-5 5 5" />
      <path d="M4 16v4h16v-4" />
    </svg>
  );
}
