// A catch-up card's reply box: the app's one writing box (ui/WritingBox) with
// the real composer behaviour, never a catch-up-only composer.
//
//   At rest: the pill (restPill, every layout): + on the left, the card's hint
//   ("Reply in thread", "Message <chat>", "Reply") centred, the mic on the
//   right on chat cards while the box holds nothing.
//   Open (focused, text, a file or a kept note): the card, then the key row
//   + Aa emoji @ ... mic (chat) send, exactly as WritingBox draws its modes.
//
// + : the comment composers' tray (Photos, File, Assets: COMMENT_TRAY_TILES)
// on every card. Picked files upload at once through the shared upload flow
// (comments/CommentComposer useCommentUploads): chat cards through the chat
// upload ('chat' files), comment cards through the comment one ('library'
// files), exactly as chat and CommentComposer do. Chips (ui/PendingChip with
// ui/UploadRing) wait inside the open box; Send waits for no upload (it is
// disabled while one runs) and hands the finished version ids over.
//
// @ : chat's MentionPicker above the box; a pick becomes the @[uuid] token in
// the body (lib/chat/mentions serializeMentions, plus linkTypedUsernames for a
// typed @username), the encoding every chat message and comment uses. People:
// `mentionMembers` when the screen has the chat's members, else the
// workspace's members (read once the box is first focused, never on paint).
//
// Voice (chat cards): the mic records (lib/chat useAudioRecorder); the pill
// shows chat/VoiceDraft RecordingRow (X cancel | live track | m:ss | check).
// The check stops and keeps: the note is typed and named from its bytes
// (prepareVoiceNote, chat's own path), uploaded at once through the chat
// upload, and waits in the open box as chat/VoiceDraft VoiceNoteChip; Send
// hands { assetId, durationMs }. System Back while recording asks Keep
// recording / Save as draft / Discard (chat's StopRecordingDialog); Save as
// draft and leaving mid-recording keep the note as the chat's voice draft,
// so the chat's own composer shows it.
//
// Send never advances the queue (several messages are fine); the screen does
// the optimistic write and its Not sent / Retry; the box clears itself.
// Focus and blur are reported so the screen can switch to its typing state
// (focus moving inside the box keeps it). Keys: the chat send rule
// (src/lib/chat/send-key.ts). Typing controls appear instantly (no motion).

import { Suspense, useCallback, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement, Ref, SyntheticEvent } from 'react';
import { RowKey, RowSend, WritingBox } from '@/components/ui/WritingBox';
import { ICON_SIZE, IconMic, IconSend } from '@/components/ui/icons';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/toast';
import { ComposerTray, type TrayTileId } from '@/components/chat/ComposerTray';
import { ComposerStrip } from '@/components/chat/ComposerStrip';
import { MentionPicker, mentionComboboxProps, stepActive } from '@/components/chat/MentionPicker';
import { useChatLayout } from '@/components/chat/chat-type';
import {
  RecordingRow,
  StopRecordingDialog,
  VoiceNoteChipPlayer,
  leaveAfterGuard,
  prepareVoiceNote,
  useRecordingBars,
  type VoiceChipUpload,
} from '@/components/chat/VoiceDraft';
import {
  COMMENT_TRAY_TILES,
  FileUploadChip,
  LazyAssetPicker,
  LibraryPickChip,
  libraryChipKey,
  useCommentUploads,
  warmAssetPicker,
} from '@/components/comments/CommentComposer';
import { isSendKeydown } from '@/lib/chat/send-key';
import { useAudioRecorder } from '@/lib/chat/use-audio-recorder';
import { useChatAttachments, useCommentAttachments } from '@/lib/chat/use-chat-attachments';
import { saveVoiceDraft } from '@/lib/chat/voice-draft';
import {
  addPick,
  insertMention,
  linkTypedUsernames,
  mentionHandle,
  mentionPickerRows,
  mentionQuery,
  rememberMentionNames,
  serializeMentions,
  type MentionMember,
  type MentionPick,
} from '@/lib/chat/mentions';
import { useBackGuard } from '@/lib/back-guard';
import { IMAGE_ACCEPT } from '@/lib/chat/attachments';
import { UPLOAD_ACCEPT } from '@/lib/asset-upload';
import { useMentionCandidates, type MentionCandidate } from '@/lib/workspace-members';
import { useSession } from '@/lib/session-context';
import { clockLength } from '@/lib/catch-up/text';
import { errorText } from '@/lib/error-copy';
import { logger } from '@/lib/logger';
import type { CatchUpReplyTarget, CatchUpSend } from '@/lib/catch-up/types';

