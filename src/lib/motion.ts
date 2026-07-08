// Motion exit-timer durations in milliseconds. These mirror the --dur-fast /
// --dur-base / --dur-slow CSS tokens in src/index.css so the JS unmount timers
// stay in lockstep with the CSS transitions. src/lib/motion.test.ts reads the
// CSS from disk and fails if either side drifts. No runtime CSS reads here.
export const DUR_FAST_MS = 120;
export const DUR_BASE_MS = 160;
export const DUR_SLOW_MS = 200;
