// Density (Compact / Cozy / Calm), decided 8 Nov 2026. One per account
// (users.density, read with the session profile); switched only in the account
// menu. Parts read it from <html data-density> through CSS (the compact: and
// calm: variants in tailwind.config.ts), never from a prop.
//
// First paint comes from the device: the last density is cached in
// localStorage and set on <html> synchronously at boot (src/main.tsx, before
// React paints), like the theme. No await and no read on any paint path; the
// server value reconciles silently after the profile read lands.

// No imports: main.tsx loads this statically for the boot attribute, so it
// stays out of the UI graph. use-fill-count notices a changed attribute itself.

export type Density = 'compact' | 'cozy' | 'calm';
export const DENSITIES: readonly Density[] = ['compact', 'cozy', 'calm'];
export const DEFAULT_DENSITY: Density = 'cozy';

/** The last density this device painted (any account): the boot value. */
export const DENSITY_KEY = 'sorted-density';
/** Per-account cache: `${DENSITY_USER_KEY}${userId}`. */
export const DENSITY_USER_KEY = 'sorted-density:';

export function isDensity(value: unknown): value is Density {
  return value === 'compact' || value === 'cozy' || value === 'calm';
}

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the attribute still applies for this load */
  }
}

/** The density on <html> now (Cozy when unset or outside a browser). */
export function activeDensity(): Density {
  if (typeof document === 'undefined') return DEFAULT_DENSITY;
  const value = document.documentElement.dataset.density;
  return isDensity(value) ? value : DEFAULT_DENSITY;
}

/**
 * Set <html data-density>. A change mid-session makes the next getFillCount
 * read the count once for the new row height (src/lib/use-fill-count; no
 * listener). Sync.
 */
export function applyDensity(density: Density): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.density = density;
}

/** Boot: the device's last density onto <html> before React paints. Sync, no read. */
export function bootDensity(): Density {
  const cached = readStore(DENSITY_KEY);
  const density = isDensity(cached) ? cached : DEFAULT_DENSITY;
  applyDensity(density);
  return density;
}

/** Save `density` as this device's boot value and this account's cache. */
export function cacheDensity(userId: string | null, density: Density): void {
  writeStore(DENSITY_KEY, density);
  if (userId !== null) writeStore(`${DENSITY_USER_KEY}${userId}`, density);
}

/** Accounts that set density on this device since boot: the server value never overrides it. */
const localWriteFor = new Set<string>();

/**
 * A session for `userId` is known: apply this account's cached density (a
 * different account may have painted the boot value). Sync, device only.
 */
export function adoptUserDensity(userId: string): void {
  const cached = readStore(`${DENSITY_USER_KEY}${userId}`);
  if (!isDensity(cached)) return;
  writeStore(DENSITY_KEY, cached);
  applyDensity(cached);
}

/**
 * The profile read landed with the server density: cache and apply it,
 * silently, after paint. A local pick made this session wins (its save is in
 * flight or done).
 */
export function reconcileDensity(userId: string, server: unknown): void {
  if (!isDensity(server) || localWriteFor.has(userId)) return;
  cacheDensity(userId, server);
  applyDensity(server);
}

/**
 * The account menu pick: apply and cache at once (optimistic). Returns the
 * previous density so a failed save can revert with revertDensity.
 */
export function setDensityLocal(userId: string | null, density: Density): Density {
  const previous = activeDensity();
  if (userId !== null) localWriteFor.add(userId);
  cacheDensity(userId, density);
  applyDensity(density);
  return previous;
}

/** A failed save: back to the previous density (attribute and cache). */
export function revertDensity(userId: string | null, previous: Density): void {
  cacheDensity(userId, previous);
  applyDensity(previous);
}

/** Tests only. */
export function resetDensityForTest(): void {
  localWriteFor.clear();
  if (typeof document !== 'undefined') delete document.documentElement.dataset.density;
}
