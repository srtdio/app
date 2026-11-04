// In-memory fixtures for the concept link prototype. Nothing is read from or
// written to a server. One workspace (LinkedIn), one Open plan.

export type Stage = 'draft' | 'review' | 'approved' | 'parked' | 'rejected';
export type ReviewStatus = 'approved' | 'changes' | 'waiting';
export type Viewer = 'agency' | 'client';

export interface FixturePost {
  id: string;
  title: string;
  format: 'Text';
  /** Due date, a calendar day "YYYY-MM-DD" on the workspace zone. */
  dueDate: string;
  stage: Stage;
  caption: string;
}

export interface FixtureComment {
  id: string;
  author: string;
  body: string;
  /** Device-zone moment, pre-formatted for the mock. */
  time: string;
}

export interface FixtureConcept {
  kind: 'concept';
  id: string;
  title: string;
  description: string;
  day: string;
  /** The approvers' PLAN status (an Open plan: the client side). */
  plan: ReviewStatus;
  image: string | null;
  comments: FixtureComment[];
}

export interface FixturePostItem {
  kind: 'post';
  id: string;
  postId: string;
  day: string;
  /** The approvers' PLAN status on this post slot. Never changed by a link. */
  plan: ReviewStatus;
}

export type PlanItem = FixtureConcept | FixturePostItem;

export const WORKSPACE = { name: 'Cane & Co', platform: 'LinkedIn', timeZone: 'Asia/Kolkata' };

/** An Open plan (shared with approvers), 5 to 8 Nov. */
export const PLAN = {
  id: 'plan-diwali',
  title: 'Pre & Post Diwali',
  subtitle: 'Shared with approvers',
  startsOn: '2026-11-05',
  endsOn: '2026-11-08',
};

const FARMER_COMMENTS: FixtureComment[] = [
  { id: 'c1', author: 'Riya', body: 'Love this. Can we name the village in the first line?', time: '10:12 AM' },
  { id: 'c2', author: 'Kabir', body: 'Yes, Kolhapur. I have two quotes from the Patil family.', time: '10:40 AM' },
  { id: 'c3', author: 'Meera', body: 'Keep it under 120 words so it reads well on phone.', time: '11:05 AM' },
  { id: 'c4', author: 'Riya', body: 'Agreed. One photo of the cane field, no collage.', time: '11:18 AM' },
  { id: 'c5', author: 'Arjun', body: 'Approved on our side. Go ahead and write it.', time: '2:30 PM' },
  { id: 'c6', author: 'Kabir', body: 'Thanks. Draft goes up tomorrow morning.', time: '2:44 PM' },
];

export const CONCEPT_FARMERS: FixtureConcept = {
  kind: 'concept',
  id: 'concept-farmers',
  title: "The farmers behind Diwali's sweetness",
  description: 'Connect the sweets shared during Diwali with the farmers who grow the cane',
  day: '2026-11-06',
  plan: 'approved',
  image: 'cane-field.jpg',
  comments: FARMER_COMMENTS,
};

export const CONCEPT_DIYA: FixtureConcept = {
  kind: 'concept',
  id: 'concept-diya',
  title: 'Lighting diyas with the Pune team',
  description: 'A short team moment the evening before Diwali',
  day: '2026-11-05',
  plan: 'waiting',
  image: null,
  comments: [],
};

export const POSTS: readonly FixturePost[] = [
  {
    id: 'post-a',
    title: "The farmers behind Diwali's sweetness",
    format: 'Text',
    dueDate: '2026-11-06',
    stage: 'review',
    caption:
      'Every laddoo on your plate this Diwali starts in a cane field in Kolhapur. Meet the families who grow it.',
  },
  {
    id: 'post-b',
    title: 'Bhai Dooj: sweets from our cane fields',
    format: 'Text',
    dueDate: '2026-10-23',
    stage: 'approved',
    caption: 'This Bhai Dooj, share something made from cane grown by people we know by name.',
  },
  {
    id: 'post-c',
    title: 'Behind the scenes at the jaggery unit',
    format: 'Text',
    dueDate: '2026-11-12',
    stage: 'draft',
    caption: 'From juice to block in one long afternoon. A look inside our jaggery unit.',
  },
];

/** The plan's items in date order. Post A is already on the plan as its own row. */
export const ITEMS: readonly PlanItem[] = [
  CONCEPT_DIYA,
  CONCEPT_FARMERS,
  { kind: 'post', id: 'item-a', postId: 'post-a', day: '2026-11-06', plan: 'waiting' },
];

/** The only state this prototype changes: concept id to linked post id, or null. */
export type LinkState = Record<string, string | null>;

export const INITIAL_LINKS: LinkState = { [CONCEPT_FARMERS.id]: null, [CONCEPT_DIYA.id]: null };

export function postById(id: string | null): FixturePost | null {
  return POSTS.find((p) => p.id === id) ?? null;
}