export interface CatchUpReplyProps {
  /** Placeholder: 'Reply in thread' | 'Message <chat>' | 'Reply'. */
  hint: string;
  /** Chat cards: chat composer behaviour (mic, voice notes); comment cards: comment composer behaviour. */
  mode: 'chat' | 'comment';
  laptop: boolean;
  workspaceId: string;
  target: CatchUpReplyTarget;
  /** The screen does the optimistic write + Not sent / Retry; the box clears itself. */
  onSend: (send: CatchUpSend) => void;
  onFocusChange: (focused: boolean) => void;
  inputRef?: Ref<HTMLTextAreaElement>;
  /**
   * The chat's members for @ (chat cards), when the screen has them; the
   * server refuses a mention of someone outside the chat. Absent: the
   * workspace's members.
   */
  mentionMembers?: readonly MentionMember[] | undefined;
}

/** The catch-up + tray: the comment composers' tiles on every card. */
export const CATCH_UP_TRAY_TILES: readonly TrayTileId[] = COMMENT_TRAY_TILES;

/** The toast when a recording is under MIN_VOICE_NOTE_MS (the chat composer's words). */
export const CATCH_UP_VOICE_TOO_SHORT = 'Voice note too short';

/** The toast when the microphone is refused (the chat composer's words). */
export const CATCH_UP_MIC_REFUSED = 'Microphone access is needed to record.';

/** A workspace member as the @ picker's row. Pure. */
export function candidateMember(candidate: MentionCandidate): MentionMember {
  return {
    userId: candidate.id,
    displayName: candidate.name,
    avatarUrl: candidate.avatarUrl,
    username: candidate.username,
    role: candidate.role,
  };
}

/** The body a send stores: picks become @[uuid] tokens, so does a typed @username of a member. Pure. */
export function catchUpBody(
  text: string,
  picks: readonly MentionPick[],
  members: readonly MentionMember[],
): string {
  return linkTypedUsernames(serializeMentions(text, picks), members).trim();
}

/** The @ list's keys: Up / Down step, Enter / Tab pick, Escape closes. Pure. */
export function mentionKey(
  key: string,
  composing: boolean,
): 'up' | 'down' | 'pick' | 'close' | null {
  if (composing) return null;
  if (key === 'ArrowUp') return 'up';
  if (key === 'ArrowDown') return 'down';
  if (key === 'Enter' || key === 'Tab') return 'pick';
  if (key === 'Escape') return 'close';
  return null;
}

/** A kept voice note in the box: its recording, and its upload. */
interface KeptVoice {
  blob: Blob;
  durationMs: number;
  peaks: number[] | undefined;
  file: File;
  status:
    | { state: 'uploading'; progress: number | null }
    | { state: 'done'; assetId: string }
    | { state: 'failed' };
  abort: AbortController;
}

/** What Send hands over, or null when nothing can go yet. Pure. */
export function catchUpSendOf(input: {
  body: string;
  ids: readonly string[];
  uploading: boolean;
  voice: {
    state: 'uploading' | 'done' | 'failed';
    assetId?: string;
    durationMs: number;
    file?: File;
    peaks?: number[] | undefined;
  } | null;
}): CatchUpSend | null {
  if (input.uploading) return null;
  if (input.voice !== null && input.voice.state !== 'done') return null;
  const voice =
    input.voice !== null && input.voice.assetId !== undefined
      ? {
          assetId: input.voice.assetId,
          durationMs: input.voice.durationMs,
          ...(input.voice.file !== undefined
            ? { mime: input.voice.file.type, name: input.voice.file.name, size: input.voice.file.size }
            : {}),
          ...(input.voice.peaks !== undefined ? { peaks: [...input.voice.peaks] } : {}),
        }
      : null;
  if (input.body === '' && input.ids.length === 0 && voice === null) return null;
  return { text: input.body, attachmentAssetIds: [...input.ids], voice };
}

