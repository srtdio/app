// Microphone capture for the chat composer. The recorder, stream, and chunk
// buffer live in refs (never re-render on each chunk); a useEffect cleanup
// guarantees the stream's tracks and the seconds interval are torn down on
// unmount, so no microphone light or timer is ever left running. The three
// helpers below are pure and form the unit-tested surface; the hook wires them
// to the MediaRecorder lifecycle.

import { useCallback, useEffect, useRef, useState } from 'react';

/** Strip codecs/params off a MIME type: 'audio/webm;codecs=opus' -> 'audio/webm'. */
export function baseMime(mime: string): string {
  const head = mime.split(';')[0] ?? '';
  return head.trim().toLowerCase();
}

/**
 * The best container MediaRecorder supports here, '' when none is usable (or the
 * API is absent). Prefer webm, then mp4; passing '' lets the recorder pick its
 * own default.
 */
export function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const candidate of ['audio/webm', 'audio/mp4']) {
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

export interface AudioRecorder {
  recording: boolean;
  seconds: number;
  start: () => Promise<boolean>;
  stop: () => Promise<{ blob: Blob; mime: string } | null>;
  cancel: () => void;
}

export function useAudioRecorder(): AudioRecorder {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    setRecording(true);
    setSeconds(0);
    clearTimer();
    intervalRef.current = setInterval(() => setSeconds((value) => value + 1), 1000);
    return true;
  }, [clearTimer]);

  const stop = useCallback((): Promise<{ blob: Blob; mime: string } | null> => {
    const recorder = recorderRef.current;
    if (!recording || recorder === null) return Promise.resolve(null);
    return new Promise((resolve) => {
      recorder.addEventListener(
        'stop',
        () => {
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
          resolve({ blob: new Blob(chunks, { type: mime }), mime });
        },
        { once: true },
      );
      recorder.stop();
    });
  }, [recording, stopTracks, clearTimer]);

  const cancel = useCallback((): void => {
    if (!recording) return;
    const recorder = recorderRef.current;
    if (recorder !== null && recorder.state !== 'inactive') recorder.stop();
    chunksRef.current = [];
    recorderRef.current = null;
    stopTracks();
    clearTimer();
    setRecording(false);
  }, [recording, stopTracks, clearTimer]);

  useEffect(() => {
    return () => {
      stopTracks();
      clearTimer();
    };
  }, [stopTracks, clearTimer]);

  return { recording, seconds, start, stop, cancel };
}
