// Pricing plans and Book a demo settings: the one typed config the /pricing
// cards and the /demo form read. Copy here is approved word for word.

export interface PlanCta {
  label: string;
  href: string;
}

export interface Plan {
  name: string;
  audience: string;
  price: string;
  /** "per client / month"; null for a custom price. */
  unit: string | null;
  team: string;
  features: string;
  clients: string;
  cta: PlanCta;
}

export const SIGNUP_HREF = '/signup';
export const DEMO_HREF = '/demo';
export const PRICING_HREF = '/pricing';

const ALL_FEATURES = 'Chat, Plan, Pipeline, Assets, Catch-up';
const TRIAL_CTA: PlanCta = { label: 'Start 15 days free', href: SIGNUP_HREF };
const PER_CLIENT = 'per client / month';
const CLIENTS_FREE = 'Clients join free';

export const PLANS: readonly Plan[] = [
  {
    name: 'Solo',
    audience: 'For a freelancer',
    price: '₹499',
    unit: PER_CLIENT,
    team: '1 team member',
    features: ALL_FEATURES,
    clients: CLIENTS_FREE,
    cta: TRIAL_CTA,
  },
  {
    name: 'Studio',
    audience: 'For a small team',
    price: '₹749',
    unit: PER_CLIENT,
    team: 'Up to 4 team members',
    features: ALL_FEATURES,
    clients: CLIENTS_FREE,
    cta: TRIAL_CTA,
  },
  {
    name: 'Agency',
    audience: 'For a full account team',
    price: '₹999',
    unit: PER_CLIENT,
    team: 'Up to 8 team members',
    features: ALL_FEATURES,
    clients: CLIENTS_FREE,
    cta: TRIAL_CTA,
  },
  {
    name: 'Enterprise',
    audience: 'For large or many teams',
    price: 'Custom',
    unit: null,
    team: 'Unlimited team members',
    features: ALL_FEATURES,
    clients: 'Set up with you on a call',
    cta: { label: 'Book a demo', href: DEMO_HREF },
  },
];

/** The sidebar's Pricing hint: the lowest plan price. */
export const PRICING_HINT = 'from ₹499';

/** Book a demo: the call's slots, booking window and timezone. */
export const DEMO = {
  /** IANA zone the window and the weekday rule are computed in. */
  timeZone: 'Asia/Kolkata',
  timeZoneLabel: 'IST',
  durationLabel: '30 min',
  /** First bookable day, in days after today (IST). */
  firstDay: 1,
  /** Last bookable day, in days after today (IST). */
  lastDay: 30,
  slots: ['11:00 am', '12:30 pm', '3:00 pm', '4:30 pm', '6:00 pm'],
} as const;

export type DemoSlot = (typeof DEMO.slots)[number];
