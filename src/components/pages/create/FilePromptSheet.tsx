// The soft file prompt: a small bottom sheet over the create sheet asking
// whether to keep a file the format does not usually carry. Never blocks: Yes
// keeps it, No removes it, Esc or a tap outside keeps it. Esc is caught in the
// capture phase so it never also closes the create sheet underneath. Motion
// (docs/motion.md, rise): rendered at rest, it rises on phone with the dim
// tracking it, and grows 95% to 100% on laptop. Never a fade.

import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import type { FilePrompt } from '@/components/pages/create/file-kind';
import { useModalFocus } from '@/lib/modal-focus';
import { dialogIn, riseIn, useMoveOnMount } from '@/lib/motion';
import { dimWith } from '@/lib/motion/overlays';
import { useIsLaptop } from '@/lib/use-is-laptop';

interface FilePromptSheetProps {
  prompt: FilePrompt;
  onKeep: () => void;
  onRemove: () => void;
}

export function FilePromptSheet({ prompt, onKeep, onRemove }: FilePromptSheetProps): ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);
  const dimRef = useRef<HTMLDivElement>(null);
  const isLaptop = useIsLaptop();
  useMoveOnMount(panelRef, (el) => {
    if (isLaptop) return dialogIn(el);
    return dimWith(el, dimRef.current, riseIn(el));
  });
  const keepRef = useRef<HTMLDivElement>(null);
  const onKeepRef = useRef(onKeep);
  onKeepRef.current = onKeep;

  // Focus lands on Keep, Tab stays inside, and the create sheet's control gets
  // focus back when the prompt goes (shared modal focus; it traps as the top layer).
  useModalFocus(panelRef, true, { initial: () => keepRef.current?.querySelector('button') });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onKeepRef.current();
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-dialog flex items-end justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:items-center"
      onClick={(event) => {
        if (event.target === event.currentTarget) onKeep();
      }}
    >
      {/* The dim: full scrim at rest, tracking the box per frame on phone. */}
      <div
        ref={dimRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-scrim"
      />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-label="Check the file"
        tabIndex={-1}
        className="relative w-full max-w-sm rounded-2xl border bg-panel p-6 lit-overlay outline-none will-change-transform"
      >
        <p className="text-base text-fg">{prompt.question}</p>
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={onRemove}>{prompt.removeLabel}</Button>
          <div ref={keepRef}>
            <Button variant="primary" onClick={onKeep}>
              {prompt.keepLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
