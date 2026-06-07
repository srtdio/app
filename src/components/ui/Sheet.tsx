import { useEffect } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from '@/components/ui/IconButton';
import { IconX } from '@/components/ui/icons';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function Sheet({ open, onClose, title, children, footer }: SheetProps) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  if (!open) {
    return null;
  }

  function onOverlayClick(event: MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/45 flex items-end sm:items-center sm:justify-center"
      onClick={onOverlayClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-h-[90vh] rounded-t-2xl bg-panel border border-border-strong shadow-2xl flex flex-col overflow-hidden sm:w-[540px] sm:max-w-[92%] sm:max-h-[84vh] sm:rounded-xl"
      >
        <div className="flex items-center gap-2.5 px-[18px] py-[15px] border-b border-border">
          <h2 className="font-semibold text-[15px]">{title}</h2>
          <span className="ml-auto">
            <IconButton label="Close" onClick={onClose}>
              <IconX />
            </IconButton>
          </span>
        </div>
        <div className="px-[18px] py-4 overflow-y-auto">{children}</div>
        {footer !== undefined ? (
          <div className="flex items-center gap-2.5 px-[18px] py-3 border-t border-border">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
