import { afterEach, describe, expect, it } from 'vitest';
import { bellNameOf, bellPeopleIds } from '@/components/chat/BellContext';
import { EMPTY_BELL, messagePreview, type BellData, type BellMessage } from '@/lib/chat/bell';
import { rememberMentionRead, resetMentionNames } from '@/lib/chat/mentions';

// The chat bell names people through the shared helper: "Former member" only
// after a successful read confirmed they are not a current member; a current
// member whose name has not loaded (or whose read failed) names nobody yet.

const WS = 'w1';
const MEMBER = '11111111-1111-4111-8111-111111111111';
const GONE = '22222222-2222-4222-8222-222222222222';
const PENDING = '33333333-3333-4333-8333-333333333333';

const message = (body: string): BellMessage => ({
  id: 'm1',
  channelId: 'c1',
  senderUserId: PENDING,
  body,
  hasAttachments: false,
  hasPosts: false,
  hasBriefs: false,
});

afterEach(() => resetMentionNames());

describe('chat bell names', () => {
  it('collects every actor, sender and mentioned id once, for one batched read', () => {
    const data: BellData = {
      ...EMPTY_BELL,
      entries: [{ actorId: MEMBER } as BellData['entries'][number]],
      messages: new Map([['m1', message(`hi @[${GONE}] @[${MEMBER}]`)]]),
    };
    expect(bellPeopleIds(data).sort()).toEqual([MEMBER, GONE, PENDING].sort());
  });

  it('a current member with no name loaded is never "Former member"; a removed one is', () => {
    const nameOf = bellNameOf(WS, () => undefined);
    // Nothing read yet: nobody is named, no placeholder.
    expect(nameOf(PENDING)).toBeUndefined();
    expect(messagePreview(message(`ping @[${PENDING}]`), nameOf)).not.toContain('Former member');

    rememberMentionRead(
      WS,
      [MEMBER, GONE],
      [{ userId: MEMBER, displayName: 'Mia Member', member: true }],
    );
    const after = bellNameOf(WS, () => undefined);
    expect(after(MEMBER)).toBe('Mia Member');
    expect(after(GONE)).toBe('Former member');
    expect(messagePreview(message(`ping @[${GONE}] @[${MEMBER}]`), after)).toBe(
      'ping @Former member @Mia Member',
    );
    // Still unread: nothing extra.
    expect(after(PENDING)).toBeUndefined();
  });

  it('a removed member is never named by the chat fallback either', () => {
    rememberMentionRead(WS, [GONE], []);
    expect(bellNameOf(WS, () => 'Real Name')(GONE)).toBe('Former member');
  });
});
