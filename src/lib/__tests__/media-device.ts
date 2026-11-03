// Test helper: a matchMedia that answers the queries the app uses for one
// pretend device. Evaluates comma lists (OR) of parenthesised features (AND)
// for width, hover and pointer; anything else (prefers-*) is false.

export interface MediaDevice {
  width: number;
  /** A finger is the primary pointer: (hover: none) and (pointer: coarse). */
  touch: boolean;
}

export const PHONE: MediaDevice = { width: 390, touch: true };
export const TABLET_PORTRAIT: MediaDevice = { width: 820, touch: true };
export const TABLET_LANDSCAPE: MediaDevice = { width: 1180, touch: true };
/** An iPad with a trackpad attached, or a laptop window at iPad width. */
export const MOUSE_AT_TABLET_WIDTH: MediaDevice = { width: 820, touch: false };
export const LAPTOP: MediaDevice = { width: 1280, touch: false };

function feature(device: MediaDevice, name: string, value: string): boolean {
  const n = Number.parseFloat(value);
  switch (name) {
    case 'max-width':
      return device.width <= n;
    case 'min-width':
      return device.width >= n;
    case 'hover':
      return value === (device.touch ? 'none' : 'hover');
    case 'pointer':
      return value === (device.touch ? 'coarse' : 'fine');
    default:
      return false;
  }
}

/** Pure: does `query` match `device`. */
export function mediaMatchesDevice(device: MediaDevice, query: string): boolean {
  return query.split(',').some((part) => {
    const features = [...part.matchAll(/\(\s*([a-z-]+)\s*:\s*([^)]+?)\s*\)/g)];
    return (
      features.length > 0 &&
      features.every(([, name, value]) => feature(device, name ?? '', value ?? ''))
    );
  });
}

export interface FakeMediaQueryList {
  matches: boolean;
  media: string;
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
}

/** A matchMedia for `device`; `listeners` collects every 'change' listener added. */
export function matchMediaFor(
  device: () => MediaDevice,
  listeners: Array<{ media: string; fn: () => void }> = [],
): (query: string) => FakeMediaQueryList {
  return (query: string) => ({
    get matches() {
      return mediaMatchesDevice(device(), query);
    },
    media: query,
    addEventListener: (_type: string, fn: () => void) => {
      listeners.push({ media: query, fn });
    },
    removeEventListener: () => undefined,
  });
}
