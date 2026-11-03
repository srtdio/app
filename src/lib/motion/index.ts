// The motion module: the ONLY place in the app that animates (docs/motion.md,
// guard: src/__tests__/motion-rules.test.ts). Nine moves: push, growFromCard,
// rise, growFromTrigger, press, itemIn/itemOut, glide, edgeStrip, sweepBoxes.
// Never fade (opacity never animates; the sheet dim tracks the sheet). Every
// move declares its axis, uses motion tokens, is interruptible (any tap or key
// press finishes it), and is instant under Reduce Motion or ?motion=0.
export * from './tokens';
export * from './preference';
export * from './run';
export * from './moves';
export * from './react';
export * from './touches';
export * from './pages';
