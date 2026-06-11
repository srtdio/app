import type { ToastItem } from '@/components/pages/assets/useToasts';

interface ToastsProps {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}

/** Bottom-centered, themed toast stack rendered above the lightbox (z-[60]). */
export function Toasts({ toasts, onDismiss }: ToastsProps) {
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[72px] z-[60] flex flex-col items-center gap-2 px-3 md:bottom-6"
    >
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => onDismiss(toast.id)}
          className="pointer-events-auto max-w-sm rounded-lg border border-border bg-panel px-4 py-2.5 text-sm text-fg shadow-lg"
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}
