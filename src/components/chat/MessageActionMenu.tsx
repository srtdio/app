import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { ActionRow } from '@/components/ui';
import { IconCopy, IconReply } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

/** Quick-react row offered when a message's action menu is opened. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

interface MessageActionMenuProps {
  open: boolean;
  onClose: () => void;
  anchor: DOMRect | null;
  mine: boolean;
  currentReaction: string | null;
  canCopy: boolean;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onCopy: () => void;
}

interface Coords {
  top: number;
  left: number;
}

/**
 * Floating, anchored action menu opened by long-press or right-click on a
 * message bubble. Renders into document.body via a portal (mirrors Sheet.tsx)
 * so it escapes the scrolling thread. Position is computed from the pressed
 * bubble's rect in a two-pass layout effect: the container is measured while
 * hidden, then placed above (or below when there is no room) and aligned to the
 * bubble's side. Closes on backdrop click, Escape, scroll, or resize. All
 * colours are design tokens, so light and dark stay at parity.
 */
export function MessageActionMenu(props: MessageActionMenuProps): ReactElement | null {
  const { open, onClose, anchor, mine, currentReaction, canCopy, onReact, onReply, onCopy } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<Coords | null>(null);
  const [shown, setShown] = useState(false);

  useLayoutEffect(() => {
    if (!open || anchor === null) {
      setCoords(null);
      return;
    }
    const el = containerRef.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    let top = anchor.top - height - 8;
    if (top < 8) {
      top = Math.min(anchor.bottom + 8, window.innerHeight - height - 8);
    }
    const rawLeft = mine ? anchor.right - width : anchor.left;
    const left = Math.max(8, Math.min(rawLeft, window.innerWidth - width - 8));
    setCoords({ top, left });
  }, [open, anchor, mine]);

  // Entrance motion: flip to the shown state after the menu mounts so the
  // opacity + scale transition runs (no translate, no rotate).
  useEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [open, onClose]);

  if (!open || anchor === null) return null;

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={containerRef}
        className={cn(
          'fixed z-50 flex flex-col gap-2 transition-[opacity,transform] duration-150',
          mine ? 'items-end' : 'items-start',
          shown ? 'opacity-100 scale-100' : 'opacity-0 scale-95',
        )}
        style={{
          top: coords?.top ?? 0,
          left: coords?.left ?? 0,
          visibility: coords === null ? 'hidden' : 'visible',
        }}
      >
        <div className="inline-flex gap-1 rounded-full border border-border-strong bg-panel p-1 shadow-2xl">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React ${emoji}`}
              onClick={() => {
                onReact(emoji);
                onClose();
              }}
              className={cn(
                'flex h-11 w-11 items-center justify-center rounded-full text-xl hover:bg-panel-2',
                emoji === currentReaction && 'bg-accent-soft',
              )}
            >
              <span aria-hidden="true">{emoji}</span>
            </button>
          ))}
        </div>
        <div className="min-w-[200px] rounded-xl border border-border-strong bg-panel p-1 shadow-2xl">
          <ActionRow
            icon={<IconReply />}
            label="Reply"
            onClick={() => {
              onReply();
              onClose();
            }}
          />
          {canCopy ? (
            <ActionRow
              icon={<IconCopy />}
              label="Copy"
              onClick={() => {
                onCopy();
                onClose();
              }}
            />
          ) : null}
        </div>
      </div>
    </>,
    document.body,
  );
}
