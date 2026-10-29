import { mark } from '@/lib/perf-marks';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { workspaceCreate } from '@srtdio/rpc';
import { PLATFORM_LABELS, POST_PLATFORMS, type PostPlatform } from '@srtdio/posts';
import type { Json } from '@srtdio/schemas';
import { BookCallSheet } from '@/components/support/BookCallSheet';
import { ContactSheet } from '@/components/support/ContactSheet';
import { SupportRows } from '@/components/support/SupportRows';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Field } from '@/components/ui/Field';
import { Backdrop } from '@/components/ui/Backdrop';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { PlatformMark } from '@/components/ui/PlatformMark';
import { PressableRow } from '@/components/ui/PressableRow';
import { IconCheck, IconPlus, IconX, ICON_SIZE } from '@/components/ui/icons';
import { storeInductionStep } from '@/components/induction/induction-data';
import { anotherWorkspaceRequest } from '@/lib/support';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import {
  useWorkspace,
  workspaceCreateErrorMessage,
  workspaceDisplayName,
  WORKSPACE_LIMIT_MESSAGE,
} from '@/lib/workspace-context';
import { cn } from '@/lib/cn';
import { INDUCTION_KEYS } from '@/lib/induction-keys';
import { APPROVER_BRAND_STEP, type InductionState } from '@/lib/induction';
import { WORKSPACE_CREATE_COPY } from '@/lib/induction-copy';
import { ROUTE_PREFIX } from '@/lib/induction-model';
import { useBackGuard } from '@/lib/back-guard';
import { useEscapeLayer } from '@/lib/escape-stack';
import { useModalFocus } from '@/lib/modal-focus';
import { deviceTimeZone } from '@/lib/time';

const NAME_MIN = 1;
const NAME_MAX = 80;

type Mode = 'list' | 'create' | 'confirm';

/** The dialog title per step. */
function switcherTitle(mode: Mode): string {
  if (mode === 'list') return 'Switch workspace';
  if (mode === 'create') return 'Create workspace';
  return 'One platform per workspace';
}

/**
 * The workspace_create payload: brand name, the browser's timezone and the
 * platform picked on the create step. Pure so the payload is unit-tested.
 */
function workspaceCreatePayload(input: {
  name: string;
  platform: PostPlatform;
  timezone: string;
}): Json {
  return { name: input.name.trim(), timezone: input.timezone, platform: input.platform };
}

/**
 * Whether the create step offers "I approve posts instead": only to a person
 * with no workspace who signed up on their own (an invitee's stored steps carry
 * the invited route prefix) and whose induction is not done (a done induction
 * reads as no approver stage, so the switch could not reopen the flow). Pure.
 */
export function approverSwitchShown(input: {
  workspaceCount: number;
  state: Pick<InductionState, 'step' | 'done'>;
}): boolean {
  if (input.workspaceCount > 0 || input.state.done) return false;
  return !(input.state.step ?? '').startsWith(ROUTE_PREFIX.invited);
}

/** Whether the create step holds input worth asking about before it goes. Pure. */
export function createStepDirty(input: {
  mode: Mode;
  name: string;
  platform: PostPlatform | null;
}): boolean {
  return input.mode !== 'list' && (input.name.trim() !== '' || input.platform !== null);
}

interface WorkspaceSwitcherProps {
  /**
   * The induction's setStep, passed only by the no-workspace shell for a person
   * who may still switch to Approver (approverSwitchShown). Storing
   * APPROVER_BRAND_STEP makes AppLayout's gate read approverStageOf as 'brand'
   * and open OnboardingFlow on the brand screen.
   */
  onInductionStep?: (step: string) => Promise<boolean>;
}

/**
 * Centered modal (identical on desktop and mobile) that lets the signed-in user
 * switch the active workspace or create a new one. Opens in response to the
 * shell-wide 'sorted:switch-workspace' CustomEvent dispatched by Sidebar /
 * AvatarMenu; the listener is registered on mount and torn down on unmount.
 * Active-workspace state stays in React only (no localStorage/URL persistence).
 */
