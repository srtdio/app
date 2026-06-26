// A compact in-bubble voice-note player: a hidden <audio> element driven by a
// ref, a 44px play/pause control, a decorative waveform with an accent progress
// fill, a mono mm:ss label, and the Whisper transcript beneath. Pure
// presentational shell; no recording, no presign logic (the url is handed in,
// null while the presign is still in flight).

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { IconPlay } from '@/components/ui/icons';

/** Fixed decorative bar heights (percent of the track) for the waveform. */
const WAVEFORM_BARS = [
  35, 60, 45, 80, 55, 70, 40, 90, 50, 65, 30, 75, 48, 85, 42, 68, 38, 72, 52, 58,
];

/** Format a non-negative second count as mm:ss; 0 for non-finite input. */
function formatMmSs(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const mm = Math.floor(safe / 60);
  const ss = safe % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function VoiceNote({
  url,
  name,
  transcript,
}: {
  url: string | null;
  name: string;
  transcript: string | undefined;
}): ReactElement {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio === null) return;
    const onLoaded = (): void => setTotal(Number.isFinite(audio.duration) ? audio.duration : 0);
    const onTime = (): void => setCurrent(audio.currentTime);
    const onEnded = (): void => {
      setPlaying(false);
      setCurrent(0);
    };
    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended', onEnded);
    };
  }, []);

  const toggle = (): void => {
    const audio = audioRef.current;
    if (audio === null) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      void audio.play();
      setPlaying(true);
    }
  };

  const disabled = url === null;
  const progress = total > 0 ? (current / total) * 100 : 0;
  const label = playing || current > 0 ? formatMmSs(current) : formatMmSs(total);
  const hasTranscript = transcript !== undefined && transcript.trim() !== '';

  return (
    <div className="flex max-w-[300px] flex-col gap-2 rounded-lg border border-border bg-panel-2 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <audio ref={audioRef} src={url ?? undefined} preload="metadata" className="hidden" />
        <button
          type="button"
          onClick={toggle}
          disabled={disabled}
          aria-label={playing ? 'Pause voice note' : 'Play voice note'}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {playing ? (
            <span aria-hidden="true" className="flex gap-1">
              <span className="block h-3.5 w-1 rounded-sm bg-accent-fg" />
              <span className="block h-3.5 w-1 rounded-sm bg-accent-fg" />
            </span>
          ) : (
            <IconPlay size={18} />
          )}
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="relative h-6 w-full" aria-hidden="true">
            <div className="flex h-full w-full items-center gap-0.5">
              {WAVEFORM_BARS.map((height, index) => (
                <span
                  key={index}
                  className="flex-1 rounded-sm bg-fg-3/40"
                  style={{ height: `${height}%` }}
                />
              ))}
            </div>
            {/* Played-so-far fill: a translucent accent overlay whose width tracks
                progress, so the bars beneath stay aligned. Width-only, no translate. */}
            <div
              className="absolute inset-y-0 left-0 rounded-sm bg-accent/30"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="font-mono text-[11px] tabular-nums text-fg-3" title={name}>
            {label}
          </span>
        </div>
      </div>
      {hasTranscript ? (
        <div className="flex flex-col gap-0.5 border-t border-border pt-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-fg-3">
            Transcript
          </span>
          <p className="whitespace-pre-wrap break-words text-xs text-fg-2">{transcript}</p>
        </div>
      ) : null}
    </div>
  );
}
