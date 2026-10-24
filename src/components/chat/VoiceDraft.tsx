// The voice note draft above the composer (FT42) and the "Stop recording?"
// ask on system Back while recording. Store rules live in
// src/lib/chat/voice-draft.ts. Tokens only, so light and dark stay at parity;
// every control is 44px.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { IconPause, IconPlay, IconSend, IconTrash } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { useEscapeLayer } from '@/lib/escape-stack';
import { useModalFocus } from '@/lib/modal-focus';
import { BACK_GUARD_STEP_KEY, stepMarkerOf } from '@/lib/chat/use-history-step';
import { voiceDraftLabel, type VoiceDraft } from '@/lib/chat/voice-draft';

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

/** The draft row's markup. Hook-free (playback state comes in) so it is unit tested. */
export function voiceDraftView(props: {
  durationMs: number;
  playing: boolean;
  busy: boolean;
  onPlay: () => void;
  onSend: () => void;
  onDelete: () => void;
}): ReactElement {
  const label = voiceDraftLabel(props.durationMs);
  return (
    <div
      data-voice-draft=""
      role="group"
      aria-label={`Saved ${label.toLowerCase()}`}
      className="flex items-center gap-1 rounded-xl border border-border bg-panel-2 py-0.5 pl-1 pr-0.5"
    >
      <IconButton
        type="button"
        data-voice-draft-play=""
        label={props.playing ? 'Pause voice note' : 'Play voice note'}
        onClick={props.onPlay}
        className={cn('shrink-0 hover:bg-panel-3', FOCUS_RING)}
      >
        {props.playing ? <IconPause size={20} /> : <IconPlay size={20} />}
      </IconButton>
      <span className="min-w-0 flex-1 truncate text-base text-fg-2 tabular-nums">{label}</span>
      <IconButton
        type="button"
        data-voice-draft-delete=""
        label="Delete voice note"
        disabled={props.busy}
        onClick={props.onDelete}
        className={cn(
          'shrink-0 text-bad hover:bg-bad-soft hover:text-bad disabled:opacity-50',
          FOCUS_RING,
        )}
      >
        <IconTrash size={20} />
      </IconButton>
      <Button
        type="button"
        variant="primary"
        shape="round"
        data-voice-draft-send=""
        aria-label="Send voice note"
        disabled={props.busy}
        onClick={props.onSend}
        className={cn('shrink-0', FOCUS_RING)}
      >
        <IconSend size={20} />
      </Button>
    </div>
  );
}

/** The draft row with its own playback (one object URL per draft, freed on change). */
export function VoiceDraftBar(props: {
  draft: VoiceDraft;
  busy: boolean;
  onSend: () => void;
  onDelete: () => void;
}): ReactElement {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    try {
      made = URL.createObjectURL(props.draft.blob);
    } catch {
      made = null;
    }
    setUrl(made);
    setPlaying(false);
    return () => {
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, [props.draft.blob]);
  const toggle = (): void => {
    const audio = audioRef.current;
    if (audio === null) return;
    if (playing) {
      audio.pause();
      return;
    }
    void audio.play().catch(() => setPlaying(false));
  };
  return (
    <>
      {voiceDraftView({
        durationMs: props.draft.durationMs,
        playing,
        busy: props.busy,
        onPlay: toggle,
        onSend: props.onSend,
        onDelete: props.onDelete,
      })}
      {url !== null ? (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          className="hidden"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      ) : null}
    </>
  );
}

export const STOP_RECORDING_TITLE = 'Stop recording?';
export const STOP_RECORDING_KEEP = 'Keep recording';
export const STOP_RECORDING_SAVE = 'Save as draft';
export const STOP_RECORDING_DISCARD = 'Discard';

/**
 * System Back while recording (7d): Keep recording, Save as draft or Discard.
 * A modal alert dialog: focus moves in, Tab stays inside, Escape and a scrim
 * tap keep recording.
 */
export function StopRecordingDialog(props: {
  onKeep: () => void;
  onSave: () => void;
  onDiscard: () => void;
}): ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);
  useEscapeLayer(true, props.onKeep);
  useModalFocus(panelRef, true);
  return createPortal(
    <div
      data-stop-recording=""
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onKeep();
      }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-scrim px-4 pt-4 pb-[max(16px,env(safe-area-inset-bottom))] sm:items-center"
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={STOP_RECORDING_TITLE}
        tabIndex={-1}
        className="w-full max-w-sm rounded-2xl border border-border bg-panel p-5 shadow-lg outline-none"
      >
        <h2 className="text-lg font-semibold text-fg">{STOP_RECORDING_TITLE}</h2>
        <div className="mt-5 flex flex-col gap-2">
          <Button variant="primary" onClick={props.onKeep}>
            {STOP_RECORDING_KEEP}
          </Button>
          <Button variant="secondary" onClick={props.onSave}>
            {STOP_RECORDING_SAVE}
          </Button>
          <Button variant="danger" onClick={props.onDiscard}>
            {STOP_RECORDING_DISCARD}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Leave after a Back the guard held: drop the guard (its entry pops), then go
 * back once more so the Back the user pressed takes effect. When the guard's
 * entry is not on top (never placed), one back is enough.
 */
export function leaveAfterGuard(release: () => void, win: Window = window): void {
  const guarded = stepMarkerOf(win.history.state, BACK_GUARD_STEP_KEY) !== null;
  if (!guarded) {
    release();
    win.history.back();
    return;
  }
  const onPop = (): void => {
    win.removeEventListener('popstate', onPop);
    win.history.back();
  };
  win.addEventListener('popstate', onPop);
  release();
}
