// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipVideo } from './ClipVideo';
import type { Clip } from './media';
import { preloadFor } from './useClipPlayer';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no media pipeline: give each video a scriptable readyState and
// currentTime, and record every currentTime write.
interface FakeMedia {
  readyState: number;
  currentTime: number;
  seeks: number[];
}
const media = new WeakMap<HTMLMediaElement, FakeMedia>();
function fake(el: HTMLMediaElement): FakeMedia {
  let state = media.get(el);
  if (!state) {
    state = { readyState: 0, currentTime: 0, seeks: [] };
    media.set(el, state);
  }
  return state;
}

type IOCallback = (entries: Partial<IntersectionObserverEntry>[]) => void;
const observers: { cb: IOCallback; targets: Element[]; disconnected: boolean }[] = [];
class FakeIO {
  private record: (typeof observers)[number];
  constructor(cb: IOCallback) {
    this.record = { cb, targets: [], disconnected: false };
    observers.push(this.record);
  }
  observe(el: Element): void {
    this.record.targets.push(el);
  }
  disconnect(): void {
    this.record.disconnected = true;
  }
}
function setVisible(video: HTMLVideoElement, ratio: number): void {
  for (const o of observers) {
    if (o.disconnected || !o.targets.includes(video)) continue;
    act(() => o.cb([{ target: video, isIntersecting: ratio > 0, intersectionRatio: ratio }]));
  }
}

let container: HTMLDivElement;
let root: Root;
const play = vi.fn(() => Promise.resolve());
const pause = vi.fn();

