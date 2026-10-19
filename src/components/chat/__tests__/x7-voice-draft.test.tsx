// @vitest-environment jsdom
// X7 fix 7a-7e (FT42): a voice note still recording when the composer goes
// away becomes a recoverable per-chat draft (Send / Delete above the
// composer), too-short recordings are dropped, system Back while recording
// asks Keep recording / Save as draft / Discard, and a failing IndexedDB still
// keeps the in-memory draft for the session.
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { act, useState, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  STOP_RECORDING_DISCARD,
  STOP_RECORDING_KEEP,
  STOP_RECORDING_SAVE,
  StopRecordingDialog,
  VoiceDraftBar,
  voiceDraftView,
} from '@/components/chat/VoiceDraft';
import { useBackGuard } from '@/lib/back-guard';
import type { OutboxFileAdapter, StoredOutboxFile } from '@/lib/chat/outbox-files';
import { resetHistorySteps } from '@/lib/chat/use-history-step';
import {
  MIN_VOICE_NOTE_MS,
  useAudioRecorder,
  type AudioRecorder,
  type RecordingResult,
} from '@/lib/chat/use-audio-recorder';
import {
  deleteVoiceDraft,
  dropSnapshotOf,
  getVoiceDraft,
  isVoiceDraftEntryId,
  resetVoiceDrafts,
  restoreVoiceDraft,
  saveVoiceDraft,
  setVoiceDraftFiles,
  useVoiceDraft,
  voiceDraftEntryId,
  voiceDraftLabel,
} from '@/lib/chat/voice-draft';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => act(async () => wait(60));
const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

function rec(durationMs: number): RecordingResult {
  return {
    blob: new Blob(['voice-bytes'], { type: 'audio/webm' }),
    mime: 'audio/webm',
    recorderMime: 'audio/webm;codecs=opus',
    durationMs,
  };
}

/** An in-memory file store (or one whose every call fails). */
function memoryFiles(fail = false): OutboxFileAdapter & { data: Map<string, StoredOutboxFile> } {
  const data = new Map<string, StoredOutboxFile>();
  const guard = async <T,>(run: () => T): Promise<T> => {
    if (fail) throw new Error('IndexedDB blocked');
    return run();
  };
  return {
    data,
    put: (key, value) => guard(() => void data.set(key, value)),
    get: (key) => guard(() => data.get(key)),
    keys: () => guard(() => [...data.keys()]),
    delete: (keys) => guard(() => void keys.forEach((k) => data.delete(k))),
    clear: () => guard(() => data.clear()),
    close: () => {},
  };
}

// A MediaRecorder stand-in: stop() delivers one last chunk, then 'stop'.
class FakeRecorder extends EventTarget {
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm';
  static isTypeSupported(): boolean {
    return true;
  }
  start(): void {
    this.state = 'recording';
  }
  private chunk(): void {
    const event = new Event('dataavailable');
    Object.defineProperty(event, 'data', { value: new Blob(['chunk'], { type: 'audio/webm' }) });
    this.dispatchEvent(event);
  }
  requestData(): void {
    queueMicrotask(() => this.chunk());
  }
  stop(): void {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.chunk();
      this.dispatchEvent(new Event('stop'));
    });
  }
}

let root: Root | null = null;
let now = 0;
const trackStop = vi.fn();

function mount(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

/** The composer's recorder wiring (Composer.tsx), alone. */
function RecorderProbe(props: { channelId: string; onRecorder: (r: AudioRecorder) => void }) {
  const recorder = useAudioRecorder({
    onUnmountRecording: (r) => {
      saveVoiceDraft(props.channelId, r);
    },
    onBackground: (r, id) => {
      saveVoiceDraft(props.channelId, r, id);
    },
  });
  props.onRecorder(recorder);
  return <span data-recording={String(recorder.recording)} />;
}

/** The composer's draft row for a chat (Composer.tsx), alone. */
function DraftProbe(props: { channelId: string }) {
  const draft = useVoiceDraft(props.channelId);
  return draft !== null ? (
    <VoiceDraftBar draft={draft} busy={false} onSend={() => {}} onDelete={() => {}} />
  ) : (
    <span data-no-draft="" />
  );
}

beforeEach(() => {
  resetVoiceDrafts();
  setVoiceDraftFiles(memoryFiles());
  resetHistorySteps();
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  Object.defineProperty(globalThis, 'MediaRecorder', {
    configurable: true,
    writable: true,
    value: FakeRecorder,
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] })),
    },
  });
});

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  await settle();
  resetHistorySteps();
  vi.restoreAllMocks();
});

