// The five product features. The homepage rail cards and the sidebar tiles are
// both built from FEATURE_KEYS, so every tile has exactly one card to land on.

export const FEATURE_KEYS = ['chat', 'plan', 'pipeline', 'assets', 'briefs'] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

interface Feature {
  key: FeatureKey;
  /** Shown on the card label and the sidebar tile. */
  name: string;
  tone: string;
  clip: string;
  title: string;
  body: string;
  label: string;
  /** The sidebar tile's line under the name. */
  sub: string;
  /** The sidebar tile spans both columns. */
  wide?: boolean;
}

export const FEATURES: readonly Feature[] = [
  {
    key: 'chat',
    name: 'Chat',
    tone: 'c1',
    clip: 'chat',
    title: '“Who’s doing what?” It’s in the top bar.',
    body: 'The top bar keeps count of everything open in the chat: the plan, posts in review, briefs, commitments. Plus reminders, tasks, voice notes as text, and scheduled sends.',
    label: 'Walkthrough of Sorted chat',
    sub: 'Work chat per client',
  },
  {
    key: 'plan',
    name: 'Plan',
    tone: 'c2',
    clip: 'plan',
    title: '“Did they see the plan?” They ticked it.',
    body: "Share the plan into the chat. Your client ticks each post and idea, and the chat's top bar keeps the count.",
    label: 'Walkthrough of a Sorted plan',
    sub: 'The week, agreed',
  },
  {
    key: 'pipeline',
    name: 'Pipeline',
    tone: 'c3',
    clip: 'pipeline',
    title: '“Which one is final?” The one with the green tick.',
    body: 'Pin a comment right on the photo, numbered. Your client approves the post from the chat with a confirm step. One post at a time, never in bulk.',
    label: 'Walkthrough of the Sorted pipeline',
    sub: 'Draft to approved',
  },
  {
    key: 'assets',
    name: 'Assets',
    tone: 'c4',
    clip: 'assets',
    title: '“Can you send the logo again?” It never left.',
    body: 'Every photo, lookbook and campaign deck for the client in one place. Photos and PDFs open right inside Sorted.',
    label: 'Walkthrough of Sorted assets',
    sub: 'Files, versioned',
  },
  {
    key: 'briefs',
    name: 'Briefs',
    tone: 'c5',
    clip: 'briefs',
    title: '“Where’s the brief?” Pinned, with pictures.',
    body: 'Your client writes the brief in Sorted, photos and all. It stays exactly as written: Open while you work on it, Closed when it’s done.',
    label: 'Walkthrough of Sorted briefs',
    sub: 'Written by the client, photos and all',
    wide: true,
  },
];

/** The card's element id, and the hash a tile links to. */
export function featureId(key: FeatureKey): string {
  return `feature-${key}`;
}

/** The feature a "#feature-<key>" hash names, else null. Pure. */
export function featureFromHash(hash: string): FeatureKey | null {
  const match = /^#feature-([a-z]+)$/.exec(hash);
  if (match === null) return null;
  return FEATURE_KEYS.find((key) => key === match[1]) ?? null;
}

/**
 * Bring a feature card fully into view: the rail scrolls to the card, and the
 * page to the card's top less its scroll margin (the sticky header). Two
 * steps, because a nested scrollIntoView ignores the card's scroll margin for
 * the page.
 */
export function showFeature(key: FeatureKey, behavior: ScrollBehavior): void {
  const card = document.getElementById(featureId(key));
  if (card === null) return;
  card.scrollIntoView({ behavior, block: 'nearest', inline: 'start' });
  const margin = parseFloat(getComputedStyle(card).scrollMarginTop) || 0;
  const top = card.getBoundingClientRect().top + window.scrollY - margin;
  window.scrollTo({ top, behavior });
}
