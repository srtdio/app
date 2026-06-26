// Unit coverage: mention extraction and the recipient computation for every
// event in the EVENT MAP. Pure - the RecipientReader is faked, so no database
// is touched and every branch is exercised deterministically.

import { describe, expect, it } from 'vitest';
import {
  computeRecipients,
  extractMentions,
  type ChangeEvent,
  type RecipientReader,
  type Recipient,
} from '../../packages/inbox/src/index';

const U = {
  owner: '00000000-0000-0000-0000-0000000000a1',
  admin: '00000000-0000-0000-0000-0000000000a2',
  agency: '00000000-0000-0000-0000-0000000000a3',
  actor: '00000000-0000-0000-0000-0000000000a4',
  prior: '00000000-0000-0000-0000-0000000000a5',
  mention: '00000000-0000-0000-0000-0000000000a6',
  creator: '00000000-0000-0000-0000-0000000000a7',
  invitee: '00000000-0000-0000-0000-0000000000a8',
  ws: '00000000-0000-0000-0000-0000000000ff',
};

function reader(over: Partial<RecipientReader>): RecipientReader {
  return {
    postOwner: async () => null,
    briefCreatedBy: async () => null,
    commentAuthors: async () => [],
    membersByRole: async () => [],
    validateMembers: async (_ws, c) => [...c],
    ...over,
  };
}

/** Recipient user-ids at a given event_type. */
function ids(recs: Recipient[], eventType: string): Set<string> {
  return new Set(recs.filter((r) => r.eventType === eventType).map((r) => r.userId));
}
function tierOf(recs: Recipient[], eventType: string): string | undefined {
  return recs.find((r) => r.eventType === eventType)?.tier;
}

function comment(row: Record<string, unknown>): ChangeEvent {
  return { table: 'comments', type: 'INSERT', row: row as never };
}

describe('extractMentions', () => {
  it('returns [] for null / undefined / non-array', () => {
    expect(extractMentions(null)).toEqual([]);
    expect(extractMentions(undefined)).toEqual([]);
    expect(extractMentions('nope')).toEqual([]);
    expect(extractMentions(42)).toEqual([]);
  });

  it('reads a bare uuid array', () => {
    expect(extractMentions([U.owner, U.admin]).sort()).toEqual([U.owner, U.admin].sort());
  });

  it('reads { user_id } and { id } objects', () => {
    expect(extractMentions([{ user_id: U.owner }, { id: U.admin }]).sort()).toEqual(
      [U.owner, U.admin].sort(),
    );
  });

  it('reads a { user_ids: [...] } wrapper', () => {
    expect(extractMentions({ user_ids: [U.owner] })).toEqual([U.owner]);
  });

  it('drops non-uuid junk and dedupes', () => {
    expect(extractMentions(['not-a-uuid', 123, null, U.owner, U.owner, { x: 1 }])).toEqual([
      U.owner,
    ]);
  });
});

describe('computeRecipients - comments', () => {
  it('INSERT on a post: owner + prior authors + validated mentions, minus author; mentions also urgent', async () => {
    const event = comment({
      id: 'c1',
      workspace_id: U.ws,
      entity_type: 'post',
      entity_id: 'post1',
      author_user_id: U.actor,
      mentions: [U.mention, 'not-a-member-uuid'],
    });
    const recs = await computeRecipients(
      event,
      reader({
        postOwner: async () => U.owner,
        commentAuthors: async () => [U.prior, U.actor],
        validateMembers: async () => [U.mention], // non-member filtered out
      }),
    );
    expect(ids(recs, 'comment')).toEqual(new Set([U.owner, U.prior, U.mention]));
    expect(tierOf(recs, 'comment')).toBe('active');
    expect(ids(recs, 'mention')).toEqual(new Set([U.mention]));
    expect(tierOf(recs, 'mention')).toBe('urgent');
  });

  it('INSERT on a brief: creator + agency roles + mentions, minus author', async () => {
    const event = comment({
      id: 'c2',
      workspace_id: U.ws,
      entity_type: 'brief',
      entity_id: 'brief1',
      author_user_id: U.actor,
      mentions: null,
    });
    const recs = await computeRecipients(
      event,
      reader({
        briefCreatedBy: async () => U.creator,
        membersByRole: async () => [U.owner, U.admin, U.agency],
        commentAuthors: async () => [U.actor],
      }),
    );
    expect(ids(recs, 'comment')).toEqual(new Set([U.creator, U.owner, U.admin, U.agency]));
    expect(ids(recs, 'mention').size).toBe(0);
  });

  it('UPDATE flipping resolved_at -> set emits comment_resolved to the audience minus author', async () => {
    const event: ChangeEvent = {
      table: 'comments',
      type: 'UPDATE',
      row: {
        id: 'c3',
        workspace_id: U.ws,
        entity_type: 'post',
        entity_id: 'post1',
        author_user_id: U.actor,
        resolved_at: '2026-06-26T00:00:00Z',
      } as never,
      old: { resolved_at: null } as never,
    };
    const recs = await computeRecipients(
      event,
      reader({ postOwner: async () => U.owner, commentAuthors: async () => [U.prior, U.actor] }),
    );
    expect(ids(recs, 'comment_resolved')).toEqual(new Set([U.owner, U.prior]));
    expect(tierOf(recs, 'comment_resolved')).toBe('active');
  });

  it('UPDATE that does not change resolved_at emits nothing', async () => {
    const event: ChangeEvent = {
      table: 'comments',
      type: 'UPDATE',
      row: {
        id: 'c4',
        workspace_id: U.ws,
        entity_type: 'post',
        entity_id: 'p',
        author_user_id: U.actor,
        resolved_at: '2026-06-26T00:00:00Z',
      } as never,
      old: { resolved_at: '2026-06-26T00:00:00Z' } as never,
    };
    expect(await computeRecipients(event, reader({}))).toEqual([]);
  });
});

