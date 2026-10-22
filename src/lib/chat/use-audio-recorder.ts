// Microphone capture for the chat composer. The recorder, stream, and chunk
// buffer live in refs (never re-render on each chunk); a useEffect cleanup
// guarantees the stream's tracks and the seconds interval are torn down on
// unmount, so no microphone light or timer is ever left running. The three
// helpers below are pure and form the unit-tested surface; the hook wires them
// to the MediaRecorder lifecycle.
//
// MediaRecorder gets the microphone stream untouched: no Web Audio graph,
// stream source or analyser is attached while it records, because on WebKit
// that changes the recorder's output. The waveform is read from the finished
// blob instead (voice-peaks.ts).
//
// A recording that is still running when the composer unmounts (Back, a chat
// switch, a tab change, sign-out) is not dropped (FT42): the recorder is
// stopped, the chunks it delivers are built into a RecordingResult and handed
// to `onUnmountRecording` (the composer keeps it as a voice draft). While
// recording, a pagehide or a visibilitychange to hidden asks the recorder for
// its data so far and hands that snapshot to `onBackground`; it keeps
// recording. Both are best effort: MediaRecorder may not deliver its last
// chunks during pagehide, and the OS can end the recording on its own.

import { useCallback, useEffect, useRef, useState } from 'react';

/** The shortest voice note worth sending; anything shorter is discarded. */
export const MIN_VOICE_NOTE_MS = 1000;

/** Strip codecs/params off a MIME type: 'audio/webm;codecs=opus' -> 'audio/webm'. */
export function baseMime(mime: string): string {
  const head = mime.split(';')[0] ?? '';
  return head.trim().toLowerCase();
}

/**
 * The best container MediaRecorder supports here, '' when none is usable (or the
 * API is absent). Prefer mp4, then webm: iOS Safari records WebM/Opus with no
 * duration or cues, which plays unreliably. Passing '' lets the recorder pick
 * its own default.
 */
export function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const candidate of ['audio/mp4', 'audio/webm']) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
}

/** Map a recording's MIME to a friendly file name; unknowns fall back to .webm. */
export function recordingFileName(mime: string): string {
  switch (baseMime(mime)) {
    case 'audio/webm':
      return 'voice-note.webm';
    case 'audio/mp4':
      return 'voice-note.m4a';
    case 'audio/mpeg':
      return 'voice-note.mp3';
    default:
      return 'voice-note.webm';
  }
}

/**
 * A finished recording: the blob, its base mime ('audio/webm' when the
 * recorder named none) and the recorder's own mimeType as reported (may be
 * ''), so the sender can sniff the bytes for the truthful type. durationMs
 * is the exact time from start() to the recorder's 'stop' event.
 */
export interface RecordingResult {
  blob: Blob;
  mime: string;
  recorderMime: string;
  durationMs: number;
}

export interface AudioRecorder {
  recording: boolean;
  seconds: number;
  /** The running recording's id ('' when idle): a snapshot names it so it can be dropped later. */
  recordingId: string;
  start: () => Promise<boolean>;
  stop: () => Promise<RecordingResult | null>;
  cancel: () => void;
}

export interface AudioRecorderOptions {
  /** The composer unmounted mid-recording: the finished recording (FT42). */
  onUnmountRecording?: (rec: RecordingResult, recordingId: string) => void;
  /** The page hid mid-recording: what has been recorded so far (still recording). */
  onBackground?: (rec: RecordingResult, recordingId: string) => void;
}

/** How long a pending final chunk is waited for before the stream is let go. */
export const FINALIZE_WAIT_MS = 1500;

/** Build a result from collected chunks; null when there are none. Pure. */
export function resultFromChunks(
  chunks: readonly Blob[],
  recorderMime: string,
  durationMs: number,
): RecordingResult | null {
  if (chunks.length === 0) return null;
  const mime = baseMime(recorderMime) || 'audio/webm';
  return {
    blob: new Blob([...chunks], { type: mime }),
    mime,
    recorderMime,
    durationMs: Math.max(0, Math.round(durationMs)),
  };
}

let recordingSeq = 0;

