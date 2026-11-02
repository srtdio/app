import { afterEach, describe, expect, it, vi } from 'vitest';
import { notesChannelId } from '@/lib/chat/notes';
import {
  MENTION_DM_FAILED,
  cachedDmChannelId,
  closePersonCard,
  openPersonCard,
  personCardAction,
  personCardSnapshot,
  personDmRoute,
  personFirstName,
  subscribePersonCard,
} from '@/lib/person-card';

const WS = '0190a000-0000-7000-8000-00000000a001';
const ME = '0190a000-0000-7000-8000-000000000001';
const PEER = '0190a000-0000-7000-8000-000000000002';
const LEO = '0190a000-0000-7000-8000-000000000003';
const DM = `dm__${WS}__${ME}__${PEER}`;

const roster = [
  { channelId: `group__${WS}__g1`, channelType: 'group' as const, peerUserId: null },
  { channelId: DM, channelType: 'dm' as const, peerUserId: PEER },
];

afterEach(() => {
  closePersonCard();
});

describe('personDmRoute', () => {
  it('me opens my Personal notes (notesChannelId)', () => {
    expect(personDmRoute({ userId: ME, me: ME, workspaceId: WS, roster })).toEqual({
      kind: 'open',
      channelId: notesChannelId(WS, ME),
    });
  });

  it('a DM already in the device list opens with no rpc', () => {
    expect(personDmRoute({ userId: PEER, me: ME, workspaceId: WS, roster })).toEqual({
      kind: 'open',
      channelId: DM,
    });
  });

  it('a person with no cached DM needs ensure', () => {
    expect(personDmRoute({ userId: LEO, me: ME, workspaceId: WS, roster })).toEqual({
      kind: 'ensure',
    });
  });

  it('no workspace: none', () => {
    expect(personDmRoute({ userId: PEER, me: ME, workspaceId: null, roster })).toEqual({
      kind: 'none',
    });
    expect(personDmRoute({ userId: PEER, me: ME, workspaceId: '', roster })).toEqual({
      kind: 'none',
    });
  });

  it('no session: never notes, the cache still answers', () => {
    expect(personDmRoute({ userId: PEER, me: null, workspaceId: WS, roster })).toEqual({
      kind: 'open',
      channelId: DM,
    });
  });
});

describe('cachedDmChannelId', () => {
  it('matches the DM peer case-insensitively and ignores groups', () => {
    expect(cachedDmChannelId(roster, PEER.toUpperCase())).toBe(DM);
    expect(cachedDmChannelId(roster, LEO)).toBeNull();
    expect(cachedDmChannelId([], PEER)).toBeNull();
  });
});

describe('personCardAction', () => {
  it('self beats removed; removed; else message', () => {
    expect(personCardAction({ userId: ME, me: ME, removed: true })).toBe('self');
    expect(personCardAction({ userId: LEO, me: ME, removed: true })).toBe('removed');
    expect(personCardAction({ userId: LEO, me: ME, removed: false })).toBe('message');
    expect(personCardAction({ userId: LEO, me: null, removed: false })).toBe('message');
  });
});

describe('personFirstName', () => {
  it('first word of the name; blank stays blank', () => {
    expect(personFirstName('Leo Martins')).toBe('Leo');
    expect(personFirstName('  Priya   Raman ')).toBe('Priya');
    expect(personFirstName('')).toBe('');
    expect(personFirstName('   ')).toBe('');
  });
});

describe('the person card store', () => {
  it('open sets the snapshot and notifies; close clears it once', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePersonCard(listener);
    const request = { userId: LEO, name: 'Leo', anchor: null, trigger: null };
    openPersonCard(request);
    expect(personCardSnapshot()).toBe(request);
    expect(listener).toHaveBeenCalledTimes(1);
    closePersonCard();
    expect(personCardSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    // Already closed: no second notify.
    closePersonCard();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    openPersonCard(request);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('MENTION_DM_FAILED', () => {
  it('follows the error copy rule', () => {
    expect(MENTION_DM_FAILED).toBe("Couldn't open that chat. Try again.");
  });
});
