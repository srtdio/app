// A concept's linked post (plan_concept_link_post): the POST line, the pair
// dedupe, the counts (a pair once), soft-deleted and client-hidden posts, the
// link gate and the refusal copy. Pure helpers only.

import { describe, expect, it } from 'vitest';
import {
  DRAFT_NOT_READY,
  LINK_ALREADY_LINKED,
  LINK_NOT_APPROVED,
  POST_NOT_MADE_LABEL,
  canLinkPost,
  linkErrorCopy,
  linkedPost,
  pairedPostItemIds,
  planHeaderCounts,
  planProgress,
  postItemOf,
  postLine,
  postLineLabel,
  withoutPairedPosts,
} from '@/components/chat/plan-card';
import { assembleBundles, planPostIds } from '@/lib/chat/plans';
import type { PlanBundle, PlanItemRow, PlanReviewRow } from '@/lib/chat/plans';
import { calendarEntries, planCardMeta, postStageLine } from '@/lib/plan-tab';

const PLAN = {
  id: 'plan',
  workspace_id: 'ws',
  title: 'Pre and post Diwali',
  starts_on: '2026-11-02',
  ends_on: '2026-11-08',
  audience: 'client' as const,
  created_by: null,
};

function item(over: Partial<PlanItemRow>): PlanItemRow {
  return {
    id: 'i',
    plan_id: 'plan',
    kind: 'concept',
    position: 0,
    title: 'Concept',
    description: null,
    post_id: null,
    created_at: '2026-11-01T10:00:00Z',
    ...over,
  };
}

const concept = item({
  id: 'c1',
  title: 'Farmers',
  target_date: '2026-11-06',
  linked_post_id: 'pA',
});
const postItemA = item({ id: 'iA', kind: 'post', title: null, post_id: 'pA' });
const otherConcept = item({ id: 'c2', title: 'Diyas', target_date: '2026-11-05' });

function bundle(over: Partial<PlanBundle> = {}): PlanBundle {
  return {
    plan: PLAN,
    items: [otherConcept, concept, postItemA],
    reviews: [
      { item_id: 'c1', side: 'client', status: 'approved' },
      { item_id: 'iA', side: 'client', status: 'waiting' },
    ],
    postStages: { pA: 'review' },
    postInfo: { pA: { title: 'Farmers post', format: 'text', target_date: '2026-11-06' } },
    ...over,
  };
}

describe('linkedPost and postLine', () => {
  it('a linked concept reads the post stage by its POST line name, never "In review"', () => {
    const b = bundle();
    expect(linkedPost(b, concept, 'agency')).toMatchObject({
      kind: 'linked',
      postId: 'pA',
      stage: 'review',
    });
    expect(postLine(b, concept, 'agency')).toEqual({ label: 'Review', tone: 'review' });
    expect(postLine(b, concept, 'client')).toEqual({ label: 'Review', tone: 'review' });
    expect(postLineLabel('review')).toBe('Review');
  });

  it('an unlinked concept and a post item read as before', () => {
    const b = bundle();
    expect(postLine(b, otherConcept)).toEqual({ label: POST_NOT_MADE_LABEL, tone: 'none' });
    expect(postLine(b, postItemA)).toEqual({ label: 'Review', tone: 'review' });
    expect(linkedPost(b, postItemA, 'agency')).toEqual({ kind: 'none' });
  });

  it('a soft-deleted linked post reads as no link for everyone', () => {
    const b = bundle({ postStages: {}, postInfo: {}, deletedPosts: { pA: true } });
    expect(linkedPost(b, concept, 'agency')).toEqual({ kind: 'none' });
    expect(linkedPost(b, concept, 'client')).toEqual({ kind: 'none' });
    expect(postLine(b, concept, 'client').label).toBe(POST_NOT_MADE_LABEL);
  });

  it('a linked post the client cannot read (RLS hides drafts) reads "Not ready to view yet"', () => {
    const b = bundle({ items: [concept], postStages: {}, postInfo: {} });
    expect(linkedPost(b, concept, 'client')).toEqual({ kind: 'hidden', postId: 'pA' });
    expect(postLine(b, concept, 'client')).toEqual({ label: DRAFT_NOT_READY, tone: 'none' });
    // The agency always reads its posts: an absent one is no link.
    expect(linkedPost(b, concept, 'agency')).toEqual({ kind: 'none' });
  });
});