describe('X7 FT42: the voice draft store', () => {
  it('keeps one draft per chat; a too-short recording is dropped', () => {
    expect(saveVoiceDraft('c1', rec(MIN_VOICE_NOTE_MS - 1))).toBe(false);
    expect(getVoiceDraft('c1')).toBeNull();
    expect(saveVoiceDraft('c1', rec(7_000))).toBe(true);
    expect(getVoiceDraft('c1')?.durationMs).toBe(7_000);
    expect(saveVoiceDraft('c1', rec(9_000))).toBe(true);
    expect(getVoiceDraft('c1')?.durationMs).toBe(9_000);
    expect(getVoiceDraft('c2')).toBeNull();
    deleteVoiceDraft('c1');
    expect(getVoiceDraft('c1')).toBeNull();
    expect(voiceDraftLabel(7_000)).toBe('Voice note 0:07');
    expect(voiceDraftLabel(65_000)).toBe('Voice note 1:05');
  });

  it('a page-hide snapshot is dropped when its own recording ends; a real draft is not', () => {
    saveVoiceDraft('c1', rec(3_000), 'rec-1');
    dropSnapshotOf('c1', 'rec-2');
    expect(getVoiceDraft('c1')).not.toBeNull();
    dropSnapshotOf('c1', 'rec-1');
    expect(getVoiceDraft('c1')).toBeNull();
  });

  it('storage failure still keeps the in-memory draft for the session', async () => {
    setVoiceDraftFiles(memoryFiles(true));
    expect(saveVoiceDraft('c1', rec(4_000))).toBe(true);
    await wait(10);
    expect(getVoiceDraft('c1')?.durationMs).toBe(4_000);
    // Restoring from a failing store never throws and never drops it.
    await expect(restoreVoiceDraft('c1')).resolves.toBeUndefined();
    expect(getVoiceDraft('c1')).not.toBeNull();
  });

  it('the IndexedDB copy brings the draft back after a reload; the boot prune keeps it', async () => {
    const files = memoryFiles();
    setVoiceDraftFiles(files);
    saveVoiceDraft('c1', rec(5_000));
    await wait(10);
    expect([...files.data.keys()]).toEqual([`${voiceDraftEntryId('c1')}:0`]);
    expect(isVoiceDraftEntryId(voiceDraftEntryId('c1'))).toBe(true);
    // A reload: memory is gone, the store is not.
    resetVoiceDrafts();
    setVoiceDraftFiles(files);
    expect(getVoiceDraft('c1')).toBeNull();
    await restoreVoiceDraft('c1');
    expect(getVoiceDraft('c1')?.durationMs).toBe(5_000);
    expect(source('../ChatStoreProvider.tsx')).toContain('isVoiceDraftEntryId(id)');
  });
});

