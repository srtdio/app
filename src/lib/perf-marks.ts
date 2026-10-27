// Performance marks for load paths. mark() drops a named User Timing mark;
// readMarks() lists them in ms since timeOrigin for the ?paintlog=1 panel
// (src/components/chat/PaintLog.tsx). Both never throw and no-op where the
// User Timing API is missing. No imports, so any module can call them.

/** Drop one named mark. A no-op without performance.mark; never throws. */
export function mark(name: string): void {
  try {
    if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
    performance.mark(name);
  } catch {
    // Marks are best effort.
  }
}

/** Every mark so far, in ms since timeOrigin (1 decimal), oldest first. Empty on any error. */
export function readMarks(): { name: string; ms: number }[] {
  try {
    return performance
      .getEntriesByType('mark')
      .map((entry) => ({ name: entry.name, ms: Math.round(entry.startTime * 10) / 10 }))
      .sort((a, b) => a.ms - b.ms);
  } catch {
    return [];
  }
}