describe('the pair', () => {
  it('hides the post item the pair stands in for, and nothing else', () => {
    const b = bundle();
    expect([...pairedPostItemIds(b)]).toEqual(['iA']);
    const shown = withoutPairedPosts(b);
    expect(shown.items.map((i) => i.id)).toEqual(['c2', 'c1']);
    expect(shown.reviews.some((r) => r.item_id === 'iA')).toBe(false);
    // The full bundle keeps the item and its PLAN status (an unlink brings it back).
    expect(postItemOf(b, 'pA')?.id).toBe('iA');
    expect(b.reviews.find((r) => r.item_id === 'iA')?.status).toBe('waiting');
  });

  it('a deleted or unlinked post pairs nothing', () => {
    expect(pairedPostItemIds(bundle({ deletedPosts: { pA: true }, postStages: {} })).size).toBe(0);
    const unlinked = bundle({
      items: [otherConcept, { ...concept, linked_post_id: null }, postItemA],
    });
    expect(withoutPairedPosts(unlinked).items.map((i) => i.id)).toEqual(['c2', 'c1', 'iA']);
  });
});

describe('counts with a pair', () => {
  it('the header counts a pair once on PLAN and once on POST', () => {
    const b = bundle();
    expect(planHeaderCounts(b, 'agency')).toEqual({
      plan: { ok: 1, n: 2 },
      post: { approved: 0, n: 1 },
    });
    const approved = bundle({ postStages: { pA: 'approved' } });
    expect(planHeaderCounts(approved, 'agency').post).toEqual({ approved: 1, n: 1 });
  });

  it('a linked post that is not a post item still counts once on POST', () => {
    const b = bundle({ items: [otherConcept, concept] });
    expect(planHeaderCounts(b, 'agency')).toEqual({
      plan: { ok: 1, n: 2 },
      post: { approved: 0, n: 1 },
    });
  });

  it('after unlink the post item counts again with its own PLAN status', () => {
    const b = bundle({ items: [otherConcept, { ...concept, linked_post_id: null }, postItemA] });
    expect(planHeaderCounts(b, 'agency')).toEqual({
      plan: { ok: 1, n: 3 },
      post: { approved: 0, n: 1 },
    });
  });

  it('a client-hidden link counts as a post that is not approved', () => {
    const b = bundle({ items: [concept], postStages: {}, postInfo: {} });
    expect(planHeaderCounts(b, 'client').post).toEqual({ approved: 0, n: 1 });
  });

  it('the bar and Plan tab progress count a pair once', () => {
    expect(planProgress(bundle()).total).toBe(2);
    expect(planCardMeta(bundle())).toMatchObject({ kind: 'shared', total: 2, ok: 1 });
  });

  it('the calendar shows one chip per pair, the concept with the post stage', () => {
    const b = bundle();
    const entries = calendarEntries({
      bundles: [b],
      posts: [],
      tones: new Map(),
      timeZone: 'UTC',
      filter: null,
      titleOf: (_b, i) => i.title ?? 'Post',
      dayOfPost: () => null,
    });
    const keys = [...entries.values()].flat().map((e) => e.key);
    expect(keys).toContain('item:c1');
    expect(keys).not.toContain('item:iA');
    expect(postStageLine(b, concept)).toBe('Post: In review');
  });
});

describe('the link gate and refusals', () => {
  const reviews = (status: 'approved' | 'waiting'): PlanReviewRow[] => [
    { item_id: 'c1', side: 'client', status },
  ];

  it('only the agency links, and only on an approved concept', () => {
    expect(canLinkPost(bundle(), concept, 'agency')).toBe(true);
    expect(canLinkPost(bundle(), concept, 'client')).toBe(false);
    expect(canLinkPost(bundle({ reviews: reviews('waiting') }), concept, 'agency')).toBe(false);
    expect(
      canLinkPost(bundle({ reviews: reviews('waiting') }), concept, 'agency', { team: 'approved' }),
    ).toBe(true);
    expect(canLinkPost(bundle(), postItemA, 'agency')).toBe(false);
  });

  it('maps the two refusals by name, else the fallback', () => {
    expect(linkErrorCopy('concept_not_approved', 'x')).toBe(LINK_NOT_APPROVED);
    expect(linkErrorCopy('post_already_linked', 'x')).toBe(LINK_ALREADY_LINKED);
    expect(linkErrorCopy('something else', "Couldn't save. Try again.")).toBe(
      "Couldn't save. Try again.",
    );
  });
});

describe('assembling a bundle with a linked post', () => {
  it('folds a linked post into postStages and postInfo, and a deleted one into deletedPosts', () => {
    const items = [concept, otherConcept];
    expect(planPostIds(items)).toEqual(['pA']);
    const live = assembleBundles(
      [PLAN],
      items,
      [],
      [{ id: 'pA', stage: 'approved', title: 'Farmers post', format: 'text', target_date: null }],
    ).get('plan');
    expect(live?.postStages).toEqual({ pA: 'approved' });
    expect(live?.postInfo.pA?.title).toBe('Farmers post');
    expect(live?.deletedPosts).toBeUndefined();
    const gone = assembleBundles(
      [PLAN],
      items,
      [],
      [{ id: 'pA', stage: 'approved', deleted: true }],
    ).get('plan');
    expect(gone?.postStages).toEqual({});
    expect(gone?.deletedPosts).toEqual({ pA: true });
  });
});
