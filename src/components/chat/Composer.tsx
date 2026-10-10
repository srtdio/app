import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  FormEvent,
  KeyboardEvent,
  MutableRefObject,
  ReactElement,
  SyntheticEvent,
} from 'react';
import { logger } from '@/lib/logger';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Textarea } from '@/components/ui/Textarea';
import {
  IconBriefs,
  IconCalendarClock,
  IconChevronDown,
  IconFile,
  IconMic,
  IconPipeline,
  IconSend,
  IconTrash,
  IconX,
} from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { useLongPress } from '@/components/ui/useLongPress';
import { useChatSchedule, type ScheduleOutcome } from '@/components/chat/ScheduleContext';
import { ScheduleMenu, ScheduleSheet, schedulePreview } from '@/components/chat/ScheduleSheet';
import { ScheduledStrip, ScheduleModeStrip } from '@/components/chat/ScheduledStrip';
import {
  formatSendLabel,
  inSentence,
  SCHEDULE_FAILED_COPY,
  SCHEDULE_UPLOAD_FAILED_COPY,
  scheduleAttachmentArgs,
  scheduleWithFiles,
  type ScheduleFile,
  type ScheduledRow,
} from '@/lib/chat/scheduled';
import {
  MIN_VOICE_NOTE_MS,
  useAudioRecorder,
  type RecordingResult,
} from '@/lib/chat/use-audio-recorder';
import { readHeader, rememberRecorderMime, voiceFileType } from '@/lib/chat/audio-sniff';
import { voicePeaks } from '@/lib/chat/voice-peaks';
import { ComposerTray, draftTileEnabled } from '@/components/chat/ComposerTray';
import { planTileEnabled } from '@/components/chat/plan-card';
import { AssetPicker } from '@/components/chat/AssetPicker';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import { Thumbnail } from '@/components/media';
import { ComposerEmoji, showsEmojiButton } from '@/components/chat/ComposerEmoji';
import { insertAtCaret } from '@/lib/chat/emoji-list';
import { PostPicker } from '@/components/chat/PostPicker';
import { MentionPicker, stepActive } from '@/components/chat/MentionPicker';
import { PendingChip } from '@/components/chat/PendingChip';
import { PostRefThumb, postRefKey, type PostRefPost } from '@/components/chat/PostRefChip';
import {
  ReplyQuoteBox,
  type QuoteMedia,
  type QuoteThumbSource,
} from '@/components/chat/ReplyQuote';
import { cn } from '@/lib/cn';
import { editFailureCopy } from '@/lib/chat/record';
import { briefStatusLabel, toggleBrief, type BriefCardFields } from '@/lib/chat/briefs';
import { togglePost, type PickerMode } from '@/components/chat/post-picker';
import { libraryAttachments, type LibraryAsset } from '@/lib/chat/asset-picker';
import { useViewerSide } from '@/lib/chat/viewer-role';
import { attachmentMenuItems } from '@/lib/chat/attachment-menu';
import { caretHashQuery, stripHashToken } from '@/lib/chat/post-refs';
import { fileExtension } from '@/lib/assets';
import { precheckFile } from '@/lib/asset-upload';
import {
  canSendAttachmentMessage,
  classifyAttachment,
  precheckImage,
  toLocalAttachment,
  type AttachmentUploader,
  type MessageAttachment,
  type ReplyQuote,
} from '@/lib/chat/attachments';
import type { PostCardFields, Result } from '@srtdio/posts';
// Deep import: the package index is outside this change; the read lives beside readPostsByIds.
import { readPostIdsByNumbers } from '../../../packages/posts/src/reads';
import { readBriefIdsByNumbers } from '@/lib/chat/briefs';
import { APP_ENTITY_ROUTES, classify, currentOrigin, tokenize } from '@/lib/chat/message-links';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { clearDraft, EMPTY_DRAFT, getDraft, setDraft, type DraftFile } from '@/lib/chat/drafts';
import { deletedMessageLabel } from '@/lib/chat/thread';
import {
  addPick,
  deserializeMentions,
  displayCaret,
  insertMention,
  knownMentionName,
  mentionIds,
  mentionPickerRows,
  mentionQuery,
  rememberMentionNames,
  resolveMentionText,
  serializedCaret,
  serializeMentions,
  type MentionMember,
  type MentionPick,
  type NameOf,
} from '@/lib/chat/mentions';
import {
  COMPOSER_INPUT_TYPE,
  NO_TOUCH_SELECT,
  sized,
  useChatLayout,
} from '@/components/chat/chat-type';

export interface ComposerProps {
  /**
   * The open chat's Sorted channel id. The composer starts from this chat's
   * draft (text, caret, cards, files) on its first render and writes back as it
   * changes; absent keeps no draft.
   */
  channelId?: string | undefined;
  /**
   * Focus the input once on mount (a laptop's fine pointer, never touch), unless
   * a menu, sheet or lightbox is open over the thread.
   */
  focusOnMount?: boolean | undefined;
  /**
   * Handed the input element (null on unmount) so a Reply can focus it inside
   * the user's own tap or click (decision 128).
   */
  inputRef?: MutableRefObject<HTMLTextAreaElement | null> | undefined;
  /** Personal notes: no Schedule tile (the hold and the chevron need schedule wiring). */
  noSchedule?: boolean | undefined;
  /**
   * Whether the open chat has a client among its other active members; null
   * or absent while unknown. The Draft tile is live only when this is false
   * and the viewer is agency side; the hash picker leaves drafts out otherwise.
   */
  channelHasClient?: boolean | null | undefined;
  /**
   * The tray's Plan tile: opens the New plan screen. The tile is live only for
   * an agency-side viewer (and when this is set); otherwise faded and disabled.
   */
  onOpenPlanCompose?: (() => void) | undefined;
  /**
   * Queues the trimmed text plus any picked files (local attachments that upload
   * in the background) and shared posts and briefs. Synchronous: uploads,
   * delivery and retries run in the background.
   */
  onSend: ComposerSend;
  disabled: boolean;
  /**
   * Upload one file via the asset pipeline (with progress); absent disables
   * attaching. Picked files and voice notes carry it to the outbox, which
   * uploads in the background.
   */
  uploadFile?: AttachmentUploader | undefined;
  /** Called on each keystroke so the parent can broadcast a throttled typing signal. */
  onTyping?: (() => void) | undefined;
  /**
   * The active reply draft; renders the preview bar above the chips when
   * present. `deleted` (the quoted message was deleted) reads deletedMessageLabel.
   */
  reply?: { authorName: string; quote: ReplyQuote; deleted?: true } | undefined;
  /** The replied-to message's media (glyph, label, thumbnail) when it is loaded. */
  replyMedia?: QuoteMedia | null | undefined;
  /** Where the reply bar's thumbnail presigns from. */
  replyThumbSource?: QuoteThumbSource | undefined;
  /** The viewer's user id: a reply to their own deleted message reads "You deleted". */
  viewerUserId?: string | undefined;
  /** Clears the active reply draft (cancel button, and after a successful send). */
  onCancelReply?: (() => void) | undefined;
  /**
   * The post the conversation is about; renders the About bar above the reply
   * bar. Null while its post is still loading: the bar shows as a skeleton (it
   * can be closed) and sends carry no About reply.
   */
  about?: PostRefPost | null | undefined;
  /** Closes the About bar (its X); a send never clears it. */
  onCancelAbout?: (() => void) | undefined;
  /** Post ids already shared in this chat; picker rows say "in this chat". */
  sharedPostIds?: ReadonlySet<string> | undefined;
  /**
   * Bring a post into the conversation (the hash picker's pick); absent turns
   * the hash picker off.
   */
  onBringPost?: ((postId: string) => void) | undefined;
  /**
   * Editing an own message: the text becomes `initialText` (once per
   * messageId), the editing bar replaces the reply and About bars, and Send
   * calls onEdit instead of onSend. `hasOtherContent` (attachments or cards)
   * lets the body go empty; a text-only message cannot.
   */
  editing?: EditingDraft | undefined;
  /** The editing bar's X: leave editing; the composer restores the earlier draft. */
  onCancelEdit?: (() => void) | undefined;
  /** Record the edited body; resolves ok, or the mapped failure copy to show. */
  onEdit?: ((text: string) => Promise<{ ok: true } | { ok: false; message: string }>) | undefined;
  /**
   * The @ member picker: this chat's people (never the viewer) and the name
   * lookup that turns stored @[uuid] tokens back into "@Name". Absent turns @
   * mentions off; the text is then sent as typed.
   */
  mentions?: ComposerMentions | undefined;
  /** The placeholder in place of the chat's ("Reply in thread" in a thread view); editing keeps its own. */
  placeholder?: string | undefined;
}

/** What the composer needs for @ mentions. */
export interface ComposerMentions {
  members: readonly MentionMember[];
  /**
   * False while this chat's member list (and so the name registry) is still
   * loading: a stored body's tokens are then kept untouched, never dropped as
   * unknown. Absent counts as ready.
   */
  ready?: boolean;
  /** A group chat: the picker offers "@all" first. Absent counts as a DM. */
  isGroup?: boolean;
  /**
   * True only for a person a successful member read confirmed has left: their
   * stored mention drops. Any other unresolved mention (a failed or timed-out
   * read) stays a pick, shown as "@Unknown member", and still sends.
   */
  gone?: (userId: string) => boolean;
  selfId: string | null;
  nameOf: NameOf;
}

