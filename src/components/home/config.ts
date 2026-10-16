// Book a demo settings: the one typed config the /demo form reads.

export const DEMO_HREF = '/demo';

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
