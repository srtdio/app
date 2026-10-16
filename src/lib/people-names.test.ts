import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FORMER_MEMBER,
  listenForNameSignout,
  personAvatar,
  personMentionLabel,
  personName,
  resetMentionNames,
  mentionIds,
  resolvePersonMentionText,
} from '@/lib/chat/mentions';
import { resolvePeople, type PeopleRead } from '@/lib/people-names';
import { SIGNOUT_EVENT } from '@/lib/events';
import type { Client } from '@srtdio/rpc';

const client = {} as unknown as Client;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const read =
  (
    rows: Array<{ id: string; name: string; member: boolean | null; username?: string }>,
  ): PeopleRead =>
  async (ids) => ({
    ok: true,
    data: rows
      .filter((r) => ids.includes(r.id))
      .map((r) => ({
        userId: r.id,
        displayName: r.name,
        avatarUrl: `https://cdn/${r.id}.png`,
        username: r.username ?? null,
        member: r.member,
      })),
  });

afterEach(() => resetMentionNames());

describe('shared people names', () => {
  it('a current member reads full name outside mentions and @username inside', async () => {
    await resolvePeople(
      client,
      'w1',
      [A],
      read([{ id: A, name: 'Ada King', member: true, username: 'ada.k' }]),
    );
    expect(personName('w1', A)).toBe('Ada King');
    expect(personAvatar('w1', A)).toBe(`https://cdn/${A}.png`);
    expect(personMentionLabel('w1', A)).toBe('@ada.k');
  });

  it('a removed member (profile readable, no membership) reads "Former member" everywhere', async () => {
    await resolvePeople(client, 'w1', [B], read([{ id: B, name: 'Eve Real', member: false }]));
    expect(personName('w1', B)).toBe(FORMER_MEMBER);
    expect(personAvatar('w1', B)).toBeNull();
    expect(personMentionLabel('w1', B)).toBe(`@${FORMER_MEMBER}`);
  });

  it('a deleted user (no profile returned) reads "Former member"', async () => {
    await resolvePeople(client, 'w1', [B], read([]));
    expect(personName('w1', B)).toBe(FORMER_MEMBER);
  });

  it('reads only ids it does not know, in one batched call', async () => {
    const spy = vi.fn(
      read([
        { id: A, name: 'Ada', member: true },
        { id: B, name: 'Bo', member: true },
      ]),
    );
    await resolvePeople(client, 'w1', [A], spy);
    await resolvePeople(client, 'w1', [A, B, A], spy);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[0]).toEqual([B]);
  });

  it('a failed read resolves nobody and retries next time', async () => {
    const failing: PeopleRead = async () => ({
      ok: false,
      error: { code: 'unknown', message: 'x' },
    });
    expect(await resolvePeople(client, 'w1', [A], failing)).toBe(false);
    expect(personName('w1', A)).toBeUndefined();
    expect(
      await resolvePeople(client, 'w1', [A], read([{ id: A, name: 'Ada', member: true }])),
    ).toBe(true);
    expect(personName('w1', A)).toBe('Ada');
  });

  it('names are per workspace', async () => {
    await resolvePeople(client, 'w1', [A], read([{ id: A, name: 'Ada', member: true }]));
    expect(personName('w2', A)).toBeUndefined();
  });

  it('sign-out clears the names, so a second account on the same tab never sees them', async () => {
    const tab = new EventTarget();
    const off = listenForNameSignout(tab);
    await resolvePeople(client, 'w1', [A], read([{ id: A, name: 'Ada', member: true }]));
    expect(personName('w1', A)).toBe('Ada');
    tab.dispatchEvent(new Event(SIGNOUT_EVENT));
    expect(personName('w1', A)).toBeUndefined();
    // The second account reads afresh: what it learns is its own.
    await resolvePeople(client, 'w1', [A], read([{ id: A, name: 'Ada', member: false }]));
    expect(personName('w1', A)).toBe(FORMER_MEMBER);
    off();
  });
});

describe('hand-typed tokens (PlanItemScreen)', () => {
  it('resolve to @username after one batched read; a former member reads "@Former member"', async () => {
    const spy = vi.fn(
      read([
        { id: A, name: 'Ada King', member: true, username: 'ada.k' },
        { id: B, name: 'Eve Real', member: false },
      ]),
    );
    const body = `hi @[${A}] and @[${B}]`;
    await resolvePeople(client, 'w1', mentionIds(body), spy);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(resolvePersonMentionText(body, 'w1')).toBe('hi @ada.k and @Former member');
  });

  it('never renders "Unknown member" or a raw token, even before the read', () => {
    const out = resolvePersonMentionText(`hi @[${A}]`, 'w1');
    expect(out).not.toMatch(/Unknown member|@\[/);
  });
});
