import { afterEach, describe, expect, it, vi } from 'vitest';
import { notesChannelId } from '@/lib/chat/notes';
import {
  CONTEXT_WORDS,
  MENTION_DM_FAILED,
  OPEN_CHAT,
  cachedDmChannelId,
  messagePlaceholder,
  personContextLine,
  sentToTitle,
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

describe('personContextLine', () => {
  const where = 'Monday carousel';

  it('is null without a source', () => {
    expect(personContextLine(null)).toBeNull();
    expect(personContextLine(undefined)).toBeNull();
  });

  it('quotes the first words with an ellipsis only when words were cut', () => {
    expect(
      personContextLine({ whereLabel: where, excerpt: 'Love the new cover shot, ship it today please' }),
    ).toBe(`${where} · "Love the new cover shot, ship…"`);
    expect(CONTEXT_WORDS).toBe(6);
  });

  it('a short text is quoted whole, no ellipsis; newlines fold to spaces', () => {
    expect(personContextLine({ whereLabel: where, excerpt: 'Looks\n good' })).toBe(
      `${where} · "Looks good"`,
    );
  });

  it('the where half alone when there are no words; the quote alone when there is no where', () => {
    expect(personContextLine({ whereLabel: where, excerpt: '   ' })).toBe(where);
    expect(personContextLine({ whereLabel: '', excerpt: 'ship it' })).toBe('"ship it"');
    expect(personContextLine({ whereLabel: ' ', excerpt: '' })).toBeNull();
  });
});

describe('inline message copy (approved 2 Nov 2026)', () => {
  it('reads exactly', () => {
    expect(messagePlaceholder('Leo')).toBe('Message Leo…');
    expect(sentToTitle('Leo')).toBe('Sent to Leo');
    expect(OPEN_CHAT).toBe('Open chat');
  });
});

describe('openPersonCard view', () => {
  it('carries the view and source; a photo open marks person-photo:open', () => {
    const marks = vi.spyOn(performance, 'mark');
    openPersonCard({ userId: LEO, anchor: null, trigger: null, view: 'photo' });
    expect(personCardSnapshot()?.view).toBe('photo');
    expect(marks.mock.calls.map((c) => c[0])).toContain('person-photo:open');
    openPersonCard({ userId: LEO, anchor: null, trigger: null });
    expect(marks.mock.calls.map((c) => c[0])).toContain('person-card:open');
    marks.mockRestore();
  });
});
