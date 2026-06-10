import { useCallback, useState } from 'react';

// Generic, page-scoped sort preference. Persists the chosen value in
// localStorage under a per-page key so a sort survives reloads and navigation.
// Storage failures (private mode, quota) degrade silently to in-memory state.
// Kept free of any page-specific values so Pipeline/Briefs/Activity can adopt it.

const STORAGE_PREFIX = 'sorted:sort:';

export function useSort<T extends string>(
  pageKey: string,
  defaultValue: T,
): { value: T; setValue: (value: T) => void } {
  const storageKey = `${STORAGE_PREFIX}${pageKey}`;
  const [value, setValueState] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      return stored !== null && stored !== '' ? (stored as T) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  const setValue = useCallback(
    (next: T): void => {
      setValueState(next);
      try {
        window.localStorage.setItem(storageKey, next);
      } catch {
        // Persisting is best-effort; the in-memory value still updates.
      }
    },
    [storageKey],
  );

  return { value, setValue };
}
