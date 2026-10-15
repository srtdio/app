import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { workspaceCreate } from '@srtdio/rpc';
import { PLATFORM_LABELS, POST_PLATFORMS, type PostPlatform } from '@srtdio/posts';
import type { Json } from '@srtdio/schemas';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { PlatformMark } from '@/components/ui/PlatformMark';
import { IconCheck, IconPlus, IconX } from '@/components/ui/icons';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { useWorkspace, workspaceDisplayName } from '@/lib/workspace-context';
import { cn } from '@/lib/cn';

const NAME_MIN = 1;
const NAME_MAX = 80;

type Mode = 'list' | 'create' | 'confirm';

/** The dialog title per step. */
export function switcherTitle(mode: Mode): string {
  if (mode === 'list') return 'Switch workspace';
  if (mode === 'create') return 'Create workspace';
  return 'One platform per workspace';
}

/**
 * The workspace_create payload: brand name, the browser's timezone and the
 * platform picked on the create step. Pure so the payload is unit-tested.
 */
export function workspaceCreatePayload(input: {
  name: string;
  platform: PostPlatform;
  timezone: string;
}): Json {
  return { name: input.name.trim(), timezone: input.timezone, platform: input.platform };
}

/**
 * Centered modal (identical on desktop and mobile) that lets the signed-in user
 * switch the active workspace or create a new one. Opens in response to the
 * shell-wide 'sorted:switch-workspace' CustomEvent dispatched by Sidebar /
 * AvatarMenu; the listener is registered on mount and torn down on unmount.
 * Active-workspace state stays in React only (no localStorage/URL persistence).
 */
export function WorkspaceSwitcher() {
  const { workspaceId, workspaces, loading, error, setActiveWorkspaceId, refreshWorkspaces } =
    useWorkspace();
  const newTrace = useNewTrace();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('list');
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<PostPlatform | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setMode('list');
    setName('');
    setPlatform(null);
    setFormError(null);
    setSubmitting(false);
  }, []);

  // Open on the shell event; always reset to list mode for a fresh open.
  useEffect(() => {
    function onSwitch(): void {
      setMode('list');
      setName('');
      setPlatform(null);
      setFormError(null);
      setOpen(true);
    }
    window.addEventListener('sorted:switch-workspace', onSwitch);
    return () => {
      window.removeEventListener('sorted:switch-workspace', onSwitch);
    };
  }, []);

  // Escape closes, matching the rest of the shell's overlays.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  function selectWorkspace(id: string): void {
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
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const payload = workspaceCreatePayload({ name: trimmedName, platform, timezone });
      const res = await workspaceCreate(supabase, { p_payload: payload, p_trace_id: newTrace() });
      if (!res.ok) {
        setFormError(res.error.message);
        return;
      }
      await refreshWorkspaces();
      setActiveWorkspaceId(res.data);
      close();
    } catch (err: unknown) {
      setFormError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  function onOverlayClick(event: MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) close();
  }

  const title = switcherTitle(mode);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      onClick={onOverlayClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex w-full max-w-[420px] max-h-[84vh] flex-col overflow-hidden rounded-xl border border-border-strong bg-panel shadow-2xl"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-[18px] py-[15px]">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <span className="ml-auto">
            <IconButton label="Close" onClick={close}>
              <IconX />
            </IconButton>
          </span>
        </div>

        {mode === 'list' ? (
          <div className="flex flex-col overflow-y-auto p-1.5">
            {loading ? (
              <p className="px-3 py-4 text-sm text-fg-3">Loading workspaces...</p>
            ) : error !== null ? (
              <p className="px-3 py-4 text-sm text-bad">{error}</p>
            ) : workspaces.length === 0 ? (
              <p className="px-3 py-4 text-sm text-fg-3">No workspaces yet.</p>
            ) : (
              workspaces.map((ws) => {
                const isActive = ws.id === workspaceId;
                return (
                  <button
                    key={ws.id}
                    type="button"
                    onClick={() => selectWorkspace(ws.id)}
                    aria-current={isActive}
                    className={cn(
                      'flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors',
                      isActive ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:bg-panel-2',
                    )}
                  >
                    <Avatar name={ws.name} size="lg" />
                    <span className="flex-1 truncate text-sm font-medium text-fg">
                      {workspaceDisplayName(ws)}
                    </span>
                    {isActive ? <IconCheck size={18} className="shrink-0 text-accent" /> : null}
                  </button>
                );
              })
            )}
            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              onClick={() => {
                setFormError(null);
                setName('');
                setPlatform(null);
                setMode('create');
              }}
              className="flex min-h-[44px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-medium text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg"
            >
              <IconPlus size={18} className="shrink-0 text-fg-3" />
              <span>Create workspace</span>
            </button>
          </div>
        ) : mode === 'create' ? (
          <form onSubmit={submitDetails} className="flex flex-col gap-4 overflow-y-auto p-[18px]">
            <Field label="Brand name" htmlFor="workspace-name" required>
              <Input
                id="workspace-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={NAME_MAX}
                placeholder="Ramy Group"
                autoFocus
              />
            </Field>
            <div>
              <p id="workspace-platform-label" className="mb-1.5 block text-sm font-medium">
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
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setPlatform(value)}
                      className={cn(
                        'flex min-h-[44px] min-w-[44px] items-center gap-2 rounded-lg border px-3 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                        selected
                          ? 'border-accent bg-accent-soft text-accent'
                          : 'border-border text-fg-2 hover:bg-panel-2 hover:text-fg',
                      )}
                    >
                      <PlatformMark platform={value} />
                      <span className="min-w-0 break-words">{PLATFORM_LABELS[value]}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            {preview !== null ? (
              <p className="text-[13px] leading-snug text-fg-3">
                Shown as <span className="font-medium text-fg">{preview}</span>. The chat group
                takes the same name.
              </p>
            ) : null}
            {formError !== null ? <p className="text-sm text-bad">{formError}</p> : null}
            <div className="flex items-center justify-end gap-2.5">
              <Button
                type="button"
                variant="ghost"
                size="lg"
                onClick={() => {
                  setFormError(null);
                  setMode('list');
                }}
              >
                Back
              </Button>
              <Button type="submit" variant="primary" size="lg" disabled={preview === null}>
                Continue
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-4 p-[18px]">
            <p className="text-sm leading-relaxed text-fg-2">
              Check the spelling: <span className="font-semibold text-fg">{preview}</span>{' '}
              can&apos;t be changed later. To change it, you delete this workspace and create a new
              one.
            </p>
            {formError !== null ? <p className="text-sm text-bad">{formError}</p> : null}
            <div className="flex items-center justify-end gap-2.5">
              <Button
                type="button"
                variant="ghost"
                size="lg"
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
                size="lg"
                onClick={() => void submitCreate()}
                disabled={submitting}
              >
                {submitting ? 'Creating...' : 'Create'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