beforeEach(() => {
  observers.length = 0;
  play.mockClear();
  pause.mockClear();
  vi.stubGlobal('IntersectionObserver', FakeIO);
  const proto = HTMLMediaElement.prototype;
  vi.spyOn(proto, 'play').mockImplementation(play);
  vi.spyOn(proto, 'pause').mockImplementation(pause);
  vi.spyOn(proto, 'readyState', 'get').mockImplementation(function (this: HTMLMediaElement) {
    return fake(this).readyState;
  });
  vi.spyOn(proto, 'currentTime', 'get').mockImplementation(function (this: HTMLMediaElement) {
    return fake(this).currentTime;
  });
  vi.spyOn(proto, 'currentTime', 'set').mockImplementation(function (
    this: HTMLMediaElement,
    t: number,
  ) {
    const state = fake(this);
    state.currentTime = t;
    state.seeks.push(t);
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const clip: Clip = { src: 'https://cdn.test/c.mp4' };
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'home.css'), 'utf8');

function renderOne(c: Clip): HTMLVideoElement {
  act(() => root.render(<ClipVideo clip={c} label="clip" />));
  const video = container.querySelector('video');
  if (!video) throw new Error('no video');
  return video;
}

function fire(video: HTMLVideoElement, type: string): void {
  act(() => {
    video.dispatchEvent(new Event(type));
  });
}

describe('ClipVideo reveal', () => {
  it('stays hidden until loadeddata fires', () => {
    const video = renderOne(clip);
    expect(video.dataset.clip).toBe('pending');
    fake(video).readyState = 1;
    fire(video, 'loadedmetadata');
    expect(video.dataset.clip).toBe('pending');
    fake(video).readyState = 2;
    fire(video, 'loadeddata');
    expect(video.dataset.clip).toBe('ready');
  });

  it('hides pending clips in CSS and shows only ready ones', () => {
    expect(css).toMatch(/\.home video\[data-clip\]\s*{\s*opacity:\s*0;/);
    expect(css).toMatch(/\.home video\[data-clip='ready'\]\s*{\s*opacity:\s*1;/);
  });

  it('renders no poster, so only decoded frames can paint', () => {
    expect(renderOne(clip).hasAttribute('poster')).toBe(false);
  });

  it('loops natively', () => {
    expect(renderOne(clip).loop).toBe(true);
  });
});

describe('ClipVideo pause', () => {
  it('pauses in place without resetting currentTime', () => {
    const video = renderOne(clip);
    const state = fake(video);
    state.readyState = 2;
    fire(video, 'loadeddata');
    setVisible(video, 1);
    expect(play).toHaveBeenCalled();
    state.currentTime = 4.2;
    state.seeks.length = 0;
    setVisible(video, 0.1);
    expect(pause).toHaveBeenCalled();
    expect(state.currentTime).toBe(4.2);
    expect(state.seeks).toEqual([]);
    setVisible(video, 1);
    expect(state.currentTime).toBe(4.2);
    expect(state.seeks).toEqual([]);
    expect(video.dataset.clip).toBe('ready');
  });

  it('keeps the #530 autoplay attributes', () => {
    const video = renderOne(clip);
    expect(video.muted).toBe(true);
    expect(video.defaultMuted).toBe(true);
    expect(video.hasAttribute('muted')).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
  });

  it('cleans up its observer on unmount', () => {
    renderOne(clip);
    act(() => root.render(<></>));
    expect(observers.every((o) => o.disconnected)).toBe(true);
  });
});

describe('preload', () => {
  it('is auto for the active card and its neighbours, metadata for the rest', () => {
    expect([0, 1, 2, 3, 4].map((i) => preloadFor(i, [2]))).toEqual([
      'metadata',
      'auto',
      'auto',
      'auto',
      'metadata',
    ]);
    expect([0, 1, 2, 3, 4].map((i) => preloadFor(i, [0]))).toEqual([
      'auto',
      'auto',
      'metadata',
      'metadata',
      'metadata',
    ]);
  });

  function renderStack(count: number): HTMLVideoElement[] {
    act(() =>
      root.render(
        <div className="rail">
          {Array.from({ length: count }, (_, i) => (
            <article key={i} className="card">
              <div className="mock">
                <ClipVideo clip={clip} label={`clip ${i}`} />
              </div>
            </article>
          ))}
        </div>,
      ),
    );
    return [...container.querySelectorAll('video')];
  }

  it('preloads the first card and its neighbour before the stack is seen', () => {
    const videos = renderStack(5);
    expect(videos.map((v) => v.preload)).toEqual([
      'auto',
      'auto',
      'metadata',
      'metadata',
      'metadata',
    ]);
  });

  it('upgrades the new neighbours when the active card changes', () => {
    const videos = renderStack(5);
    const [, , third, fourth] = videos;
    if (!third || !fourth) throw new Error('missing videos');
    setVisible(third, 1);
    expect(videos.map((v) => v.preload)).toEqual(['metadata', 'auto', 'auto', 'auto', 'metadata']);
    setVisible(third, 0.2);
    setVisible(fourth, 1);
    expect(videos.map((v) => v.preload)).toEqual(['metadata', 'metadata', 'auto', 'auto', 'auto']);
    // Scrolled away: the stack stays warm around the last active card.
    setVisible(fourth, 0);
    expect(videos.map((v) => v.preload)).toEqual(['metadata', 'metadata', 'auto', 'auto', 'auto']);
  });

  it('loads a clip outside a card stack only while it is on screen', () => {
    const video = renderOne(clip);
    expect(video.preload).toBe('metadata');
    setVisible(video, 0.1);
    expect(video.preload).toBe('auto');
  });
});

describe('mockup box', () => {
  it('reserves the clip aspect ratio before the video loads', async () => {
    vi.stubEnv('VITE_SITE_MEDIA_URL', 'https://cdn.test/home');
    vi.resetModules();
    const { default: HomePage } = await import('./HomePage');
    act(() => root.render(<HomePage />));
    const boxes = [...container.querySelectorAll('.rail .clipbox')];
    expect(boxes).toHaveLength(5);
    for (const box of boxes) {
      const video = box.querySelector('video');
      expect(video?.dataset.clip).toBe('pending');
    }
    // The box gets its size from the row height and this ratio, never from the
    // video, so nothing moves when the video or fonts load.
    const rule = /\.home \.clipbox\s*{([^}]*)}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/aspect-ratio:\s*390\s*\/\s*720;/);
    expect(rule).toMatch(/height:\s*100%;/);
    expect(rule).toMatch(/max-height:\s*var\(--mock-max-h\);/);
  });
});
