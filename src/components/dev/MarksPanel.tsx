// The performance marks (src/lib/perf-marks.ts) on every signed-in route, for
// timing load paths on a real phone. Off by default: it shows only while the
// paint log is on (?paintlog=1, kept for the tab session; ?paintlog=0 turns it
// off), so no normal visit renders anything. Lists the first mark per name in
// ms since timeOrigin, re-read every 500 ms while open, with Copy and Clear.
// Tokens only.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import { formatMarks, paintLogOn } from '@/components/chat/PaintLog';
import { copyText } from '@/lib/clipboard';
import { useBottomInset } from '@/lib/bottom-inset';
import { clearMarks, readMarks } from '@/lib/perf-marks';

/** How often the list re-reads while open. */
const MARKS_REFRESH_MS = 500;

const BUTTON = 'min-w-[44px] shrink-0';

/** The panel, portalled to the body; nothing at all when the paint log is off. */
export function MarksPanel(): ReactElement | null {
  if (!paintLogOn() || typeof document === 'undefined') return null;
  return createPortal(<MarksStrip />, document.body);
}

function MarksStrip(): ReactElement {
  const [open, setOpen] = useState(true);
  const [marks, setMarks] = useState(() => readMarks({ firstOnly: true }));
  // Above every marked bottom bar (tab bar, composer), never over them.
  const inset = useBottomInset();
  useEffect(() => {
    if (!open) return;
    setMarks(readMarks({ firstOnly: true }));
    const timer = window.setInterval(
      () => setMarks(readMarks({ firstOnly: true })),
      MARKS_REFRESH_MS,
    );
    return () => window.clearInterval(timer);
  }, [open]);
  // copyText wraps the clipboard in its own try/catch and never rejects; no toast.
  const onCopy = (): void => {
    void copyText(formatMarks(readMarks({ firstOnly: true })));
  };
  const onClear = (): void => {
    clearMarks();
    setMarks(readMarks({ firstOnly: true }));
  };
  return (
    <div
      data-marks-panel=""
      style={{ bottom: inset }}
      className="fixed inset-x-0 z-[60] flex max-h-[40vh] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-panel text-fg shadow-2xl"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="flex-1 truncate text-sm font-semibold text-fg-2">
          {`Marks (${marks.length})`}
        </span>
        <Button type="button" variant="secondary" onClick={onCopy} className={BUTTON}>
          Copy
        </Button>
        <Button type="button" variant="ghost" onClick={onClear} className={BUTTON}>
          Clear
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen((v) => !v)} className={BUTTON}>
          {open ? 'Hide' : 'Show'}
        </Button>
      </div>
      {open ? (
        <ol className="min-h-0 flex-1 overflow-y-auto px-2 py-1 font-mono text-xs leading-4 tabular-nums">
          {marks.map((m) => (
            <li key={m.name} className="flex gap-2">
              <span className="min-w-0 flex-1 break-all">{m.name}</span>
              <span className="shrink-0 text-fg-3">{m.ms.toFixed(1)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
