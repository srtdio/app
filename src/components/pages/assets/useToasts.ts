import { useCallback, useRef, useState } from 'react';

export interface ToastItem {
  id: number;
  message: string;
}

/**
 * Minimal ephemeral toast queue for the Assets surface (no shared toast system
 * exists yet). Each toast auto-dismisses after `timeout`ms; dismiss is also
 * exposed so a tap can clear one early.
 */
export function useToasts(timeout = 3200): {
  toasts: ToastItem[];
  push: (message: string) => void;
  dismiss: (id: number) => void;
} {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number): void => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (message: string): void => {
      const id = (seq.current += 1);
      setToasts((prev) => [...prev, { id, message }]);
      setTimeout(() => dismiss(id), timeout);
    },
    [dismiss, timeout],
  );

  return { toasts, push, dismiss };
}