describe('computeRecipients - posts stage_change', () => {
  function postUpdate(stage: string, oldStage: string, briefId: string | null): ChangeEvent {
    return {
      table: 'posts',
      type: 'UPDATE',
      row: {
        id: 'post1',
        workspace_id: U.ws,
        owner_user_id: U.owner,
        brief_id: briefId,
        stage,
      } as never,
      old: { stage: oldStage } as never,
    };
  }

  it('urgent for approved/rejected, to owner + admins/owner', async () => {
    const recs = await computeRecipients(
      postUpdate('approved', 'review', null),
      reader({ membersByRole: async () => [U.owner, U.admin] }),
    );
    expect(ids(recs, 'stage_change')).toEqual(new Set([U.owner, U.admin]));
    expect(tierOf(recs, 'stage_change')).toBe('urgent');
  });

  it('active for other stages, and includes brief.created_by when brief_id is set', async () => {
    const recs = await computeRecipients(
      postUpdate('review', 'draft', 'brief1'),
      reader({ membersByRole: async () => [U.admin], briefCreatedBy: async () => U.creator }),
    );
    expect(ids(recs, 'stage_change')).toEqual(new Set([U.owner, U.creator, U.admin]));
    expect(tierOf(recs, 'stage_change')).toBe('active');
  });

  it('no stage change -> nothing', async () => {
    const recs = await computeRecipients(postUpdate('review', 'review', null), reader({}));
    expect(recs).toEqual([]);
  });

  it('excludes a null owner_user_id (ex-member) from recipients', async () => {
    const event: ChangeEvent = {
      table: 'posts',
      type: 'UPDATE',
      row: {
        id: 'post1',
        workspace_id: U.ws,
        owner_user_id: null,
        brief_id: null,
        stage: 'review',
      } as never,
      old: { stage: 'draft' } as never,
    };
    const recs = await computeRecipients(event, reader({ membersByRole: async () => [U.admin] }));
    expect(ids(recs, 'stage_change')).toEqual(new Set([U.admin]));
  });
});

describe('computeRecipients - briefs / assets / members', () => {
  it('brief INSERT -> brief_created to agency roles', async () => {
    const event: ChangeEvent = {
      table: 'briefs',
      type: 'INSERT',
      row: { id: 'brief1', workspace_id: U.ws, title: 'T', created_by: U.creator } as never,
    };
    const recs = await computeRecipients(
      event,
      reader({ membersByRole: async () => [U.owner, U.admin, U.agency] }),
    );
    expect(ids(recs, 'brief_created')).toEqual(new Set([U.owner, U.admin, U.agency]));
    expect(tierOf(recs, 'brief_created')).toBe('active');
  });

  it('brief UPDATE -> closed adds created_by', async () => {
    const event: ChangeEvent = {
      table: 'briefs',
      type: 'UPDATE',
      row: {
        id: 'brief1',
        workspace_id: U.ws,
        title: 'T',
        status: 'closed',
        created_by: U.creator,
      } as never,
      old: { status: 'open' } as never,
    };
    const recs = await computeRecipients(event, reader({ membersByRole: async () => [U.agency] }));
    expect(ids(recs, 'brief_closed')).toEqual(new Set([U.agency, U.creator]));
  });

  it('brief UPDATE -> closed excludes a null created_by (ex-member)', async () => {
    const event: ChangeEvent = {
      table: 'briefs',
      type: 'UPDATE',
      row: {
        id: 'brief1',
        workspace_id: U.ws,
        title: 'T',
        status: 'closed',
        created_by: null,
      } as never,
      old: { status: 'open' } as never,
    };
    const recs = await computeRecipients(event, reader({ membersByRole: async () => [U.agency] }));
    expect(ids(recs, 'brief_closed')).toEqual(new Set([U.agency]));
  });

  it('asset INSERT -> asset_uploaded to agency roles', async () => {
    const event: ChangeEvent = {
      table: 'assets',
      type: 'INSERT',
      row: { id: 'asset1', workspace_id: U.ws, filename: 'f.png' } as never,
    };
    const recs = await computeRecipients(event, reader({ membersByRole: async () => [U.agency] }));
    expect(ids(recs, 'asset_uploaded')).toEqual(new Set([U.agency]));
  });

  it('asset_version INSERT emits only for version_number > 1', async () => {
    const mk = (n: number): ChangeEvent => ({
      table: 'asset_versions',
      type: 'INSERT',
      row: { id: `v${n}`, asset_id: 'asset1', workspace_id: U.ws, version_number: n } as never,
    });
    const r = reader({ membersByRole: async () => [U.agency] });
    expect(await computeRecipients(mk(1), r)).toEqual([]);
    expect(ids(await computeRecipients(mk(2), r), 'asset_version_added')).toEqual(
      new Set([U.agency]),
    );
  });

  it('workspace_members INSERT emits invite only for a pending (active=false) row', async () => {
    const mk = (active: boolean): ChangeEvent => ({
      table: 'workspace_members',
      type: 'INSERT',
      row: { id: 'm1', workspace_id: U.ws, user_id: U.invitee, role: 'client', active } as never,
    });
    expect(await computeRecipients(mk(true), reader({}))).toEqual([]);
    const recs = await computeRecipients(mk(false), reader({}));
    expect(ids(recs, 'invite')).toEqual(new Set([U.invitee]));
    expect(tierOf(recs, 'invite')).toBe('urgent');
  });
});