/** The name lookup for stored tokens: the chat's own, then this workspace's registry. */
function mentionNameOf(mentions: ComposerMentions | undefined, workspaceId: string | null): NameOf {
  const own = mentions?.nameOf;
  return (userId) => own?.(userId) ?? knownMentionName(workspaceId, userId);
}

/**
 * The textarea text and caret for a stored (serialized) draft: tokens become
 * "@Name" and their picks come back, so the draft keeps its mention map. Pure.
 */
export function restoreDraftText(
  stored: { text: string; caret: number },
  nameOf: NameOf,
  gone?: (userId: string) => boolean,
): { text: string; caret: number; picks: MentionPick[] } {
  const restored = deserializeMentions(stored.text, nameOf, gone);
  return { ...restored, caret: displayCaret(stored.text, stored.caret, nameOf) };
}

/**
 * The composer's state for a stored body (a restored draft, an edit's text, the
 * draft after an edit): with the chat's names ready, tokens become "@Name" and
 * picks as restoreDraftText does. Before that, a body with tokens is held: the
 * text stays the serialized body verbatim with no picks (so it serializes back
 * unchanged and its mentions still send), and deserializes once names settle.
 * A token still unknown after that (an ex-member) drops. Pure.
 */
export function composerBodyFor(
  stored: { text: string; caret: number },
  ready: boolean,
  nameOf: NameOf,
  gone?: (userId: string) => boolean,
): { text: string; caret: number; picks: MentionPick[]; held: boolean } {
  if (!ready && mentionIds(stored.text).length > 0) {
    return { text: stored.text, caret: stored.caret, picks: [], held: true };
  }
  return { ...restoreDraftText(stored, nameOf, gone), held: false };
}

/**
 * Which keys the open @ picker takes: Up / Down move, Enter or Tab picks (Enter
 * never sends while it is open), Escape closes. Null for any other key. Pure.
 */
export function mentionKeyAction(
  key: string,
  isComposing: boolean,
): 'up' | 'down' | 'pick' | 'close' | null {
  if (isComposing) return null;
  if (key === 'ArrowUp') return 'up';
  if (key === 'ArrowDown') return 'down';
  if (key === 'Enter' || key === 'Tab') return 'pick';
  if (key === 'Escape') return 'close';
  return null;
}

/**
 * The reply bar's preview line: the quote's text, or deletedMessageLabel once
 * the quoted message was deleted ("You deleted this message" when it was the
 * viewer's own). Pure.
 */
export function replyBarPreview(
  reply: { quote: ReplyQuote; deleted?: true },
  viewerUserId: string | undefined,
): string {
  if (reply.deleted !== true) return reply.quote.preview;
  const mine = reply.quote.authorUserId !== null && reply.quote.authorUserId === viewerUserId;
  return deletedMessageLabel({ mine });
}

/** The message being edited, as the composer takes it. */
export interface EditingDraft {
  messageId: string;
  initialText: string;
  hasOtherContent?: boolean;
}

/** Toast when an edit would leave a text-only message empty. */
export const EDIT_EMPTY_TOAST = "Message can't be empty";

/** The editing bar's first line. */
export const EDITING_BAR_TITLE = 'Editing your message';

/** The composer placeholder while editing. */
export const EDIT_PLACEHOLDER = 'Edit message';

/**
 * What Send does while editing: 'empty' (a text-only message cannot go
 * empty: toast, nothing sent), 'unchanged' (the same body: leave editing, no
 * write) or 'send'. Pure.
 */
export function editSendDecision(input: {
  text: string;
  initialText: string;
  hasOtherContent: boolean;
}): 'empty' | 'unchanged' | 'send' {
  const next = input.text.trim();
  if (next === '' && !input.hasOtherContent) return 'empty';
  if (next === input.initialText.trim()) return 'unchanged';
  return 'send';
}

/**
 * The text leaving an edit restores: this channel's own draft from the map, or
 * the session's saved text when the map has none. Never another chat's. Pure
 * over the draft map.
 */
export function editRestoreText(channelId: string, savedText: string | undefined): string {
  const draft = getDraft(channelId);
  return draft.text !== '' ? draft.text : (savedText ?? '');
}

/** The composer's edit session: which message, and the draft to restore after. */
export interface EditSession {
  messageId: string;
  savedText: string;
}

/**
 * Step the edit session when the `editing` prop changes. Entering (or
 * switching to another message) sets the text to its initialText and keeps
 * the draft typed before editing started (the first one, across switches);
 * leaving restores that draft. `text` is undefined when it stays as is. Pure.
 */
export function editTransition(
  session: EditSession | null,
  editing: EditingDraft | undefined,
  currentText: string,
): { session: EditSession | null; text: string | undefined } {
  const nextId = editing?.messageId ?? null;
  if (nextId === (session?.messageId ?? null)) return { session, text: undefined };
  if (editing === undefined) {
    return { session: null, text: session?.savedText ?? undefined };
  }
  return {
    session: { messageId: editing.messageId, savedText: session?.savedText ?? currentText },
    text: editing.initialText,
  };
}

/**
 * Which bars sit above the input: while editing only the editing bar; the
 * reply and About bars come back after.
 */
export function composerBars(input: { editing: boolean; reply: boolean; about: boolean }): {
  editing: boolean;
  reply: boolean;
  about: boolean;
} {
  if (input.editing) return { editing: true, reply: false, about: false };
  return { editing: false, reply: input.reply, about: input.about };
}

/**
 * The editing bar: the reply bar's grammar with a 3px warn rule, "Editing your
 * message" over the message's current text, and a 44px X that cancels.
 */
export function EditingBar(props: { text: string; onCancel: () => void }): ReactElement {
  return (
    <ReplyQuoteBox
      author={EDITING_BAR_TITLE}
      preview={props.text}
      tone="warn"
      trailing={
        <IconButton label="Cancel editing" className="shrink-0" onClick={props.onCancel}>
          <IconX size={16} />
        </IconButton>
      }
    />
  );
}

/** The hash picker's trigger, assembled so chat stays free of the raw literal. */
const HASH = String.fromCharCode(35);

/**
 * The composer placeholder: "Message about KEY-N" while About is up, else a
 * nudge towards the hash post picker ("Reply, ..." while a reply draft is up).
 */
export function composerPlaceholder(
  aboutRef: string | null,
  replying = false,
  editing = false,
): string {
  if (editing) return EDIT_PLACEHOLDER;
  if (aboutRef !== null) return `Message about ${aboutRef}`;
  return `${replying ? 'Reply' : 'Message'}, or ${HASH} for a post`;
}

/**
 * The About bar: the reply bar's grammar (3px accent rule, panel-3 box) with a
 * 32px thumbnail, "About KEY-N" in accent over the title, and a 44px close.
 * With no post yet (its read is in flight) it is a skeleton: "About", a title
 * placeholder and the same close, at the same height. No motion.
 */
export function AboutBar(props: {
  post: PostRefPost | null;
  refLabel: string | null;
  onCancel: () => void;
}): ReactElement {
  const post = props.post;
  return (
    <div
      data-about-bar={post?.id ?? ''}
      data-about-loading={post === null ? '' : undefined}
      className={cn(
        'flex min-w-0 items-center gap-2 overflow-hidden rounded-md bg-panel-3',
        NO_TOUCH_SELECT,
      )}
    >
      <span className="w-[3px] shrink-0 self-stretch rounded-full bg-accent" aria-hidden="true" />
      {post !== null ? (
        <PostRefThumb assetVersionId={post.thumbnailAssetVersionId} size={32} />
      ) : (
        <span aria-hidden="true" className="h-8 w-8 shrink-0 rounded-md bg-panel-2" />
      )}
      <span className="flex min-w-0 flex-1 flex-col py-1">
        <span className="truncate text-xs font-medium text-accent">
          {post !== null && props.refLabel !== null ? `About ${props.refLabel}` : 'About'}
        </span>
        {post !== null ? (
          <span className="truncate text-xs text-fg-2">{post.title}</span>
        ) : (
          <span aria-hidden="true" className="my-[3px] h-3 w-28 rounded bg-panel-2" />
        )}
      </span>
      <IconButton label="Close about" className="shrink-0" onClick={props.onCancel}>
        <IconX size={16} />
      </IconButton>
    </div>
  );
}

/** The toast when a send (a voice note's upload included) fails; raw text is only logged. */
export const SEND_FAILED_COPY = "Couldn't send, try again";

/** The pre-check's own lines (size, type, photo-only): known copy, shown as is. */
const ATTACH_REJECT_COPY: ReadonlySet<string> = new Set([
  'Files up to 100MB only',
  "This file type isn't supported",
  'Photos must be an image file',
]);

/** The toast for a file the pre-check refused: its known line, else a fixed one. */
export function attachRejectCopy(message: string): string {
  return ATTACH_REJECT_COPY.has(message) ? message : "Couldn't add that file, try again";
}

/**
 * The reply bar above the input: the quote (or the deleted label) and a 44px
 * cancel. Like the About bar it never selects text or shows the iOS callout on
 * a long-press; only the textarea and search inputs stay selectable.
 */