describe('X7 FT42: leaving the chat mid-recording', () => {
  it('unmounting the composer mid-recording saves a voice draft and returning to the chat shows Send/Delete', async () => {
    const box: { current: AudioRecorder | null } = { current: null };
    mount(<RecorderProbe channelId="c1" onRecorder={(r) => (box.current = r)} />);
    await act(async () => {
      await box.current?.start();
    });
    now = 6_000;
    // Leave the chat (Back, a chat switch, a tab change): the composer unmounts.
    act(() => root?.unmount());
    root = null;
    await settle();
    const draft = getVoiceDraft('c1');
    expect(draft).not.toBeNull();
    expect(draft?.durationMs).toBe(6_000);
    expect(draft?.blob.size).toBeGreaterThan(0);
    expect(trackStop).toHaveBeenCalled();

    // Coming back to that chat: the draft above the composer.
    const host = mount(<DraftProbe channelId="c1" />);
    expect(host.textContent).toContain('Voice note 0:06');
    expect(document.querySelector('[data-voice-draft-send]')).not.toBeNull();
    expect(document.querySelector('[data-voice-draft-delete]')).not.toBeNull();
    expect(document.querySelector('[data-voice-draft-play]')).not.toBeNull();
  });

  it('a too-short recording is dropped on unmount', async () => {
    const box: { current: AudioRecorder | null } = { current: null };
    mount(<RecorderProbe channelId="c1" onRecorder={(r) => (box.current = r)} />);
    await act(async () => {
      await box.current?.start();
    });
    now = MIN_VOICE_NOTE_MS - 200;
    act(() => root?.unmount());
    root = null;
    await settle();
    expect(getVoiceDraft('c1')).toBeNull();
    expect(trackStop).toHaveBeenCalled();
  });

  it('the page hiding mid-recording keeps a snapshot draft and keeps recording', async () => {
    const box: { current: AudioRecorder | null } = { current: null };
    const host = mount(<RecorderProbe channelId="c1" onRecorder={(r) => (box.current = r)} />);
    await act(async () => {
      await box.current?.start();
    });
    now = 3_000;
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await wait(10);
    });
    expect(getVoiceDraft('c1')?.recordingId).toBe(box.current?.recordingId);
    expect(host.querySelector('[data-recording="true"]')).not.toBeNull();
  });

  it('the composer wires the same paths and shows the draft row', () => {
    const composer = source('../Composer.tsx');
    expect(composer).toContain(
      'onUnmountRecording: (rec) => {\n      saveVoiceDraft(channelId, rec);',
    );
    expect(composer).toContain('<VoiceDraftBar');
    expect(composer).toContain('void restoreVoiceDraft(channelId);');
    expect(composer).toContain("setDraftAsk('replace')");
  });
});

describe('X7 FT42: the draft row', () => {
  it('Play, Send and Delete are 44px; tokens only', () => {
    const html = renderToStaticMarkup(
      voiceDraftView({
        durationMs: 7_000,
        playing: false,
        busy: false,
        onPlay: () => {},
        onSend: () => {},
        onDelete: () => {},
      }),
    );
    expect(html).toContain('Voice note 0:07');
    expect(html.match(/h-11 w-11/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Send voice note"');
    expect(html).toContain('aria-label="Delete voice note"');
    expect(html).toContain('aria-label="Play voice note"');
    expect(html).not.toMatch(/#[0-9a-f]{6}\b|rgb\(/i);
  });
});

/** The composer's Back guard while recording (Composer.tsx), alone. */
function BackProbe(props: { onSave: () => void; onDiscard: () => void }) {
  const [recording, setRecording] = useState(true);
  const [ask, setAsk] = useState(false);
  useBackGuard({ active: recording, onBack: () => setAsk(true) });
  return ask && recording ? (
    <StopRecordingDialog
      onKeep={() => setAsk(false)}
      onSave={() => {
        props.onSave();
        setRecording(false);
      }}
      onDiscard={() => {
        props.onDiscard();
        setRecording(false);
      }}
    />
  ) : (
    <span data-asking="no" />
  );
}

describe('X7 FT42: system Back while recording', () => {
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === label,
    );

  it('system Back during a recording asks with Keep recording / Save as draft / Discard', async () => {
    const onSave = vi.fn();
    mount(<BackProbe onSave={onSave} onDiscard={vi.fn()} />);
    await settle();
    await act(async () => {
      window.history.back();
      await wait(60);
    });
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('Stop recording?');
    expect(button(STOP_RECORDING_KEEP)).toBeDefined();
    expect(button(STOP_RECORDING_SAVE)).toBeDefined();
    expect(button(STOP_RECORDING_DISCARD)).toBeDefined();
    // Focus moved into the dialog.
    expect(dialog?.contains(document.activeElement)).toBe(true);

    await act(async () => button(STOP_RECORDING_KEEP)?.click());
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    // Still guarded: Back asks again; Save as draft runs the save path.
    await act(async () => {
      window.history.back();
      await wait(60);
    });
    await act(async () => button(STOP_RECORDING_SAVE)?.click());
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('the composer asks through X1 useBackGuard while recording', () => {
    const composer = source('../Composer.tsx');
    expect(composer).toMatch(/useBackGuard\(\{\s*active: recorder\.recording,/);
    expect(composer).toContain('<StopRecordingDialog');
    expect(composer).toContain('leaveAfterGuard(recordGuard.release)');
  });
});