export function CatchUpReply(props: CatchUpReplyProps): ReactElement {
  const chat = props.mode === 'chat';
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [picks, setPicks] = useState<MentionPick[]>([]);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [mentionActive, setMentionActive] = useState(0);
  // The workspace's people are read once the box is first focused (a tap,
  // never paint); the shared members cache answers when it is warm.
  const [wantsPeople, setWantsPeople] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const toast = useToast();
  const layout = useChatLayout();
  const trayId = useId();
  const listId = useId();
  const { session } = useSession();
  const selfId = session?.user.id ?? '';

  // Uploads: chat cards keep chat files in their chat; comment cards upload
  // workspace library files (as CommentComposer and the Plan item thread do).
  const chatFiles = useChatAttachments();
  const commentFiles = useCommentAttachments();
  const files = props.target.kind === 'chat' ? chatFiles : commentFiles;
  const uploads = useCommentUploads(files.canAttach ? files.uploadFile : undefined);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [assetsMounted, setAssetsMounted] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);

  // @ people.
  const workspacePeople = useMentionCandidates(wantsPeople ? props.workspaceId : null);
  const members = useMemo<readonly MentionMember[]>(
    () =>
      chat && props.mentionMembers !== undefined
        ? props.mentionMembers
        : workspacePeople.candidates.map(candidateMember),
    [chat, props.mentionMembers, workspacePeople.candidates],
  );
  const openMention = mentionDismissed ? null : mentionQuery(text, caret);
  const mentionRows =
    openMention !== null ? mentionPickerRows(members, openMention.query, selfId, false) : [];
  const activeRow = Math.min(mentionActive, Math.max(mentionRows.length - 1, 0));

  // Voice (chat cards).
  const channelId = props.target.kind === 'chat' ? props.target.channelId : undefined;
  const recorder = useAudioRecorder({
    // Leaving mid-recording keeps it as the chat's voice draft (as chat does).
    onUnmountRecording: (rec) => {
      saveVoiceDraft(channelId, rec);
    },
  });
  const bars = useRecordingBars(recorder.recording, recorder.seconds);
  const [stopping, setStopping] = useState(false);
  const [voice, setVoice] = useState<KeptVoice | null>(null);
  const [stopAsk, setStopAsk] = useState(false);
  const recordGuard = useBackGuard({
    active: recorder.recording,
    onBack: () => setStopAsk(true),
  });

  const setRefs = useCallback(
    (el: HTMLTextAreaElement | null): void => {
      ref.current = el;
      const outer = props.inputRef;
      if (typeof outer === 'function') outer(el);
      else if (outer !== undefined && outer !== null) {
        (outer as { current: HTMLTextAreaElement | null }).current = el;
      }
    },
    [props.inputRef],
  );

  const body = catchUpBody(text, picks, members);
  const pending: CatchUpSend | null = catchUpSendOf({
    body,
    ids: uploads.ids,
    uploading: uploads.uploading,
    voice:
      voice === null
        ? null
        : {
            state: voice.status.state,
            durationMs: voice.durationMs,
            file: voice.file,
            peaks: voice.peaks,
            ...(voice.status.state === 'done' ? { assetId: voice.status.assetId } : {}),
          },
  });

  function send(): void {
    if (pending === null || recorder.recording) return;
    setText('');
    setCaret(0);
    setPicks([]);
    setMentionActive(0);
    uploads.clear();
    setVoice(null);
    props.onSend(pending);
  }

  function trackCaret(event: SyntheticEvent<HTMLTextAreaElement>): void {
    const el = event.currentTarget;
    const next = el.selectionStart ?? el.value.length;
    setCaret(next);
    if (mentionQuery(el.value, next) === null) setMentionDismissed(false);
  }

  // A pick swaps the "@query" run for "@username " and keeps the mention.
  function pickMention(member: MentionMember | undefined): void {
    if (member === undefined) return;
    const handle = mentionHandle(member);
    const next = insertMention(text, caret, handle);
    rememberMentionNames(props.workspaceId, [member]);
    setPicks((prev) => addPick(prev, { userId: member.userId, name: handle }));
    setText(next.text);
    setCaret(next.caret);
    setMentionActive(0);
    const el = ref.current;
    if (el !== null) {
      requestAnimationFrame(() => {
        // Typed since the pick: the caret is already theirs.
        if (el.value !== next.text) return;
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
      });
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    const action =
      mentionRows.length > 0 ? mentionKey(event.key, event.nativeEvent.isComposing) : null;
    if (action !== null) {
      event.preventDefault();
      if (action === 'close') setMentionDismissed(true);
      else if (action === 'pick') pickMention(mentionRows[activeRow] ?? mentionRows[0]);
      else
        setMentionActive(
          stepActive(activeRow, mentionRows.length, action === 'up' ? 'ArrowUp' : 'ArrowDown'),
        );
      return;
    }
    if (
      isSendKeydown({
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing,
        coarsePointer: !props.laptop,
      })
    ) {
      event.preventDefault();
      send();
    }
  }

  // + tiles: Photos / File open their pickers, Assets the library picker.
  function pickTile(id: TrayTileId): void {
    if (id === 'photos') photoInputRef.current?.click();
    else if (id === 'file') fileInputRef.current?.click();
    else if (id === 'assets') {
      setAssetsMounted(true);
      setAssetsOpen(true);
    }
  }

  // Upload a kept note through the chat upload (chat's voice-note path).
  function uploadVoice(kept: KeptVoice): void {
    void files
      .uploadFile(
        kept.file,
        (fraction) =>
          setVoice((prev) =>
            prev === null || prev.abort !== kept.abort || prev.status.state !== 'uploading'
              ? prev
              : { ...prev, status: { state: 'uploading', progress: fraction } },
          ),
        kept.abort.signal,
      )
      .then((outcome) => {
        setVoice((prev) => {
          if (prev === null || prev.abort !== kept.abort) return prev;
          return {
            ...prev,
            status: outcome.ok
              ? { state: 'done', assetId: outcome.versionId }
              : { state: 'failed' },
          };
        });
      });
  }

  async function startRecording(): Promise<void> {
    const ok = await recorder.start();
    if (!ok) toast.show({ title: CATCH_UP_MIC_REFUSED });
  }

  // The check: stop and keep. The note waits in the box and uploads at once.
  async function stopKeep(): Promise<void> {
    if (stopping) return;
    setStopping(true);
    try {
      const note = await prepareVoiceNote(await recorder.stop());
      if (note === null) {
        toast.show({ title: CATCH_UP_VOICE_TOO_SHORT });
        return;
      }
      voice?.abort.abort();
      const kept: KeptVoice = {
        blob: note.file,
        durationMs: note.durationMs,
        peaks: note.peaks,
        file: note.file,
        status: { state: 'uploading', progress: null },
        abort: new AbortController(),
      };
      setVoice(kept);
      uploadVoice(kept);
    } catch (error) {
      logger.error('catch-up reply: voice note stop failed', { error: String(error) });
      toast.show({ title: errorText('keep the voice note', error) });
    } finally {
      setStopping(false);
    }
  }

  function removeVoice(): void {
    voice?.abort.abort();
    setVoice(null);
  }

  function retryVoice(): void {
    if (voice === null) return;
    const kept: KeptVoice = {
      ...voice,
      status: { state: 'uploading', progress: null },
      abort: new AbortController(),
    };
    setVoice(kept);
    uploadVoice(kept);
  }

  // Back while recording, "Save as draft": the chat's voice draft, then leave.
  async function saveRecordingAsDraft(): Promise<void> {
    setStopAsk(false);
    const rec = await recorder.stop();
    if (!saveVoiceDraft(channelId, rec)) toast.show({ title: CATCH_UP_VOICE_TOO_SHORT });
    leaveAfterGuard(recordGuard.release);
  }

  // Back while recording, "Discard": the recording goes, then leave.
  function discardRecordingAndLeave(): void {
    setStopAsk(false);
    leaveAfterGuard(recordGuard.release);
    recorder.cancel();
  }

  const voiceUpload: VoiceChipUpload | undefined =
    voice === null || voice.status.state === 'done'
      ? undefined
      : voice.status.state === 'uploading'
        ? { state: 'uploading', progress: voice.status.progress }
        : { state: 'failed', onRetry: retryVoice };

  const hasChips = uploads.chipCount > 0 || voice !== null;
  const attachments = hasChips ? (
    <>
      {voice !== null ? (
        <VoiceNoteChipPlayer
          blob={voice.blob}
          durationMs={voice.durationMs}
          peaks={voice.peaks}
          onRemove={removeVoice}
          upload={voiceUpload}
          dataAttrs={{ 'data-catch-up-voice-chip': '' }}
        />
      ) : null}
      {uploads.chipCount > 0 ? (
        <ul className="flex min-w-0 flex-wrap gap-2">
          {uploads.pending.map((item) => (
            <FileUploadChip
              key={item.id}
              item={item}
              onRemove={() => uploads.removePending(item.id)}
              onRetry={() => uploads.retryPending(item.id)}
            />
          ))}
          {uploads.library.map((asset) => (
            <LibraryPickChip
              key={libraryChipKey(asset)}
              asset={asset}
              onRemove={() => uploads.removeLibrary(asset.versionId)}
            />
          ))}
        </ul>
      ) : null}
    </>
  ) : undefined;

  // The mic: chat cards, while the box holds nothing (no text, no kept note).
  const micShown = chat && files.canAttach && text === '' && voice === null && !stopping;
  const mic = micShown ? (
    <span data-catch-up-mic="" className="contents">
      <RowKey label="Record voice note" onPress={() => void startRecording()}>
        <IconMic size={ICON_SIZE.control} />
      </RowKey>
    </span>
  ) : undefined;

  const somethingToSend = text.trim() !== '' || hasChips;

  return (
    <form
      data-catch-up-reply=""
      data-mode={props.mode}
      className="shrink-0 px-4 pb-3"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
      onFocus={() => {
        setWantsPeople(true);
        props.onFocusChange(true);
      }}
      onBlur={(event) => {
        // Focus moving inside the box (Aa, emoji, @, a chip, Send) keeps the typing state.
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        props.onFocusChange(false);
      }}
    >
      <WritingBox
        mode={props.mode}
        laptop={props.laptop}
        restPill
        field={() => ref.current}
        hasText={text !== ''}
        mention
        expandTitle={props.hint}
        attachments={attachments}
        overlay={
          <ComposerStrip
            open={mentionRows.length > 0}
            data-mention-anchor=""
            className="absolute inset-x-0 bottom-full z-sticky mb-2"
          >
            <MentionPicker
              members={mentionRows}
              active={activeRow}
              onPick={pickMention}
              listId={listId}
            />
          </ComposerStrip>
        }
        state={
          recorder.recording
            ? { kind: 'recording', elapsed: clockLength(recorder.seconds) }
            : { kind: 'idle' }
        }
        recording={
          <RecordingRow
            elapsed={clockLength(recorder.seconds)}
            bars={bars}
            busy={stopping}
            onCancel={() => recorder.cancel()}
            onKeep={() => void stopKeep()}
            dataAttrs={{ 'data-catch-up-recording': '' }}
          />
        }
        leading={
          files.canAttach ? (
            <ComposerTray
              compact
              layout={layout}
              only={{ tiles: CATCH_UP_TRAY_TILES, trayId }}
              onShownChange={warmAssetPicker}
              onPick={pickTile}
            />
          ) : undefined
        }
        mic={mic}
        input={
          <Textarea
            ref={setRefs}
            formatting
            compact
            listEnter={false}
            data-catch-up-reply-input=""
            autoComplete="off"
            rows={1}
            value={text}
            placeholder={props.hint}
            aria-label={props.hint}
            {...mentionComboboxProps(listId, mentionRows.length, activeRow)}
            onChange={(event) => {
              setText(event.target.value);
              setMentionActive(0);
              trackCaret(event);
            }}
            onSelect={trackCaret}
            onKeyDown={onKeyDown}
            className="min-w-0 flex-1 self-center"
          />
        }
        send={
          somethingToSend ? (
            <RowSend
              type="submit"
              label="Send"
              disabled={pending === null}
              icon={<IconSend size={ICON_SIZE.control} />}
              onPointerDown={(event) => event.preventDefault()}
            />
          ) : undefined
        }
      />

      {stopAsk && recorder.recording ? (
        <StopRecordingDialog
          onKeep={() => setStopAsk(false)}
          onSave={() => void saveRecordingAsDraft()}
          onDiscard={discardRecordingAndLeave}
        />
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        className="sr-only"
        onChange={(event) => {
          void uploads.addFiles(event.target.files);
          event.target.value = '';
        }}
      />
      <input
        ref={photoInputRef}
        type="file"
        multiple
        accept={IMAGE_ACCEPT}
        className="sr-only"
        onChange={(event) => {
          void uploads.addFiles(event.target.files, true);
          event.target.value = '';
        }}
      />

      {assetsMounted ? (
        <Suspense fallback={null}>
          <LazyAssetPicker
            open={assetsOpen}
            onClose={() => setAssetsOpen(false)}
            onConfirm={uploads.addLibrary}
          />
        </Suspense>
      ) : null}
    </form>
  );
}