export function ReplyBar(props: {
  reply: { authorName: string; quote: ReplyQuote; deleted?: true };
  viewerUserId: string | undefined;
  onCancel: () => void;
  media?: QuoteMedia | null | undefined;
  thumbSource?: QuoteThumbSource | undefined;
}): ReactElement {
  return (
    <ReplyQuoteBox
      author={props.reply.authorName}
      preview={replyBarPreview(props.reply, props.viewerUserId)}
      deleted={props.reply.deleted === true}
      media={props.reply.deleted === true ? null : props.media}
      thumbSource={props.thumbSource}
      className={NO_TOUCH_SELECT}
      trailing={
        <IconButton label="Cancel reply" className="shrink-0" onClick={props.onCancel}>
          <IconX size={16} />
        </IconButton>
      }
    />
  );
}

/** The hash picker state for a text and caret: the query to search, or closed. */
export function hashPickerQuery(input: {
  enabled: boolean;
  dismissed: boolean;
  text: string;
  caret: number;
}): string | null {
  if (!input.enabled || input.dismissed) return null;
  return caretHashQuery(input.text, input.caret);
}

/** One accepted picked file, shown as a removable chip until Send. */
export type Pending = DraftFile;

/** Surfaces open over the thread that the composer must not take focus from. */
const OVERLAY_SELECTOR = '[aria-modal="true"], [role="menu"], [role="dialog"]';

/**
 * Whether the composer takes focus on open: a fine pointer only (no keyboard
 * pops on touch), and never while editing, the hash picker, or a menu / sheet /
 * lightbox is open. Pure.
 */
export function shouldFocusComposer(input: {
  finePointer: boolean;
  editing: boolean;
  hashOpen: boolean;
  overlayOpen: boolean;
}): boolean {
  return input.finePointer && !input.editing && !input.hashOpen && !input.overlayOpen;
}

/** The slice of the composer's input a Reply focuses (a test fake satisfies it). */
export interface ComposerInput {
  readonly value: string;
  focus: (options?: FocusOptions) => void;
  setSelectionRange: (start: number, end: number) => void;
}

/**
 * Decision 128: a Reply puts the cursor in the composer, after any draft text.
 * Call it synchronously inside the user's tap, click or pointerup: iOS WebKit
 * opens the keyboard only then, never from an effect, timer or frame. No
 * scroll, so the thread keeps its bottom pin; the draft is left as it is.
 */
export function focusComposerInput(el: ComposerInput | null): void {
  if (el === null) return;
  el.focus({ preventScroll: true });
  const end = el.value.length;
  el.setSelectionRange(end, end);
}

/** Whether a menu, sheet or lightbox is open in the document. */
function overlayOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector(OVERLAY_SELECTOR) !== null;
}

let pendingSeq = 0;

export type ComposerSend = (
  text: string,
  attachments: MessageAttachment[],
  sharedPostIds: string[],
  reply: ReplyQuote | null,
  sharedBriefIds: string[],
) => void;

/**
 * Hand one draft to the thread. The thread only queues it (the record write and
 * publish run in the background), so this returns in the same tick and the
 * composer clears and re-enables Send at once. True when the draft was taken;
 * false only when onSend threw, which is unexpected and logged, so the caller
 * keeps the draft.
 */
export function dispatchSend(
  onSend: ComposerSend,
  draft: {
    text: string;
    attachments: MessageAttachment[];
    sharedPostIds: string[];
    reply: ReplyQuote | null;
    sharedBriefIds: string[];
  },
): boolean {
  try {
    onSend(draft.text, draft.attachments, draft.sharedPostIds, draft.reply, draft.sharedBriefIds);
    return true;
  } catch (error) {
    logger.error('chat composer: send threw', { error: String(error) });
    return false;
  }
}

/** The draft fields pasted post / brief links can add cards to. */
export interface LinkCardDraft {
  text: string;
  sharedPostIds: string[];
  sharedBriefIds: string[];
}

/** Batched number-to-id reads for the open workspace (one query per entity type). */
export interface LinkCardReaders {
  postIds: (numbers: number[]) => Promise<Result<Array<{ id: string; number: number }>>>;
  briefIds: (numbers: number[]) => Promise<Result<Array<{ id: string; number: number }>>>;
}

/** The internal post / brief links in a body that belong to the open workspace. */
function workspaceLinks(
  text: string,
  workspaceKey: string | null,
  origin: string | null,
): Array<{ url: string; kind: 'post' | 'brief'; number: number }> {
  if (workspaceKey === null) return [];
  const links: Array<{ url: string; kind: 'post' | 'brief'; number: number }> = [];
  for (const segment of tokenize(text)) {
    if (segment.kind !== 'url') continue;
    const target = classify(segment.url, origin, APP_ENTITY_ROUTES);
    if (target.kind === 'external') continue;
    if (target.ref.key !== workspaceKey.toUpperCase()) continue;
    links.push({ url: segment.url, kind: target.kind, number: target.ref.number });
  }
  return links;
}

/** Whether Send must resolve pasted links first (any internal link to this workspace). */
export function hasLinkCards(
  text: string,
  workspaceKey: string | null,
  origin: string | null,
): boolean {
  return workspaceLinks(text, workspaceKey, origin).length > 0;
}

/**
 * Turn pasted post and brief links into shared cards at Send: at most one batched
 * read per entity type over every link's number, then each resolved id joins the
 * shared ids exactly as the picker adds it (no duplicates). A body of only
 * resolved links and whitespace sends as cards with an empty body; otherwise the
 * text stays as typed. A ref with no row under RLS, or a failed read, stays a
 * plain link with no error.
 */
export async function withLinkCards(
  draft: LinkCardDraft,
  context: { workspaceKey: string | null; origin: string | null },
  readers: LinkCardReaders,
): Promise<LinkCardDraft> {
  const links = workspaceLinks(draft.text, context.workspaceKey, context.origin);
  if (links.length === 0) return draft;
  const numbers = (kind: 'post' | 'brief'): number[] => [
    ...new Set(links.filter((l) => l.kind === kind).map((l) => l.number)),
  ];
  const postNumbers = numbers('post');
  const briefNumbers = numbers('brief');
  const [posts, briefs] = await Promise.all([
    postNumbers.length > 0 ? readers.postIds(postNumbers) : Promise.resolve(null),
    briefNumbers.length > 0 ? readers.briefIds(briefNumbers) : Promise.resolve(null),
  ]);
  const byNumber = (result: typeof posts): Map<number, string> =>
    new Map(result?.ok === true ? result.data.map((row) => [row.number, row.id]) : []);
  const postIdOf = byNumber(posts);
  const briefIdOf = byNumber(briefs);

  const sharedPostIds = [...draft.sharedPostIds];
  const sharedBriefIds = [...draft.sharedBriefIds];
  const resolved = new Set<string>();
  for (const link of links) {
    const id = (link.kind === 'post' ? postIdOf : briefIdOf).get(link.number);
    if (id === undefined) continue;
    resolved.add(link.url);
    const ids = link.kind === 'post' ? sharedPostIds : sharedBriefIds;
    if (!ids.includes(id)) ids.push(id);
  }
  const onlyLinks = tokenize(draft.text).every((segment) =>
    segment.kind === 'url' ? resolved.has(segment.url) : segment.text.trim() === '',
  );
  return { text: onlyLinks ? '' : draft.text, sharedPostIds, sharedBriefIds };
}

/**
 * True when `window.matchMedia('(pointer: coarse)')` matches, i.e. the primary
 * pointer is coarse (touch). Guarded so it returns false when `window` or
 * `window.matchMedia` is unavailable (SSR / non-DOM test environments).
 */
function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

/**
 * Whether a composer keydown should send rather than insert a newline: plain
 * Enter only. Shift+Enter (newline) and Enter mid-IME-composition are excluded,
 * and a coarse (touch-primary) pointer never sends on Enter so phones and
 * touch-only tablets keep the newline and tap Send instead.
 */
export function isSendKeydown(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  coarsePointer: boolean;
}): boolean {
  return input.key === 'Enter' && !input.shiftKey && !input.isComposing && !input.coarsePointer;
}

/**
 * Whether the composer's trailing control is the record-voice-note mic rather
 * than Send: only when attaching is possible and the composer is otherwise idle
 * and empty (no text, no pending attachments, no shared posts, not already
 * recording or processing a voice note).
 */
export function shouldShowMic(input: {
  hasUpload: boolean;
  disabled: boolean;
  text: string;
  attachmentCount: number;
  sharedPostCount: number;
  recording: boolean;
  voiceBusy: boolean;
}): boolean {
  return (
    input.hasUpload &&
    !input.disabled &&
    input.text.trim() === '' &&
    input.attachmentCount === 0 &&
    input.sharedPostCount === 0 &&
    !input.recording &&
    !input.voiceBusy
  );
}

