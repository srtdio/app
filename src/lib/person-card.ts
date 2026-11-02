// The person card's one open state and its pure routing rules. Any person
// photo, name or @mention renders through ui/PersonTrigger, which calls
// openPersonCard; the one host (ui/PersonCard's PersonCardHost, mounted once in
// the shell) reads this store and paints the card in the same frame. Nothing
// here reads the network: the card paints from what the trigger and the device
// already hold (src/lib/workspace-members.ts cache, the mention registry).

import { mark } from '@/lib/perf-marks';
import type { ChannelSummary } from '@/lib/chat-reads';
import { notesChannelId } from '@/lib/chat/notes';

/** The DM open failure toast (the chat @mention tap's copy, reused everywhere). */
export const MENTION_DM_FAILED = "Couldn't open that chat. Try again.";

/** What a trigger hands the card: the person and what the screen already shows for them. */
export interface PersonCardHint {
  userId: string;
  /** The name the screen shows; the card prefers the members cache when it holds one. */
  name?: string | null;
  avatarUrl?: string | null;
  username?: string | null;
  /** The screen already knows this person left (a former-member row). */
  former?: boolean;
}

export interface PersonCardRequest extends PersonCardHint {
  /** The tapped element's box (laptop popover anchor); null when unknown. */
  anchor: { top: number; left: number; right: number; bottom: number } | null;
  /** The tapped element, focused again when the card closes. */
  trigger: HTMLElement | null;
}

let current: PersonCardRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Open the card for one person (synchronous: the host paints it this frame). */
export function openPersonCard(request: PersonCardRequest): void {
  mark('person-card:open');
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