export function useAudioRecorder(options: AudioRecorderOptions = {}): AudioRecorder {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [recordingId, setRecordingId] = useState('');
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const recordingIdRef = useRef('');

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);

  const clearTimer = useCallback((): void => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const stopTracks = useCallback((): void => {
    if (streamRef.current !== null) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return false;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    const mimeType = pickRecorderMimeType();
    const recorder =
      mimeType !== '' ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    recorder.addEventListener('dataavailable', (event: BlobEvent) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    });
    recorderRef.current = recorder;
    recorder.start();
    startedAtRef.current = performance.now();
    recordingSeq += 1;
    const id = `rec-${Date.now()}-${recordingSeq}`;
    recordingIdRef.current = id;
    setRecordingId(id);
    setRecording(true);
    setSeconds(0);
    clearTimer();
    // The live on-screen timer only; the sent length is durationMs.
    intervalRef.current = setInterval(() => setSeconds((value) => value + 1), 1000);
    return true;
  }, [clearTimer]);

  const stop = useCallback((): Promise<RecordingResult | null> => {
    // The ref, not the recording state: set and cleared in the same places,
    // and never stale inside this closure.
    const recorder = recorderRef.current;
    if (recorder === null) return Promise.resolve(null);
    return new Promise((resolve) => {
      recorder.addEventListener(
        'stop',
        () => {
          const durationMs = Math.max(0, Math.round(performance.now() - startedAtRef.current));
          const mime = baseMime(recorder.mimeType) || 'audio/webm';
          const chunks = chunksRef.current;
          stopTracks();
          clearTimer();
          setRecording(false);
          recorderRef.current = null;
          if (chunks.length === 0) {
            resolve(null);
            return;
          }
          resolve({
            blob: new Blob(chunks, { type: mime }),
            mime,
            recorderMime: recorder.mimeType,
            durationMs,
          });
        },
        { once: true },
      );
      recorder.stop();
    });
  }, [stopTracks, clearTimer]);

  const cancel = useCallback((): void => {
    const recorder = recorderRef.current;
    if (recorder === null) return;
    if (recorder.state !== 'inactive') recorder.stop();
    chunksRef.current = [];
    recorderRef.current = null;
    stopTracks();
    clearTimer();
    setRecording(false);
  }, [stopTracks, clearTimer]);

  // The page hides mid-recording: ask for the data so far and hand it on as a
  // snapshot; the recording goes on (it may end on its own if the OS stops it).
  useEffect(() => {
    if (!recording) return;
    const snapshot = (): void => {
      const recorder = recorderRef.current;
      const onBackground = optionsRef.current.onBackground;
      if (recorder === null || onBackground === undefined || recorder.state === 'inactive') return;
      const id = recordingIdRef.current;
      const hand = (): void => {
        const rec = resultFromChunks(
          chunksRef.current,
          recorder.mimeType,
          performance.now() - startedAtRef.current,
        );
        if (rec !== null) onBackground(rec, id);
      };
      try {
        recorder.addEventListener('dataavailable', hand, { once: true });
        recorder.requestData();
      } catch {
        hand();
      }
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') snapshot();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', snapshot);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', snapshot);
    };
  }, [recording]);

  useEffect(() => {
    return () => {
      clearTimer();
      const recorder = recorderRef.current;
      const onUnmount = optionsRef.current.onUnmountRecording;
      recorderRef.current = null;
      if (recorder === null || recorder.state === 'inactive' || onUnmount === undefined) {
        stopTracks();
        return;
      }
      // Finalize: stop the recorder, keep the stream until its last chunk
      // lands (or FINALIZE_WAIT_MS), then hand the recording on.
      const id = recordingIdRef.current;
      const durationMs = performance.now() - startedAtRef.current;
      const chunks = chunksRef.current;
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        stopTracks();
        const rec = resultFromChunks(chunks, recorder.mimeType, durationMs);
        if (rec !== null) onUnmount(rec, id);
      };
      recorder.addEventListener('stop', finish, { once: true });
      setTimeout(finish, FINALIZE_WAIT_MS);
      try {
        recorder.stop();
      } catch {
        finish();
      }
    };
  }, [stopTracks, clearTimer]);

  return { recording, seconds, recordingId, start, stop, cancel };
}