/** Format a non-negative second count as mm:ss; 0 for non-finite input. */
function formatMmSs(s: number): string {
  const safe = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
  const mm = Math.floor(safe / 60);
  const ss = safe % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/**
 * The picked files as the send carries them: one local attachment per chip, in
 * order, holding the File, its preview URL (the bubble tile shows it) and the
 * uploader. The upload itself runs in the outbox after Send.
 */
export function draftAttachments(
  pending: readonly Pending[],
  upload: AttachmentUploader | undefined,
): MessageAttachment[] {
  return pending.map((item) => toLocalAttachment(item.file, item.previewUrl, upload));
}

/**
 * A recorded voice note as an instant-send attachment: the local file (no
 * version id yet, no preview) plus its recorded length and, when they could be
 * read from the finished recording, its waveform peaks, so the outbox uploads it and records it
 * like any picked file. Pure.
 */
export function voiceNoteAttachment(
  file: File,
  durationMs: number,
  upload: AttachmentUploader | undefined,
  peaks?: readonly number[],
): MessageAttachment {
  return {
    ...toLocalAttachment(file, null, upload),
    durationMs,
    ...(peaks !== undefined && peaks.length > 0 ? { peaks: [...peaks] } : {}),
  };
}

/** The toast when a recording is discarded for being under MIN_VOICE_NOTE_MS. */
export const VOICE_TOO_SHORT_COPY = 'Voice note too short';

/**
 * Send a finished recording as a voice note. A null, empty or sub-second
 * recording is 'too-short': no file, no peaks, nothing dispatched. Otherwise
 * the file is typed from its bytes and handed to the thread with its exact
 * length: 'sent' when taken, 'refused' when onSend threw.
 */
export async function sendVoiceRecording(
  rec: RecordingResult | null,
  onSend: ComposerSend,
  upload: AttachmentUploader | undefined,
  reply: ReplyQuote | null,
): Promise<'too-short' | 'sent' | 'refused'> {
  if (rec === null || rec.blob.size === 0 || rec.durationMs < MIN_VOICE_NOTE_MS) {
    return 'too-short';
  }
  // Type and name from the bytes, not the recorder's say-so.
  const { type, name } = voiceFileType(await readHeader(rec.blob), rec.recorderMime, rec.mime);
  const file = new File([rec.blob], name, { type });
  rememberRecorderMime(file, rec.recorderMime);
  // Peaks from the finished file, capped at 1s; none on any failure.
  const peaks = await voicePeaks(file);
  const taken = dispatchSend(onSend, {
    text: '',
    attachments: [voiceNoteAttachment(file, rec.durationMs, upload, peaks)],
    sharedPostIds: [],
    reply,
    sharedBriefIds: [],
  });
  return taken ? 'sent' : 'refused';
}

/** Whether Send is enabled: text, a picked file, or a shared post or brief. Never waits on an upload. */
export function composerCanSend(input: {
  disabled: boolean;
  text: string;
  fileCount: number;
  sharedPostCount: number;
  sharedBriefCount: number;
}): boolean {
  return (
    !input.disabled &&
    canSendAttachmentMessage({
      text: input.text,
      attachmentCount: input.fileCount,
      sharedPostCount: input.sharedPostCount,
      sharedBriefCount: input.sharedBriefCount,
      sending: false,
    })
  );
}

/**
 * Whether the draft may be scheduled from the hold, the chevron or the tray
 * with its preview: it can be sent, picked photos and files included (they
 * upload first, then the schedule write carries them). Never while editing;
 * voice notes are never scheduled (they send from the recorder). Pure.
 */
export function canScheduleDraft(input: {
  scheduling: boolean;
  editing: boolean;
  canSend: boolean;
}): boolean {
  return input.scheduling && !input.editing && input.canSend;
}

/** One picked file's upload while its draft is being scheduled. */
export interface ScheduleUpload {
  /** 0..1 while it uploads. */
  progress: number;
  /** Set once uploaded; a retry never uploads it again. */
  versionId: string | null;
  uploading: boolean;
  failed: boolean;
}

export type ScheduleUploads = Readonly<Record<string, ScheduleUpload>>;

const IDLE_UPLOAD: ScheduleUpload = {
  progress: 0,
  versionId: null,
  uploading: false,
  failed: false,
};

/** The picked files as the schedule upload takes them, with any version id already known. Pure. */
export function scheduleFilesFor(
  pending: readonly Pending[],
  uploads: ScheduleUploads,
): ScheduleFile[] {
  return pending.map((item) => ({
    key: item.id,
    file: item.file,
    versionId: uploads[item.id]?.versionId ?? null,
  }));
}

/** One chip's upload state with `patch` applied. Pure. */
export function withScheduleUpload(
  uploads: ScheduleUploads,
  key: string,
  patch: Partial<ScheduleUpload>,
): ScheduleUploads {
  return { ...uploads, [key]: { ...(uploads[key] ?? IDLE_UPLOAD), ...patch } };
}

/** Counts of picked photos and other files (the schedule preview's "2 photos"). Pure. */
export function pendingCounts(pending: readonly Pending[]): { photos: number; others: number } {
  const photos = pending.filter((item) => item.file.type.startsWith('image/')).length;
  return { photos, others: pending.length - photos };
}

/**
 * Library picks per chat for the session (they need no File, so they sit beside
 * the draft store), so leaving a chat and coming back keeps them like picked files.
 */
const libraryDrafts = new Map<string, MessageAttachment[]>();

/** Counts of picked photos and other files, library picks included. Pure. */
export function draftFileCounts(
  pending: readonly Pending[],
  library: readonly MessageAttachment[],
): { photos: number; others: number } {
  const base = pendingCounts(pending);
  const photos = library.filter((a) => classifyAttachment(a.mime) === 'image').length;
  return { photos: base.photos + photos, others: base.others + library.length - photos };
}

/**
 * The schedule write's attachment args: the uploaded files' args, then the
 * library picks' (already uploaded), ids and meta built the same way. Pure.
 */
export function withLibraryArgs(
  uploaded: ReturnType<typeof scheduleAttachmentArgs>,
  library: readonly MessageAttachment[],
): ReturnType<typeof scheduleAttachmentArgs> {
  const lib = scheduleAttachmentArgs(library);
  return {
    attachmentAssetIds: [...uploaded.attachmentAssetIds, ...lib.attachmentAssetIds],
    attachmentMeta: { ...uploaded.attachmentMeta, ...lib.attachmentMeta },
  };
}

/** A send draft with the library picks after its picked files. Pure. */
export function withLibraryAttachments<T extends { attachments: MessageAttachment[] }>(
  draft: T,
  library: readonly MessageAttachment[],
): T {
  return library.length === 0
    ? draft
    : { ...draft, attachments: [...draft.attachments, ...library] };
}

/** What a tray tile opens: the share picker in a mode, or the library picker. */
type TrayPicker = Exclude<PickerMode, 'inline'> | 'assets';

/** The scheduled strip's rows before the thread paints: none. */
const NO_SCHEDULED_ROWS: readonly ScheduledRow[] = [];

/**
 * A picked file's chip thumbnail: its preview (or the file glyph), dimmed with
 * a thin progress bar along the bottom while it uploads for a schedule, the
 * same treatment as a sending bubble's tile.
 */
function PendingThumb(props: {
  previewUrl: string | null;
  upload: ScheduleUpload | undefined;
}): ReactElement {
  const uploading = props.upload?.uploading === true;
  const progress = Math.round(Math.min(Math.max(props.upload?.progress ?? 0, 0), 1) * 100);
  return (
    <span className="relative flex h-full w-full items-center justify-center">
      {props.previewUrl !== null ? (
        <img
          src={props.previewUrl}
          alt=""
          className={cn('h-full w-full object-cover', uploading && 'opacity-50')}
        />
      ) : (
        <IconFile size={16} className={cn(uploading && 'opacity-50')} />
      )}
      {uploading ? (
        <span
          data-schedule-upload-bar={progress}
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-[3px] bg-panel-3"
        >
          <span className="block h-full bg-accent" style={{ width: `${progress}%` }} />
        </span>
      ) : null}
    </span>
  );
}

/** The Send button while a schedule uploads and writes. */
export const SCHEDULING_LABEL = 'Scheduling...';

/** The toast after a draft was scheduled: "Scheduled for tomorrow 9:00 AM". Pure. */
export function scheduledToast(sendAt: Date, now: Date): string {
  return `Scheduled for ${inSentence(formatSendLabel(sendAt, now))}`;
}

/**
 * Swallow the click that trails a long-press (it lands on the Send button, or
 * on the sheet's backdrop that opened under the finger): neither may submit or
 * close anything. Armed until shortly after the finger lifts.
 */
function swallowTrailingClick(): void {
  if (typeof window === 'undefined') return;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  const swallow = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    done();
  };
  const afterUp = (): void => {
    window.removeEventListener('pointerup', afterUp, true);
    if (fallback !== undefined) clearTimeout(fallback);
    fallback = setTimeout(done, 400);
  };
  function done(): void {
    window.removeEventListener('click', swallow, true);
    window.removeEventListener('pointerup', afterUp, true);
    if (fallback !== undefined) clearTimeout(fallback);
  }
  window.addEventListener('click', swallow, true);
  window.addEventListener('pointerup', afterUp, true);
  fallback = setTimeout(done, 10_000);
}

