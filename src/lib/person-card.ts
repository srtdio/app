// The person card's one open state and its pure routing rules. Any person
// photo, name or @mention renders through ui/PersonTrigger, which calls
// openPersonCard; the one host (ui/PersonCard's PersonCardHost, mounted once in
// the shell) reads this store and paints the card in the same frame. Nothing
// here reads the network: the card paints from what the trigger and the device
// already hold (src/lib/workspace-members.ts cache, the mention registry).

import { mark } from '@/lib/perf-marks';
import type { ChannelSummary } from '@/lib/chat-reads';
import { notesChannelId } from '@/lib/chat/notes';
import { privateReplyPreview, type PrivateReplyDraft } from '@/lib/chat/private-reply';
import { errorText } from '@/lib/error-copy';

/** The DM open failure toast (the chat @mention tap's copy, reused everywhere). */
export const MENTION_DM_FAILED = errorText('open that chat', null);

/** What a trigger hands the card: the person and what the screen already shows for them. */
export interface PersonCardHint {
  userId: string;
  /** The name the screen shows; the card prefers the members cache when it holds one. */
  name?: string | null;
  avatarUrl?: string | null;
  username?: string | null;
  /** The screen already knows this person left (a former-member row). */
  former?: boolean;
  /**
   * The comment or group chat message the tap came from (built at tap time
   * from what the row holds): the card's context line, and the quote its
   * send carries (chat_private_reply_send). Absent from Members, Pipeline,
   * Activity and author lines.
   */
  source?: PrivateReplyDraft | null;
}

/**
 * What a tap opens: the inline message card (default), or the photo-only
 * viewer (inside a DM only).
 */
export type PersonView = 'card' | 'photo';

export interface PersonCardRequest extends PersonCardHint {
  /** The tapped element's box (laptop popover anchor); null when unknown. */
  anchor: { top: number; left: number; right: number; bottom: number } | null;
  /** The tapped element, focused again when the card closes. */
  trigger: HTMLElement | null;
  /** Card or photo viewer; absent is the card. */
  view?: PersonView;
}

let current: PersonCardRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Open the card for one person (synchronous: the host paints it this frame). */
export function openPersonCard(request: PersonCardRequest): void {
  mark(request.view === 'photo' ? 'person-photo:open' : 'person-card:open');
  current = request;
  emit();
}

/** Close the card (no-op when closed). */
export function closePersonCard(): void {
  if (current === null) return;
  current = null;
  emit();
}

/** The open request, or null. */
export function personCardSnapshot(): PersonCardRequest | null {
  return current;
}

export function subscribePersonCard(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The card's one primary action for a person. Pure. */
export type PersonCardAction = 'message' | 'self' | 'removed';

export function personCardAction(input: {
  userId: string;
  me: string | null;
  /** True when the person is not an active member (members cache or the trigger said so). */
  removed: boolean;
}): PersonCardAction {
  if (input.me !== null && input.userId === input.me) return 'self';
  return input.removed ? 'removed' : 'message';
}

/** My DM with a person in the device's chat list, or null. Pure. */
export function cachedDmChannelId(
  roster: readonly Pick<ChannelSummary, 'channelId' | 'channelType' | 'peerUserId'>[],
  userId: string,
): string | null {
  const id = userId.toLowerCase();
  for (const row of roster) {
    if (row.channelType === 'dm' && row.peerUserId?.toLowerCase() === id) return row.channelId;
  }
  return null;
}

/**
 * Where a Message tap goes, decided without the network: my notes for me, the
 * cached DM when the device list holds it, else 'ensure' (startDmChannel). Pure.
 */
export type PersonDmRoute =
  | { kind: 'open'; channelId: string }
  | { kind: 'ensure' }
  | { kind: 'none' };

export function personDmRoute(input: {
  userId: string;
  me: string | null;
  workspaceId: string | null;
  roster: readonly Pick<ChannelSummary, 'channelId' | 'channelType' | 'peerUserId'>[];
}): PersonDmRoute {
  if (input.workspaceId === null || input.workspaceId === '') return { kind: 'none' };
  if (input.me !== null && input.userId === input.me) {
    return { kind: 'open', channelId: notesChannelId(input.workspaceId, input.me) };
  }
  const cached = cachedDmChannelId(input.roster, input.userId);
  return cached !== null ? { kind: 'open', channelId: cached } : { kind: 'ensure' };
}

/** The first word of a display name ("to <first name>"); blank stays blank. Pure. */
export function personFirstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? '';
}

/** How many of their words the context line quotes. */
export const CONTEXT_WORDS = 6;

/**
 * The card's context line: "<where> · "<first words of their text>…"", the
 * ellipsis only when words were cut; the where half alone when there are no
 * words, the quote alone when there is no where; null without a source. Pure.
 */
export function personContextLine(
  source: Pick<PrivateReplyDraft, 'whereLabel' | 'excerpt'> | null | undefined,
): string | null {
  if (source === null || source === undefined) return null;
  const words = privateReplyPreview(source.excerpt)
    .split(' ')
    .filter((w) => w !== '');
  const cut = words.length > CONTEXT_WORDS;
  const quote =
    words.length > 0 ? `"${words.slice(0, CONTEXT_WORDS).join(' ')}${cut ? '…' : ''}"` : '';
  const where = source.whereLabel.trim();
  if (where !== '' && quote !== '') return `${where} · ${quote}`;
  const line = where !== '' ? where : quote;
  return line !== '' ? line : null;
}

/** Approved copy (2 Nov 2026): the inline message card. */
export function messagePlaceholder(firstName: string): string {
  return `Message ${firstName}…`;
}
export function sentToTitle(firstName: string): string {
  return `Sent to ${firstName}`;
}
export const OPEN_CHAT = 'Open chat';