export function WorkspaceSwitcher({ onInductionStep }: WorkspaceSwitcherProps = {}) {
  const {
    workspaceId,
    workspaces,
    loading,
    error,
    setActiveWorkspaceId,
    refreshWorkspaces,
    createBlocked,
    workspaceDisplayName: activeDisplayName,
    deletedWorkspace,
    clearDeletedWorkspace,
  } = useWorkspace();
  const newTrace = useNewTrace();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('list');
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<PostPlatform | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [support, setSupport] = useState<'contact' | 'book' | null>(null);
  // The two asks over the dialog: discard a half-filled form, switch to Approver.
  const [discarding, setDiscarding] = useState(false);
  const [askingSwitch, setAskingSwitch] = useState(false);
  const [switching, setSwitching] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const hasDeleted = deletedWorkspace !== null;

  const close = useCallback(() => {
    setOpen(false);
    setMode('list');
    setName('');
    setPlatform(null);
    setFormError(null);
    setSubmitting(false);
    setSupport(null);
    setDiscarding(false);
    setAskingSwitch(false);
    setSwitching(false);
    clearDeletedWorkspace();
  }, [clearDeletedWorkspace]);

  const dirty = open && createStepDirty({ mode, name, platform });
  const busy = submitting || switching;

  // Every dismiss (X, backdrop, Escape, system Back) funnels here: busy keeps
  // the dialog, a typed brand name or picked platform asks first.
  function requestClose(): void {
    if (busy) return;
    if (dirty) {
      setDiscarding(true);
      return;
    }
    close();
  }

  // System or browser Back with something to lose asks the same discard
  // confirm; released right before a confirmed Discard or the switch.
  const guard = useBackGuard({
    active: dirty || (open && busy),
    onBack: () => {
      if (busy) return;
      setDiscarding(true);
    },
  });

  // Open on the shell event; a fresh open starts on the list, or straight on
  // the create form right after a workspace was deleted or when there is none
  // yet (the list would only hold Create workspace).
  const startOnCreate = hasDeleted || (!loading && workspaces.length === 0 && !createBlocked);
  useEffect(() => {
    function onSwitch(): void {
      setMode(startOnCreate ? 'create' : 'list');
      setName('');
      setPlatform(null);
      setFormError(null);
      setOpen(true);
    }
    window.addEventListener('sorted:switch-workspace', onSwitch);
    return () => {
      window.removeEventListener('sorted:switch-workspace', onSwitch);
    };
  }, [startOnCreate]);

  // A workspace was just deleted: open on the create form.
  useEffect(() => {
    if (!hasDeleted) return;
    setMode('create');
    setName('');
    setPlatform(null);
    setFormError(null);
    setOpen(true);
  }, [hasDeleted]);

  // Escape reaches the dialog only while it is the top layer: a support sheet
  // or a confirm over it takes Escape for itself.
  useEscapeLayer(open, requestClose);

  // Focus moves into the dialog on open (the brand name on the create step;
  // never a text field on a phone), Tab stays inside, and the opener gets it
  // back on close.
  useModalFocus(panelRef, open, {
    initial: () =>
      mode === 'create'
        ? panelRef.current?.querySelector<HTMLInputElement>('#workspace-name')
        : null,
  });

  const switchOffered = onInductionStep !== undefined && !loading && workspaces.length === 0;

  /**
   * Switch to Approver: the step is stored first (awaited, so a failure keeps
   * the dialog and says so), then handed to the induction's setStep, which
   * flips the gate's state at once and AppLayout opens the brand screen.
   */
  async function switchToApprover(): Promise<void> {
    if (onInductionStep === undefined || switching) return;
    setSwitching(true);
    setFormError(null);
    const stored = await storeInductionStep(supabase, {
      step: APPROVER_BRAND_STEP,
      traceId: newTrace(),
    });
    if (!stored.ok) {
      setSwitching(false);
      setAskingSwitch(false);
      setFormError(WORKSPACE_CREATE_COPY.switchFailed);
      return;
    }
    guard.release();
    const saved = await onInductionStep(APPROVER_BRAND_STEP);
    // The gate has opened the flow and this dialog is gone; a refused second
    // write (the step already stored above) only leaves it to say so.
    if (!saved) {
      setSwitching(false);
      setAskingSwitch(false);
      setFormError(WORKSPACE_CREATE_COPY.switchFailed);
    }
  }

  function selectWorkspace(id: string): void {
    mark('workspace:switch');
    setActiveWorkspaceId(id);
    close();
  }

  const trimmedName = name.trim();
  const preview =
    trimmedName !== '' && platform !== null
      ? workspaceDisplayName({ name: trimmedName, platform })
      : null;

  // Step 1 -> 2: both the brand name and a platform are required.
  function submitDetails(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (platform === null) return;
    if (trimmedName.length < NAME_MIN || trimmedName.length > NAME_MAX) {
      setFormError(`Brand name must be ${NAME_MIN} to ${NAME_MAX} characters.`);
      return;
    }
    setFormError(null);
    setMode('confirm');
  }

  async function submitCreate(): Promise<void> {
    if (platform === null || trimmedName === '') return;
    setSubmitting(true);
    setFormError(null);
    try {
      const timezone = deviceTimeZone();
      const payload = workspaceCreatePayload({ name: trimmedName, platform, timezone });
      const res = await workspaceCreate(supabase, { p_payload: payload, p_trace_id: newTrace() });
      if (!res.ok) {
        setFormError(workspaceCreateErrorMessage(res.error.message));
        return;
      }
      await refreshWorkspaces();
      setActiveWorkspaceId(res.data);
      // Created: nothing left to lose, so the Back guard goes before the dialog.
      guard.release();
      close();
    } catch (err: unknown) {
      setFormError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  const title = switcherTitle(mode);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <Backdrop position="absolute" aria-label="Close" onClick={requestClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex w-full max-w-[420px] max-h-[84vh] flex-col overflow-hidden rounded-xl border border-border-strong bg-panel shadow-2xl outline-none"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-[18px] py-[15px]">
          <h2 className="text-lg font-semibold">{title}</h2>
          <span className="ml-auto">
            <IconButton label="Close" onClick={requestClose}>
              <IconX />
            </IconButton>
          </span>
        </div>

        {mode === 'list' ? (
          <div className="flex flex-col overflow-y-auto p-1.5">
            {loading ? (
              <p className="px-3 py-4 text-base text-fg-3">Loading workspaces...</p>
            ) : error !== null ? (
              <p className="px-3 py-4 text-base text-bad">{error}</p>
            ) : workspaces.length === 0 ? (
              <p className="px-3 py-4 text-base text-fg-3">Workspaces you join show up here.</p>
            ) : (
              workspaces.map((ws) => {
                const isActive = ws.id === workspaceId;
                return (
                  <PressableRow
                    key={ws.id}
                    type="button"
                    onClick={() => selectWorkspace(ws.id)}
                    aria-current={isActive}
                    className={cn(
                      'flex items-center gap-2.5 px-2.5 transition-colors',
                      isActive ? 'bg-accent-soft text-accent' : 'text-fg-2',
                    )}
                  >
                    <Avatar name={ws.name} role="row" kind="group" />
                    <span className="flex-1 truncate text-base font-medium text-fg">
                      {workspaceDisplayName(ws)}
                    </span>
                    {isActive ? (
                      <IconCheck size={ICON_SIZE.nav} className="shrink-0 text-accent" />
                    ) : null}
                  </PressableRow>
                );
              })
            )}
            <div className="my-1 h-px bg-border" />
            <PressableRow
              type="button"
              disabled={createBlocked}
              aria-describedby={createBlocked ? 'workspace-limit-note' : undefined}
              onClick={() => {
                setFormError(null);
                setName('');
                setPlatform(null);
                setMode('create');
              }}
              className="flex items-center gap-3 px-3 text-base font-medium text-fg-2 transition-colors hover:text-fg disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-fg-2"
            >
              <IconPlus size={ICON_SIZE.nav} className="shrink-0 text-fg-3" />
              <span>Create workspace</span>
            </PressableRow>
            {createBlocked ? (
              <>
                <p id="workspace-limit-note" className="px-3 pb-2 text-base leading-snug text-fg-2">
                  {WORKSPACE_LIMIT_MESSAGE}
                </p>
                <SupportRows
                  onContact={() => setSupport('contact')}
                  onBook={() => setSupport('book')}
                />
              </>
            ) : null}
          </div>
        ) : mode === 'create' ? (
          <form onSubmit={submitDetails} className="flex flex-col gap-4 overflow-y-auto p-[18px]">
            {deletedWorkspace !== null ? (
              <p className="text-base leading-snug text-fg-2">
                {deletedWorkspace.name} is gone. Start a new one.
              </p>
            ) : null}
            <Field label="Brand name" htmlFor="workspace-name" required>
              <Input
                id="workspace-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={NAME_MAX}
                placeholder="Ramy Group"
              />
            </Field>
            <div>
              <p id="workspace-platform-label" className="mb-1.5 block text-base font-medium">
                Platform<span className="ml-0.5 text-bad">*</span>
              </p>
              <div
                role="radiogroup"
                aria-labelledby="workspace-platform-label"
                className="grid grid-cols-2 gap-2"
              >
                {POST_PLATFORMS.map((value) => {
                  const selected = value === platform;
                  return (
                    <PressableRow
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setPlatform(value)}
                      className={cn(
                        'flex min-w-[44px] items-center gap-2 border px-3 text-base font-medium transition-colors',
                        selected
                          ? 'border-accent bg-accent-soft text-accent'
                          : 'border-border text-fg-2 hover:text-fg',
                      )}
                    >
                      <PlatformMark platform={value} />
                      <span className="min-w-0 break-words">{PLATFORM_LABELS[value]}</span>
                    </PressableRow>
                  );
                })}
              </div>
            </div>
            {preview !== null ? (
              <p className="text-base leading-snug text-fg-2">
                Shown as <span className="font-medium text-fg">{preview}</span>. The chat group
                takes the same name.
              </p>
            ) : null}
            {formError !== null ? <p className="text-base text-bad">{formError}</p> : null}
            <div className="flex items-center justify-end gap-2.5">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setFormError(null);
                  setMode('list');
                  clearDeletedWorkspace();
                }}
              >
                Back
              </Button>
              <Button
                type="submit"
                variant="primary"
                data-induction={INDUCTION_KEYS.workspaceCreateContinue}
                disabled={preview === null || switching}
              >
                Continue
              </Button>
            </div>
            {switchOffered ? (
              <Button
                type="button"
                variant="link"
                disabled={switching}
                onClick={() => {
                  setFormError(null);
                  setAskingSwitch(true);
                }}
                className="w-full"
              >
                {WORKSPACE_CREATE_COPY.approveInstead}
              </Button>
            ) : null}
          </form>
        ) : (
          <div className="flex flex-col gap-4 p-[18px]">
            <p className="text-base leading-relaxed text-fg-2">
              Check the spelling: <span className="font-semibold text-fg">{preview}</span>{' '}
              can&apos;t be changed later. To change it, you delete this workspace and create a new
              one.
            </p>
            {formError !== null ? <p className="text-base text-bad">{formError}</p> : null}
            <div className="flex items-center justify-end gap-2.5">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setFormError(null);
                  setMode('create');
                }}
                disabled={submitting}
              >
                Back
              </Button>
              <Button
                type="button"
                variant="primary"
                data-induction={INDUCTION_KEYS.workspaceCreateSubmit}
                onClick={() => void submitCreate()}
                disabled={submitting}
              >
                {submitting ? 'Creating...' : 'Create'}
              </Button>
            </div>
          </div>
        )}
      </div>
      {askingSwitch ? (
        <ConfirmDialog
          title={WORKSPACE_CREATE_COPY.switchTitle}
          message={WORKSPACE_CREATE_COPY.switchMessage}
          cancelLabel={WORKSPACE_CREATE_COPY.keepCreator}
          confirmLabel={WORKSPACE_CREATE_COPY.switchConfirm}
          busy={switching}
          busyLabel={WORKSPACE_CREATE_COPY.switching}
          onConfirm={() => void switchToApprover()}
          onCancel={() => setAskingSwitch(false)}
        />
      ) : null}
      {discarding ? (
        <ConfirmDialog
          title={WORKSPACE_CREATE_COPY.discardTitle}
          message={WORKSPACE_CREATE_COPY.discardMessage}
          confirmLabel={WORKSPACE_CREATE_COPY.discardConfirm}
          cancelLabel={WORKSPACE_CREATE_COPY.keepEditing}
          destructive
          onConfirm={() => {
            setDiscarding(false);
            // Release first: the guard's entry pops before the dialog goes.
            guard.release();
            close();
          }}
          onCancel={() => setDiscarding(false)}
        />
      ) : null}
      <ContactSheet
        open={support === 'contact'}
        onClose={() => setSupport(null)}
        workspaceName={activeDisplayName ?? ''}
        request={anotherWorkspaceRequest(activeDisplayName ?? '')}
      />
      {workspaceId !== null ? (
        <BookCallSheet
          open={support === 'book'}
          onClose={() => setSupport(null)}
          workspaceId={workspaceId}
        />
      ) : null}
    </div>,
    document.body,
  );
}