/**
 * Composer with text + an extensible attach menu (Photo / File). Files are
 * pre-checked client-side (a rejected one is refused with a toast) and shown as
 * removable chips; nothing uploads here. Send hands the picked files over as
 * local attachments: the bubble shows at once from the previews and the outbox
 * uploads them in the background, with progress on the bubble. Attachments-only
 * is allowed, empty is blocked. `onSend` only queues the message, so the draft
 * clears and Send re-enables in the same tick; a throw is unexpected, so it is
 * logged, surfaced as a toast, and the draft is kept.
 */
export function Composer(props: ComposerProps): ReactElement {
  const channelId = props.channelId;
  // First render starts from this chat's draft (never an effect), so a switch
  // paints the right text and chips on its first frame.
  const [initial] = useState(() => (channelId !== undefined ? getDraft(channelId) : EMPTY_DRAFT));
  // The draft stores the serialized body (tokens), so its mention map survives
  // a chat switch; the textarea shows "@Name" and the picks come back with it.
  // Until this chat's names are in, a body with tokens stays held (verbatim).
  const { workspaceId, workspaceKey } = useWorkspace();
  const nameOf = mentionNameOf(props.mentions, workspaceId);
  const namesReady = props.mentions?.ready !== false;
  const gone = props.mentions?.gone;
  const [restored] = useState(() => composerBodyFor(initial, namesReady, nameOf, gone));
  const [text, setText] = useState(restored.text);
  const [picks, setPicks] = useState<MentionPick[]>(restored.picks);
  const [held, setHeld] = useState(restored.held);
  const [pending, setPending] = useState<Pending[]>(initial.pendingFiles);
  const [sharedPosts, setSharedPosts] = useState<PostCardFields[]>(initial.sharedPosts);
  const [sharedBriefs, setSharedBriefs] = useState<BriefCardFields[]>(initial.sharedBriefs);
  // Which picker a tray tile opened (the share picker in a mode, or Assets).
  const [picker, setPicker] = useState<TrayPicker | null>(null);
  const [sheetMode, setSheetMode] = useState<Exclude<PickerMode, 'inline'>>('posts');
  // Library picks: already uploaded attachments (version id, no local half).
  const [library, setLibrary] = useState<MessageAttachment[]>(() =>
    channelId !== undefined ? (libraryDrafts.get(channelId) ?? []) : [],
  );
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [resolvingLinks, setResolvingLinks] = useState(false);
  // The caret, read on every change and selection, drives the hash picker.
  const [caret, setCaret] = useState(restored.caret);
  // Escape closes the hash picker until the caret leaves the token.
  const [hashDismissed, setHashDismissed] = useState(false);
  // The @ picker: Escape closes it until the caret leaves the @ run.
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [mentionActive, setMentionActive] = useState(0);
  // Editing: the draft to restore after, and whether the edit is being recorded.
  const editSessionRef = useRef<EditSession | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const editing = props.editing;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const inputRef = props.inputRef;
  const setTextarea = useCallback(
    (el: HTMLTextAreaElement | null): void => {
      textareaRef.current = el;
      if (inputRef !== undefined) inputRef.current = el;
    },
    [inputRef],
  );
  const recorder = useAudioRecorder();
  const toast = useToast();
  // 17px on every touch device (never under 16, so iOS never zooms), 15px on a laptop.
  const layout = useChatLayout();
  // The Draft tile and the hash picker's drafts: an agency-side viewer in a
  // chat with no client, both known; unknown keeps drafts off from frame one.
  const viewerSide = useViewerSide(workspaceId);
  const draftEnabled = draftTileEnabled(
    viewerSide.ready ? viewerSide.side : 'unknown',
    props.channelHasClient ?? null,
  );
  const planEnabled =
    props.onOpenPlanCompose !== undefined &&
    planTileEnabled(viewerSide.ready ? viewerSide.side : 'unknown');

  const formRef = useRef<HTMLFormElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Scheduling: the open chat's wiring (absent in the thread view), schedule
  // mode's send time, which surface is open and what a pick does there.
  const schedule = useChatSchedule(channelId);
  const [scheduleAt, setScheduleAt] = useState<Date | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState<{
    purpose: 'draft' | 'mode';
    preview: string | null;
  } | null>(null);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const chevronRef = useRef<HTMLSpanElement>(null);
  // Picked files upload before a schedule write: each chip's progress, its
  // version id once uploaded (a retry skips it) and its failure. One run at a
  // time; leaving the chat (or unmounting) aborts it, and nothing is scheduled.
  const [scheduleUploads, setScheduleUploads] = useState<ScheduleUploads>({});
  const scheduleRunRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      scheduleRunRef.current?.abort();
      scheduleRunRef.current = null;
    },
    [channelId],
  );

  // Keep this chat's library picks for the session (a chat switch remounts).
  useEffect(() => {
    if (channelId === undefined) return;
    if (library.length === 0) libraryDrafts.delete(channelId);
    else libraryDrafts.set(channelId, library);
  }, [channelId, library]);

  const canAttach = props.uploadFile !== undefined && !props.disabled && editing === undefined;
  const canSend =
    editing !== undefined
      ? !props.disabled && !editBusy
      : composerCanSend({
          disabled: props.disabled || resolvingLinks || scheduleBusy,
          text,
          fileCount: pending.length + library.length,
          sharedPostCount: sharedPosts.length,
          sharedBriefCount: sharedBriefs.length,
        });
  const schedulable = canScheduleDraft({
    scheduling: schedule !== null,
    editing: editing !== undefined,
    canSend,
  });
  const scheduling = scheduleAt !== null && schedule !== null && editing === undefined;
  const schedulableRef = useRef(schedulable);
  schedulableRef.current = schedulable;

  // Write the draft back as it changes (not while editing: the map keeps the
  // draft typed before the edit, which is what leaving the edit restores).
  const editingNow = editing !== undefined;
  useEffect(() => {
    if (channelId === undefined || editingNow) return;
    setDraft(channelId, {
      text: serializeMentions(text, picks),
      caret: serializedCaret(text, caret, picks),
      pendingFiles: pending,
      sharedPosts,
      sharedBriefs,
    });
  }, [channelId, editingNow, text, caret, picks, pending, sharedPosts, sharedBriefs]);

  // Enter / leave editing once per message id: the text swaps (and comes back
  // after), the caret goes to the end. Before paint, so the old text never shows.
  // The session carries serialized bodies (tokens): the edit's initialText and
  // the saved draft both come back as "@Name" text plus their picks.
  const textRef = useRef(serializeMentions(text, picks));
  textRef.current = serializeMentions(text, picks);
  const editingId = editing?.messageId;
  useLayoutEffect(() => {
    const step = editTransition(editSessionRef.current, editing, textRef.current);
    editSessionRef.current = step.session;
    if (step.text === undefined) return;
    // Leaving an edit restores this chat's own draft (the composer is per chat).
    const stored =
      step.session === null && channelId !== undefined
        ? editRestoreText(channelId, step.text)
        : step.text;
    const shown = composerBodyFor({ text: stored, caret: stored.length }, namesReady, nameOf, gone);
    setText(shown.text);
    setPicks(shown.picks);
    setCaret(shown.caret);
    setHeld(shown.held);
    setEditBusy(false);
    if (step.session === null) return;
    const el = textareaRef.current ?? formRef.current?.querySelector('textarea') ?? null;
    if (el === null) return;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
    // Only the id drives the session; initialText is read once per id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  // The chat's names settled: a held body becomes "@Name" text and its picks.
  useLayoutEffect(() => {
    if (!held || !namesReady) return;
    const shown = composerBodyFor({ text, caret }, true, nameOf, gone);
    setText(shown.text);
    setPicks(shown.picks);
    setCaret(shown.caret);
    setHeld(false);
    // Only the settle drives this; the held text and caret are read then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held, namesReady]);

  const menuItems = useMemo(
    () =>
      attachmentMenuItems({
        onPickPhoto: () => photoInputRef.current?.click(),
        onPickFile: () => fileInputRef.current?.click(),
        onSharePost: () => openPicker('posts'),
      }),
    [],
  );

  function addFiles(list: FileList | null, imageOnly: boolean): void {
    if (list === null || list.length === 0 || props.uploadFile === undefined) return;
    if (scheduleBusy) return;
    const accepted: Pending[] = [];
    for (const file of Array.from(list)) {
      // The Photo path is image-only; the File path takes the full allowlist.
      const check = imageOnly ? precheckImage(file) : precheckFile(file);
      if (!check.ok) {
        toast.show({ title: attachRejectCopy(check.message) });
        continue;
      }
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      accepted.push({ id: `att-${(pendingSeq += 1)}`, file, previewUrl });
    }
    if (accepted.length > 0) setPending((prev) => [...prev, ...accepted]);
  }

  // Laptop emoji: inserted at the caret (a selection is replaced), which then
  // sits right after it.
  function insertEmoji(emoji: string): void {
    if (scheduleBusy) return;
    const el = textareaRef.current;
    const at =
      el !== null
        ? { start: el.selectionStart, end: el.selectionEnd }
        : { start: caret, end: caret };
    const next = insertAtCaret(text, at, emoji);
    setText(next.value);
    setCaret(next.caret);
    props.onTyping?.();
    requestAnimationFrame(() => {
      const area = textareaRef.current;
      if (area === null) return;
      area.focus();
      area.setSelectionRange(next.caret, next.caret);
    });
  }

  function removePending(id: string): void {
    // Locked while a schedule uploads.
    if (scheduleBusy) return;
    setScheduleUploads((prev) => {
      if (prev[id] === undefined) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setPending((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.previewUrl != null) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
  }

  /** Open a tray picker. The share picker keeps its mode through the exit. */
  function openPicker(next: TrayPicker): void {
    if (next !== 'assets') setSheetMode(next);
    setPicker(next);
  }

  /** Add confirmed library picks as already uploaded attachment chips. */
  function addLibrary(picks: LibraryAsset[]): void {
    if (scheduleBusy) return;
    setLibrary((prev) => [...prev, ...libraryAttachments(picks, prev)]);
  }

  function removeLibrary(versionId: string): void {
    // Locked while a schedule runs.
    if (scheduleBusy) return;
    setLibrary((prev) => prev.filter((item) => item.assetId !== versionId));
  }

  function toggleSharedPost(post: PostCardFields): void {
    setSharedPosts((prev) => togglePost(prev, post));
  }

  function toggleSharedBrief(brief: BriefCardFields): void {
    setSharedBriefs((prev) => toggleBrief(prev, brief));
  }

  // Enter sends on desktop; Shift+Enter, IME composition, and touch-primary
  // devices keep the default newline. Route through the form's submit so the
  // Send button's exact handler and guard run.
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    const action =
      mentionRows.length > 0 ? mentionKeyAction(event.key, event.nativeEvent.isComposing) : null;
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
    if (event.key === 'Escape' && hashQuery !== null) {
      event.preventDefault();
      setHashDismissed(true);
      return;
    }
    if (
      !isSendKeydown({
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing,
        coarsePointer: isCoarsePointer(),
      })
    )
      return;
    event.preventDefault();
    formRef.current?.requestSubmit();
  }

  function submitEdit(draft: EditingDraft): void {
    // The saved body carries its tokens; the edit flow sends its full mention list.
    const body = serializeMentions(text, picks);
    const decision = editSendDecision({
      text: body,
      initialText: draft.initialText,
      hasOtherContent: draft.hasOtherContent === true,
    });
    if (decision === 'empty') {
      toast.show({ title: EDIT_EMPTY_TOAST });
      return;
    }
    if (decision === 'unchanged' || props.onEdit === undefined) {
      props.onCancelEdit?.();
      return;
    }
    setEditBusy(true);
    void props
      .onEdit(body)
      .catch((error: unknown) => {
        logger.error('chat composer: edit threw', { error: String(error) });
        return { ok: false as const, message: "Couldn't edit, try again" };
      })
      .then((result) => {
        // Success: the parent leaves editing and the earlier draft comes back.
        if (editSessionRef.current?.messageId !== draft.messageId) return;
        setEditBusy(false);
        if (!result.ok) toast.show({ title: editFailureCopy(result.message) });
      });
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!canSend) return;
    if (editing !== undefined) {
      submitEdit(editing);
      return;
    }
    if (scheduling) {
      if (schedulable) void scheduleDraft(scheduleAt);
      return;
    }
    const body = serializeMentions(text, picks);
    const draft: LinkCardDraft = {
      text: body,
      sharedPostIds: sharedPosts.map((post) => post.id),
      sharedBriefIds: sharedBriefs.map((brief) => brief.id),
    };
    const origin = currentOrigin();
    // Pasted post / brief links resolve here, at Send only (never per keystroke).
    if (workspaceId === null || !hasLinkCards(body, workspaceKey, origin)) {
      send(draft);
      return;
    }
    setResolvingLinks(true);
    void withLinkCards(
      draft,
      { workspaceKey, origin },
      {
        postIds: (numbers) => readPostIdsByNumbers(supabase, { workspaceId, numbers }),
        briefIds: (numbers) => readBriefIdsByNumbers(supabase, { workspaceId, numbers }),
      },
    )
      .catch((error: unknown) => {
        logger.warn('chat composer: link cards failed', { error: String(error) });
        return draft;
      })
      .then((resolved) => {
        setResolvingLinks(false);
        send(resolved);
      });
  }

  function send(draft: LinkCardDraft): void {
    // Picked files go as local attachments (uploaded by the outbox); library
    // picks follow, already uploaded, so the outbox never uploads them.
    const taken = dispatchSend(
      props.onSend,
      withLibraryAttachments(
        {
          text: draft.text,
          attachments: draftAttachments(pending, props.uploadFile),
          sharedPostIds: draft.sharedPostIds,
          reply: props.reply?.quote ?? null,
          sharedBriefIds: draft.sharedBriefIds,
        },
        library,
      ),
    );
    if (!taken) {
      // Keep the draft (text + chips + shared posts) so it is not lost.
      toast.show({ title: 'Could not send the message. Your draft is kept.' });
      return;
    }
    // The preview URLs now belong to the bubble (revoked when it goes).
    if (channelId !== undefined) {
      clearDraft(channelId);
      libraryDrafts.delete(channelId);
    }
    setText('');
    setPicks([]);
    setCaret(0);
    setPending([]);
    setLibrary([]);
    setSharedPosts([]);
    setSharedBriefs([]);
    props.onCancelReply?.();
  }

  /** Open the Schedule sheet (phone) or menu (laptop): a draft schedules at once on a pick. */
  function openSchedule(): void {
    if (schedule === null) return;
    setScheduleOpen(
      schedulableRef.current
        ? {
            purpose: 'draft',
            preview: schedulePreview(schedule.chatName, text, draftFileCounts(pending, library)),
          }
        : { purpose: 'mode', preview: null },
    );
  }

  function pickSchedule(sendAt: Date): void {
    const purpose = scheduleOpen?.purpose;
    setScheduleOpen(null);
    if (purpose === 'draft' && schedulableRef.current) void scheduleDraft(sendAt);
    else setScheduleAt(sendAt);
  }

  // Schedule the draft with the same parts the normal send carries (pasted
  // links resolved to cards the same way). Picked files upload first, all in
  // parallel through the normal send's uploader; only when every one is up does
  // chat_message_schedule run, carrying their version ids and attachment_meta
  // built as the normal send builds it. Any failed upload schedules nothing:
  // the files stay, the failed chips say so, and a retry uploads only those.
  // Success clears the draft, the reply and schedule mode; a failure keeps
  // everything and says why. Leaving the chat mid-run aborts the uploads and
  // schedules nothing.
  async function scheduleDraft(sendAt: Date): Promise<void> {
    if (schedule === null || scheduleBusy || scheduleRunRef.current !== null) return;
    const run = new AbortController();
    scheduleRunRef.current = run;
    setScheduleBusy(true);
    const picked = pending;
    const pickedLibrary = library;
    const files = scheduleFilesFor(picked, scheduleUploads);
    setScheduleUploads((prev) =>
      files.reduce(
        (next, item) =>
          item.versionId !== null
            ? next
            : withScheduleUpload(next, item.key, { progress: 0, uploading: true, failed: false }),
        prev,
      ),
    );
    const body = serializeMentions(text, picks);
    const base: LinkCardDraft = {
      text: body,
      sharedPostIds: sharedPosts.map((post) => post.id),
      sharedBriefIds: sharedBriefs.map((brief) => brief.id),
    };
    const replyToMessageId = props.reply?.quote.id ?? null;
    let result: Awaited<ReturnType<typeof scheduleWithFiles<ScheduleOutcome | null>>>;
    try {
      result = await scheduleWithFiles<ScheduleOutcome | null>({
        files,
        upload: props.uploadFile,
        signal: run.signal,
        onProgress: (key, fraction) =>
          setScheduleUploads((prev) => withScheduleUpload(prev, key, { progress: fraction })),
        onUploaded: (key, versionId) =>
          setScheduleUploads((prev) =>
            withScheduleUpload(prev, key, { versionId, progress: 1, uploading: false }),
          ),
        write: async (uploadedArgs) => {
          // The uploaded files' ids and meta, then the library picks' (already up).
          const attachmentArgs = withLibraryArgs(uploadedArgs, pickedLibrary);
          const origin = currentOrigin();
          const draft =
            workspaceId === null || !hasLinkCards(body, workspaceKey, origin)
              ? base
              : await withLinkCards(
                  base,
                  { workspaceKey, origin },
                  {
                    postIds: (numbers) => readPostIdsByNumbers(supabase, { workspaceId, numbers }),
                    briefIds: (numbers) =>
                      readBriefIdsByNumbers(supabase, { workspaceId, numbers }),
                  },
                ).catch(() => base);
          // Left the chat while the links resolved: schedule nothing.
          if (run.signal.aborted) return null;
          return schedule
            .schedule(
              {
                body: draft.text,
                sharedPostIds: draft.sharedPostIds,
                sharedBriefIds: draft.sharedBriefIds,
                replyToMessageId,
                ...attachmentArgs,
              },
              sendAt,
            )
            .catch((error: unknown) => {
              logger.error('chat composer: schedule threw', { error: String(error) });
              return { ok: false as const, copy: SCHEDULE_FAILED_COPY };
            });
        },
      });
    } catch (error) {
      logger.error('chat composer: schedule threw', { error: String(error) });
      result = { kind: 'written', result: { ok: false, copy: SCHEDULE_FAILED_COPY } };
    } finally {
      // Never left locked, whatever the run did.
      if (scheduleRunRef.current === run) scheduleRunRef.current = null;
      setScheduleBusy(false);
    }
    if (result.kind === 'aborted') return;
    if (result.kind === 'upload-failed') {
      logger.warn('chat composer: schedule upload failed', {
        failed: result.failedKeys.length,
        files: files.length,
      });
      setScheduleUploads((prev) =>
        result.failedKeys.reduce(
          (next, key) => withScheduleUpload(next, key, { uploading: false, failed: true }),
          prev,
        ),
      );
      // Keep the picked time: Send in schedule mode retries at it.
      setScheduleAt(sendAt);
      toast.show({ title: SCHEDULE_UPLOAD_FAILED_COPY });
      return;
    }
    const outcome = result.result;
    if (outcome === null) return;
    if (outcome.ok) {
      if (channelId !== undefined) {
        clearDraft(channelId);
        libraryDrafts.delete(channelId);
      }
      // The previews belong to no bubble: the message sends later from storage.
      // After leaving the chat they are left alone: a composer that came back
      // may already show them again from the draft.
      if (!run.signal.aborted) {
        for (const item of picked) {
          if (item.previewUrl !== null) URL.revokeObjectURL(item.previewUrl);
        }
      }
    }
    // Left the chat while the write ran: this composer is gone, but the
    // message is scheduled, so the app-level toast still says so.
    if (run.signal.aborted) {
      if (outcome.ok) toast.show({ title: scheduledToast(sendAt, new Date()) });
      return;
    }
    if (!outcome.ok) {
      if (outcome.copy !== null) toast.show({ title: outcome.copy });
      return;
    }
    setText('');
    setPicks([]);
    setCaret(0);
    setPending([]);
    setLibrary([]);
    setScheduleUploads({});
    setSharedPosts([]);
    setSharedBriefs([]);
    setScheduleAt(null);
    props.onCancelReply?.();
    toast.show({ title: scheduledToast(sendAt, new Date()) });
  }

  // Phone: a hold on Send opens the sheet; a tap still sends. The trailing
  // click is swallowed so the hold never also submits.
  const sendHold = useLongPress(() => {
    sendHold.clearClickSuppression();
    if (!schedulableRef.current) return;
    swallowTrailingClick();
    openSchedule();
  });
  const holdToSchedule = layout === 'touch' && schedulable;
  const showChevron = layout === 'laptop' && schedulable;

  async function start(): Promise<void> {
    const ok = await recorder.start();
    if (!ok) toast.show({ title: 'Microphone access is needed to record.' });
  }

  function cancel(): void {
    recorder.cancel();
  }

  // The recording goes to the outbox like a picked file: the bubble shows its
  // clock at once, the blob is kept (IndexedDB) until the row lands, and the
  // upload runs in the background with retries. Never transcribed at send time.
  async function stopSend(): Promise<void> {
    setVoiceBusy(true);
    try {
      // stop() releases the mic before resolving, on every path.
      const rec = await recorder.stop();
      const outcome = await sendVoiceRecording(
        rec,
        props.onSend,
        props.uploadFile,
        props.reply?.quote ?? null,
      );
      if (outcome === 'too-short') toast.show({ title: VOICE_TOO_SHORT_COPY });
      else if (outcome === 'sent') props.onCancelReply?.();
      else toast.show({ title: 'Could not send the voice note.' });
    } catch (error) {
      logger.error('chat composer: voice note send failed', { error: String(error) });
      toast.show({ title: 'Could not send the voice note.' });
    } finally {
      setVoiceBusy(false);
    }
  }

  function trackCaret(event: SyntheticEvent<HTMLTextAreaElement>): void {
    const el = event.currentTarget;
    textareaRef.current = el;
    // A held body's caret stays in its stored coordinates until it settles.
    if (held) return;
    const next = el.selectionStart ?? el.value.length;
    setCaret(next);
    if (caretHashQuery(el.value, next) === null) setHashDismissed(false);
    if (mentionQuery(el.value, next) === null) setMentionDismissed(false);
  }

  const hashQuery = hashPickerQuery({
    enabled: props.onBringPost !== undefined && !props.disabled && editing === undefined,
    dismissed: hashDismissed,
    text,
    caret,
  });

  // The @ picker's rows: "@all" first in a group, then this chat's people
  // matching the typed run, never me.
  const openMention =
    props.mentions !== undefined && !props.disabled && !mentionDismissed && !held
      ? mentionQuery(text, caret)
      : null;
  const mentionRows =
    openMention !== null && props.mentions !== undefined
      ? mentionPickerRows(
          props.mentions.members,
          openMention.query,
          props.mentions.selfId,
          props.mentions.isGroup === true,
        )
      : [];
  const activeRow = Math.min(mentionActive, Math.max(mentionRows.length - 1, 0));

  // A pick swaps the "@query" run for "@Name " and keeps the mention in the map.
  function pickMention(member: MentionMember | undefined): void {
    if (member === undefined) return;
    const next = insertMention(text, caret, member.displayName);
    rememberMentionNames(workspaceId, [member]);
    setPicks((prev) => addPick(prev, { userId: member.userId, name: member.displayName }));
    setText(next.text);
    setCaret(next.caret);
    setMentionActive(0);
    const el = textareaRef.current;
    if (el !== null) {
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
      });
    }
  }

  // Laptop: the cursor sits in the composer when a chat opens (once, on mount),
  // unless a restored draft reopened the hash or @ picker.
  const focusOnMount = props.focusOnMount === true;
  const hashOpenOnMount = hashQuery !== null || mentionRows.length > 0;
  useEffect(() => {
    if (
      !shouldFocusComposer({
        finePointer: focusOnMount,
        editing: editingNow,
        hashOpen: hashOpenOnMount,
        overlayOpen: overlayOpen(),
      })
    ) {
      return;
    }
    const el = textareaRef.current;
    if (el === null) return;
    el.focus({ preventScroll: true });
    const end = el.value.length;
    el.setSelectionRange(end, end);
    // Once per mount (a chat open or switch); later focus is the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A pick drops the hash token from the text and brings the post in.
  function pickHashPost(post: PostCardFields): void {
    const next = stripHashToken(text, caret);
    setText(next.text);
    setCaret(next.caret);
    const el = textareaRef.current;
    if (el !== null) {
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
      });
    }
    props.onBringPost?.(post.id);
  }

  const aboutRef = props.about != null ? postRefKey(workspaceKey, props.about.number) : null;

  const bars = composerBars({
    editing: editing !== undefined,
    reply: props.reply != null,
    about: props.about !== undefined,
  });

  const showMic =
    !scheduling &&
    shouldShowMic({
      hasUpload: props.uploadFile !== undefined && editing === undefined,
      disabled: props.disabled,
      text,
      attachmentCount: pending.length + library.length,
      sharedPostCount: sharedPosts.length + sharedBriefs.length,
      recording: recorder.recording,
      voiceBusy,
    });

  const scheduleSurface =
    scheduleOpen !== null && layout === 'laptop' ? (
      <ScheduleMenu
        open
        onClose={() => setScheduleOpen(null)}
        preview={scheduleOpen.preview}
        onPick={pickSchedule}
        anchorRef={chevronRef}
      />
    ) : schedule !== null && layout === 'touch' ? (
      <ScheduleSheet
        open={scheduleOpen !== null}
        onClose={() => setScheduleOpen(null)}
        preview={scheduleOpen?.preview ?? null}
        onPick={pickSchedule}
      />
    ) : null;

  return (
    <>
      {schedule !== null ? (
        <ScheduledStrip
          rows={schedule.stripVisible ? schedule.rows : NO_SCHEDULED_ROWS}
          onOpen={schedule.openList}
          channelId={schedule.channelId}
          onChanged={schedule.refetch}
        />
      ) : null}
      <form
        ref={formRef}
        onSubmit={submit}
        className="relative flex flex-col gap-2 border-t border-border bg-panel px-3 py-2.5"
      >
        {mentionRows.length > 0 ? (
          <div data-mention-anchor="" className="absolute inset-x-3 bottom-full z-20 mb-2">
            <MentionPicker members={mentionRows} active={activeRow} onPick={pickMention} />
          </div>
        ) : null}

        {hashQuery !== null && mentionRows.length === 0 ? (
          <div data-hash-picker="" className="absolute inset-x-3 bottom-full z-20 mb-2">
            <PostPicker
              inline
              open
              query={hashQuery}
              onClose={() => setHashDismissed(true)}
              selected={[]}
              onToggle={pickHashPost}
              selectedBriefs={[]}
              onToggleBrief={() => undefined}
              sharedPostIds={props.sharedPostIds}
              channelHasClient={props.channelHasClient ?? null}
            />
          </div>
        ) : null}

        {bars.editing && editing !== undefined ? (
          <EditingBar
            text={resolveMentionText(editing.initialText, nameOf)}
            onCancel={() => props.onCancelEdit?.()}
          />
        ) : null}

        {bars.about && props.about !== undefined ? (
          <AboutBar
            post={props.about}
            refLabel={aboutRef}
            onCancel={() => props.onCancelAbout?.()}
          />
        ) : null}

        {bars.reply && props.reply != null ? (
          <ReplyBar
            reply={{
              ...props.reply,
              quote: {
                ...props.reply.quote,
                preview: resolveMentionText(props.reply.quote.preview, nameOf),
              },
            }}
            viewerUserId={props.viewerUserId}
            onCancel={() => props.onCancelReply?.()}
            media={props.replyMedia}
            thumbSource={props.replyThumbSource}
          />
        ) : null}

        {editing === undefined &&
        (pending.length > 0 ||
          library.length > 0 ||
          sharedPosts.length > 0 ||
          sharedBriefs.length > 0) ? (
          <ul className="flex flex-wrap gap-2">
            {pending.map((item) => (
              <PendingChip
                key={item.id}
                thumb={
                  <PendingThumb previewUrl={item.previewUrl} upload={scheduleUploads[item.id]} />
                }
                title={item.file.name}
                meta={
                  scheduleUploads[item.id]?.failed === true
                    ? 'Upload failed'
                    : fileExtension(item.file.name)
                }
                error={scheduleUploads[item.id]?.failed === true}
                onRemove={() => removePending(item.id)}
              />
            ))}
            {library.map((item) => (
              <PendingChip
                key={item.assetId}
                thumb={<LibraryThumb attachment={item} />}
                title={item.name}
                meta={fileExtension(item.name) || 'File'}
                onRemove={() => removeLibrary(item.assetId)}
              />
            ))}
            {sharedPosts.map((post) => (
              <PendingChip
                key={post.id}
                thumb={<IconPipeline size={16} />}
                title={post.title}
                meta={stageLabel(post.stage)}
                onRemove={() => toggleSharedPost(post)}
              />
            ))}
            {sharedBriefs.map((brief) => (
              <PendingChip
                key={brief.id}
                thumb={<IconBriefs size={16} />}
                title={brief.title}
                meta={briefStatusLabel(brief.status)}
                onRemove={() => toggleSharedBrief(brief)}
              />
            ))}
          </ul>
        ) : null}

        {scheduling ? (
          <ScheduleModeStrip
            label={inSentence(formatSendLabel(scheduleAt, new Date()))}
            onStop={() => setScheduleAt(null)}
          />
        ) : null}

        <div className="flex items-end gap-2">
          {recorder.recording ? (
            <>
              <IconButton
                label="Cancel recording"
                className="shrink-0 text-bad hover:bg-bad-soft hover:text-bad"
                onClick={cancel}
              >
                <IconTrash size={20} />
              </IconButton>
              <div className="flex h-11 flex-1 items-center gap-2 rounded-md border border-border bg-panel-2 px-3">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-bad"
                />
                <span className="text-sm text-fg-2">Recording</span>
                <span className="ml-auto font-mono text-xs tabular-nums text-fg-2">
                  {formatMmSs(recorder.seconds)}
                </span>
              </div>
              <Button
                type="button"
                variant="primary"
                size="lg"
                aria-label="Stop and send voice note"
                className="w-11 shrink-0 px-0"
                onClick={() => void stopSend()}
              >
                <IconSend size={18} />
              </Button>
            </>
          ) : voiceBusy ? (
            <div className="flex h-11 flex-1 items-center gap-2 px-1">
              <span
                aria-hidden="true"
                className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-border border-t-accent"
              />
              <span className="text-sm text-fg-2">Sending voice note…</span>
            </div>
          ) : (
            <>
              {canAttach ? (
                <ComposerTray
                  layout={layout}
                  schedule={props.noSchedule !== true}
                  draft={draftEnabled}
                  plan={planEnabled}
                  onPick={(id) => {
                    if (scheduleBusy) return;
                    switch (id) {
                      case 'photos':
                        photoInputRef.current?.click();
                        return;
                      case 'file':
                        fileInputRef.current?.click();
                        return;
                      case 'assets':
                        openPicker('assets');
                        return;
                      case 'brief':
                        openPicker('briefs');
                        return;
                      case 'post':
                        openPicker('posts');
                        return;
                      case 'draft':
                        if (draftEnabled) openPicker('drafts');
                        return;
                      case 'plan':
                        if (planEnabled) props.onOpenPlanCompose?.();
                        return;
                      case 'schedule':
                        openSchedule();
                        return;
                    }
                  }}
                />
              ) : null}

              <Textarea
                ref={setTextarea}
                // A chat message, not an AutoFill target: off stops the iOS AutoFill bar.
                autoComplete="off"
                value={held ? resolveMentionText(text, nameOf) : text}
                readOnly={held || scheduleBusy}
                onChange={(event) => {
                  setText(event.target.value);
                  setMentionActive(0);
                  trackCaret(event);
                  props.onTyping?.();
                }}
                onSelect={trackCaret}
                onKeyDown={handleKeyDown}
                placeholder={
                  // Locked while scheduling: the wider "Scheduling..." never wraps it.
                  scheduleBusy
                    ? ''
                    : props.placeholder !== undefined && editing === undefined
                      ? props.placeholder
                      : composerPlaceholder(aboutRef, props.reply != null, editing !== undefined)
                }
                rows={1}
                compact
                className={sized(COMPOSER_INPUT_TYPE, layout)}
              />
              {showsEmojiButton(layout) && !held ? <ComposerEmoji onPick={insertEmoji} /> : null}
              {showMic ? (
                <Button
                  type="button"
                  variant="primary"
                  size="lg"
                  aria-label="Record voice note"
                  className="w-11 shrink-0 px-0"
                  onClick={() => void start()}
                >
                  <IconMic size={18} />
                </Button>
              ) : (
                <div className="flex shrink-0">
                  <Button
                    type="submit"
                    variant="primary"
                    size="lg"
                    aria-label={
                      editing !== undefined
                        ? 'Save edit'
                        : scheduleBusy
                          ? 'Scheduling'
                          : scheduling
                            ? 'Schedule message'
                            : 'Send'
                    }
                    aria-busy={editBusy || scheduleBusy || undefined}
                    className={cn(
                      scheduleBusy ? 'shrink-0 whitespace-nowrap px-3' : 'w-11 shrink-0 px-0',
                      showChevron && 'rounded-r-none',
                      holdToSchedule && NO_TOUCH_SELECT,
                    )}
                    disabled={!canSend || (scheduling && !schedulable)}
                    {...(holdToSchedule ? sendHold.handlers : {})}
                    onClick={(event) => {
                      if (sendHold.consumeClickSuppression()) event.preventDefault();
                    }}
                    onContextMenu={holdToSchedule ? (event) => event.preventDefault() : undefined}
                  >
                    {editBusy ? (
                      <span
                        aria-hidden="true"
                        data-edit-spinner=""
                        className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
                      />
                    ) : scheduleBusy ? (
                      <span data-scheduling="" className="text-sm font-medium">
                        {SCHEDULING_LABEL}
                      </span>
                    ) : scheduling ? (
                      <IconCalendarClock size={18} />
                    ) : (
                      <IconSend size={18} />
                    )}
                  </Button>
                  {showChevron ? (
                    <>
                      <span aria-hidden="true" className="w-px shrink-0 self-stretch bg-panel" />
                      <span ref={chevronRef} className="flex">
                        <Button
                          type="button"
                          variant="primary"
                          size="lg"
                          aria-label="Schedule options"
                          aria-haspopup="dialog"
                          aria-expanded={scheduleOpen !== null}
                          data-schedule-chevron=""
                          className="w-11 shrink-0 rounded-l-none px-0"
                          onClick={() =>
                            scheduleOpen !== null ? setScheduleOpen(null) : openSchedule()
                          }
                        >
                          <IconChevronDown size={16} />
                        </Button>
                      </span>
                    </>
                  ) : null}
                </div>
              )}
            </>
          )}
        </div>

        <input
          ref={photoInputRef}
          type="file"
          multiple
          accept={menuItems.find((item) => item.id === 'photo')?.accept}
          className="sr-only"
          onChange={(event) => {
            addFiles(event.target.files, true);
            event.target.value = '';
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={menuItems.find((item) => item.id === 'file')?.accept}
          className="sr-only"
          onChange={(event) => {
            addFiles(event.target.files, false);
            event.target.value = '';
          }}
        />

        <PostPicker
          open={picker !== null && picker !== 'assets'}
          onClose={() => setPicker(null)}
          mode={sheetMode}
          selected={sharedPosts}
          onToggle={toggleSharedPost}
          selectedBriefs={sharedBriefs}
          onToggleBrief={toggleSharedBrief}
          sharedPostIds={props.sharedPostIds}
          channelHasClient={props.channelHasClient ?? null}
        />
        <AssetPicker
          open={picker === 'assets'}
          onClose={() => setPicker(null)}
          onConfirm={addLibrary}
        />
        {scheduleSurface}
      </form>
    </>
  );
}

/** A library pick's chip thumb: the image through the shared presign cache, else the file glyph. */
function LibraryThumb(props: { attachment: MessageAttachment }): ReactElement {
  const image = classifyAttachment(props.attachment.mime) === 'image';
  return (
    <Thumbnail
      assetVersionId={image ? props.attachment.assetId : null}
      cache={sharedCardPresignCache()}
      presignEnabled={PRESIGN_ENABLED}
      fallback={{ kind: 'glyph' }}
      alt={props.attachment.name}
    />
  );
}

/** Title-case a stage value for its chip meta (stage strings come from the Row). */
function stageLabel(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}
