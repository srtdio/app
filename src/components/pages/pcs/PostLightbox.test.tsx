import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  lightboxView,
  lightboxCounter,
  slideFromScroll,
  intrinsicSize,
  fitFrameStyle,
  pinPointFromRect,
  placePinFromEvent,
} from '@/components/pages/pcs/PostLightbox';
import type { LightboxViewProps, StageGestures } from '@/components/pages/pcs/PostLightbox';
import type { GalleryItem } from '@srtdio/posts';

// node test environment (no DOM renderer): walk the hookless lightboxView tree.

function flatten(node: ReactNode, out: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => flatten(child, out));
    return;
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return;
  const el = node as ReactElement;
  out.push(el);
  flatten((el.props as { children?: ReactNode }).children, out);
}

function elements(tree: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  flatten(tree, out);
  return out;
}

// Every string that would render as text anywhere in the tree.
function collectStrings(node: ReactNode, out: string[]): void {
  if (typeof node === 'string') {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => collectStrings(child, out));
    return;
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return;
  collectStrings(((node as ReactElement).props as { children?: ReactNode }).children, out);
}

function strings(tree: ReactNode): string[] {
  const out: string[] = [];
  collectStrings(tree, out);
  return out;
}

function byLabel(tree: ReactNode, value: string): ReactElement | undefined {
  return elements(tree).find(
    (el) => (el.props as { 'aria-label'?: string })['aria-label'] === value,
  );
}

function byLabelEq(el: ReactElement, value: string): boolean {
  return (el.props as { 'aria-label'?: string })['aria-label'] === value;
}

function className(el: ReactElement): string {
  return (el.props as { className?: string }).className ?? '';
}

function item(n: number, width: number | null = 1080, height: number | null = 1350): GalleryItem {
  return {
    assetAttachmentId: `aa-${n}`,
    assetVersionId: `ver-${n}`,
    assetId: `as-${n}`,
    position: n,
    filename: `secret-filename-${n}.png`,
    mimeType: 'image/png',
    kind: 'image',
    width,
    height,
    durationMs: null,
    r2Key: `r2/${n}`,
    externalUrl: null,
  };
}

const GESTURES: StageGestures = {
  onPointerDown: () => {},
  onPointerMove: () => {},
  onPointerUp: () => {},
  onPointerCancel: () => {},
  onClick: () => {},
};

const MANAGE = {
  onMakeFirst: () => {},
  onMoveLeft: () => {},
  onMoveRight: () => {},
  onMakeLast: () => {},
  onAddAfter: () => {},
  onRemove: () => {},
};

function props(overrides: Partial<LightboxViewProps> = {}): LightboxViewProps {
  return {
    items: [item(0), item(1), item(2)],
    index: 0,
    presignEnabled: true,
    chrome: true,
    busy: false,
    zoom: { scale: 1, x: 0, y: 0 },
    srcFor: (it) => `https://signed/${it.assetVersionId}`,
    failedFor: () => false,
    dimsFor: (it) =>
      it.width !== null && it.height !== null ? { width: it.width, height: it.height } : null,
    onClose: () => {},
    onPrev: () => {},
    onNext: () => {},
    onDownload: () => {},
    onTrackScroll: () => {},
    onImageLoad: () => {},
    stageGestures: GESTURES,
    ...overrides,
  };
}

describe('pure helpers', () => {
  it('formats the mono counter as "n / N"', () => {
    expect(lightboxCounter(0, 3)).toBe('1 / 3');
    expect(lightboxCounter(2, 3)).toBe('3 / 3');
  });

  it('derives the resting slide from scroll offset, clamped', () => {
    expect(slideFromScroll(0, 400, 3)).toBe(0);
    expect(slideFromScroll(390, 400, 3)).toBe(1);
    expect(slideFromScroll(9999, 400, 3)).toBe(2);
    expect(slideFromScroll(100, 0, 3)).toBe(0);
  });

  it('prefers stored asset dimensions, then the measured fallback', () => {
    expect(intrinsicSize(item(0, 800, 1000), {})).toEqual({ width: 800, height: 1000 });
    expect(intrinsicSize(item(0, null, null), {})).toBeNull();
    expect(intrinsicSize(item(0, null, null), { 'ver-0': { width: 3, height: 4 } })).toEqual({
      width: 3,
      height: 4,
    });
    // A zero stored dimension is unusable; the measured value wins.
    expect(intrinsicSize(item(0, 0, 100), { 'ver-0': { width: 3, height: 4 } })).toEqual({
      width: 3,
      height: 4,
    });
  });

  it('builds the fit frame as an aspect-ratio box', () => {
    expect(fitFrameStyle(1080, 1920)).toEqual({ aspectRatio: '1080 / 1920' });
  });

  it('keeps the pin geometry helpers pure and clamped (used by the gallery now)', () => {
    const rect = { left: 100, top: 50, width: 200, height: 100 };
    expect(pinPointFromRect(rect, 200, 100)).toEqual({ x: 0.5, y: 0.5 });
    expect(pinPointFromRect(rect, 50, 100)).toBeNull();
    const target = { getBoundingClientRect: vi.fn(() => rect) };
    expect(placePinFromEvent(target, 150, 75)).toEqual({ x: 0.25, y: 0.25 });
  });
});

describe('lightboxView', () => {
  it('never renders a filename anywhere on the surface', () => {
    const tree = lightboxView(props());
    const all = elements(tree);
    const text = strings(tree).join(' ');
    expect(text).not.toContain('secret-filename');
    for (const el of all) {
      const p = el.props as { alt?: string; 'aria-label'?: string; title?: string };
      expect(p.alt ?? '').not.toContain('secret-filename');
      expect(p['aria-label'] ?? '').not.toContain('secret-filename');
      expect(p.title ?? '').not.toContain('secret-filename');
    }
  });

  it('overlays only the mono counter and close on the image: no download, no caption toggle', () => {
    const tree = lightboxView(props({ index: 1 }));
    const close = byLabel(tree, 'Close viewer')!;
    expect(close).toBeDefined();
    expect(className(close)).toContain('h-11');
    expect(className(close)).toContain('w-11');
    // Close is overlaid at the top-right, not inside any chrome bar.
    expect(className(close)).toContain('absolute');
    expect(className(close)).toContain('top-2');
    expect(className(close)).toContain('right-2');
    // The counter is the mono position readout overlaid at the top-left.
    const counter = elements(tree).find(
      (el) => (el.props as { children?: ReactNode }).children === '2 / 3',
    );
    expect(counter).toBeDefined();
    expect(className(counter!)).toContain('font-mono');
    expect(className(counter!)).toContain('absolute');
    expect(className(counter!)).toContain('left-2');
    // No separate top chrome bar exists (nothing is h-12 + justify-between), and
    // download has moved into the action bar below the image.
    expect(
      elements(tree).some(
        (el) => className(el).includes('h-12') && className(el).includes('justify-between'),
      ),
    ).toBe(false);
    // The caption is gone end to end: no toggle button, no caption text.
    expect(byLabel(tree, 'Toggle caption')).toBeUndefined();
    expect(strings(tree)).not.toContain('Launch day walkthrough.');
  });

  it('renders in normal page flow, not as a fixed modal overlay', () => {
    const tree = lightboxView(props());
    // No dialog/modal semantics: the viewer is an in-flow region, not a modal.
    const root = elements(tree)[0]!;
    expect((root.props as { role?: string }).role).toBeUndefined();
    expect((root.props as { 'aria-modal'?: unknown })['aria-modal']).toBeUndefined();
    expect(elements(tree).some((el) => (el.props as { role?: string }).role === 'dialog')).toBe(
      false,
    );
    // The outer container is an in-flow, full-width block on the dark overlay
    // token; it is not a fixed inset-0 overlay and locks no scroll.
    expect((root.props as { 'aria-label'?: string })['aria-label']).toBe('Image viewer');
    expect(className(root)).toContain('relative');
    expect(className(root)).toContain('w-full');
    expect(className(root)).toContain('bg-overlay');
    expect(className(root)).not.toContain('fixed');
    expect(className(root)).not.toContain('inset-0');
    // No card chrome: no border, rounded box, surface fill, shadow, or blurred cover.
    for (const el of elements(tree)) {
      expect(className(el)).not.toContain('rounded-2xl');
      expect(className(el)).not.toContain('shadow-2xl');
      expect(className(el)).not.toContain('blur-[48px]');
    }
    expect(elements(tree).some((el) => className(el).includes('object-cover'))).toBe(false);
    // The image region is a full-width aspect-ratio box (the current item's ratio).
    const region = elements(tree).find(
      (el) =>
        (el.props as { style?: { aspectRatio?: string } }).style?.aspectRatio === '1080 / 1350',
    );
    expect(region).toBeDefined();
    expect(className(region!)).toContain('w-full');
  });

  it('introduces no translate or rotate motion anywhere on the surface', () => {
    for (const chrome of [true, false]) {
      const tree = lightboxView(props({ chrome }));
      for (const el of elements(tree)) {
        const cls = className(el);
        expect(cls).not.toMatch(/\btranslate-/);
        expect(cls).not.toMatch(/\brotate-/);
      }
    }
  });

  it('constrains the fit image against the fixed stage so it is fully visible', () => {
    const tree = lightboxView(props());
    const all = elements(tree);
    // The slide track and each stage are fixed/absolute boxes, never auto-height.
    const track = all.find((el) => className(el).includes('snap-x'))!;
    expect(className(track)).toContain('absolute inset-0');
    // Each fit frame (the boxes carrying max-w-full inside the stages) constrains
    // against the fixed stage so the whole image shows.
    const frames = all.filter(
      (el) =>
        (el.props as { style?: { aspectRatio?: string } }).style?.aspectRatio !== undefined &&
        className(el).includes('max-w-full'),
    );
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(className(frame)).toContain('max-h-full');
      expect(className(frame)).toContain('max-w-full');
    }
    // Nothing in fit mode scrolls: the whole image is always in view.
    expect(all.some((el) => className(el).includes('overflow-auto'))).toBe(false);
  });

  it('hides both bars when chrome is off and shows them when on, by opacity only', () => {
    const off = lightboxView(props({ chrome: false }));
    const hidden = elements(off).filter(
      (el) => className(el).includes('opacity-0') && className(el).includes('pointer-events-none'),
    );
    expect(hidden.length).toBeGreaterThanOrEqual(2);
    const on = lightboxView(props());
    expect(
      elements(on).some(
        (el) =>
          className(el).includes('opacity-100') && !className(el).includes('pointer-events-none'),
      ),
    ).toBe(true);
  });

  it('renders the agency 7-control bottom bar: reorder, divider, download/add/delete', () => {
    const manage = {
      onMakeFirst: vi.fn(),
      onMoveLeft: vi.fn(),
      onMoveRight: vi.fn(),
      onMakeLast: vi.fn(),
      onAddAfter: vi.fn(),
      onRemove: vi.fn(),
    };
    const tree = lightboxView(props({ index: 1, manage }));
    // The reorder + download + add controls fire their prewired handlers, and
    // every icon button is a 44px target.
    for (const [label, fn] of [
      ['Make first', manage.onMakeFirst],
      ['Move left', manage.onMoveLeft],
      ['Move right', manage.onMoveRight],
      ['Make last', manage.onMakeLast],
      ['Add image', manage.onAddAfter],
    ] as const) {
      const button = byLabel(tree, label)!;
      expect(button).toBeDefined();
      expect(className(button)).toContain('h-11');
      expect(className(button)).toContain('w-11');
      (button.props as { onClick: () => void }).onClick();
      expect(fn).toHaveBeenCalledOnce();
    }
    // Download now lives in the bottom bar next to add and delete.
    expect(byLabel(tree, 'Download')).toBeDefined();
    expect(byLabel(tree, 'Delete image')).toBeDefined();
    // Add keeps the accent token; delete hovers to the destructive token.
    expect(className(byLabel(tree, 'Add image')!)).toContain('text-accent');
    expect(className(byLabel(tree, 'Delete image')!)).toContain('hover:text-bad');
    // A subtle divider separates the reorder group from the actions.
    expect(elements(tree).some((el) => className(el).includes('bg-overlay-line'))).toBe(true);
  });

  it('shows only the download button in the bottom bar for clients and read-only', () => {
    const clientTree = lightboxView(props({ index: 1 }));
    expect(byLabel(clientTree, 'Download')).toBeDefined();
    // No edit actions render without a manage bar.
    expect(byLabel(clientTree, 'Make first')).toBeUndefined();
    expect(byLabel(clientTree, 'Move left')).toBeUndefined();
    expect(byLabel(clientTree, 'Add image')).toBeUndefined();
    expect(byLabel(clientTree, 'Delete image')).toBeUndefined();
    // Download sits inside the transparent bottom bar, not the top bar.
    const bottomBar = elements(clientTree).find(
      (el) => className(el).includes('h-12') && className(el).includes('justify-center'),
    )!;
    expect(className(bottomBar)).not.toContain('border-t');
    expect(className(bottomBar)).not.toContain('bg-overlay-surface');
    const inBottom = elements((bottomBar.props as { children?: ReactNode }).children);
    expect(inBottom.some((el) => byLabelEq(el, 'Download'))).toBe(true);
  });

  it('enables delete on a solo gallery and confirms it with the only-image copy', () => {
    // A single-image gallery: delete is enabled now (removing the last image is
    // allowed and empties the post's artwork), so it carries no disabled prop.
    const soloRequest = vi.fn();
    const solo = lightboxView(
      props({ items: [item(0)], index: 0, manage: MANAGE, onRequestRemove: soloRequest }),
    );
    const soloDelete = byLabel(solo, 'Delete image')!;
    expect((soloDelete.props as { disabled?: boolean }).disabled).toBe(undefined);
    (soloDelete.props as { onClick: () => void }).onClick();
    expect(soloRequest).toHaveBeenCalledOnce();

    // The confirm row for the sole image escalates the copy; confirming runs the
    // existing remove path, which empties the gallery (removeAt -> []) and lets
    // the viewer yield to the zero-asset empty state.
    const onConfirmRemove = vi.fn();
    const soloConfirm = lightboxView(
      props({
        items: [item(0)],
        index: 0,
        manage: MANAGE,
        removeConfirming: true,
        onConfirmRemove,
      }),
    );
    const soloText = strings(soloConfirm);
    expect(soloText).toContain('Delete the only image?');
    expect(soloText).toContain(
      'The post goes back to having no artwork, for everyone. The file stays in Assets.',
    );
    expect(soloText).not.toContain('Remove this image?');
    const soloRemove = elements(soloConfirm).find(
      (el) => (el.props as { children?: ReactNode }).children === 'Remove',
    )!;
    (soloRemove.props as { onClick: () => void }).onClick();
    expect(onConfirmRemove).toHaveBeenCalledOnce();

    // With more than one image delete stays enabled and keeps today's copy.
    const manyRequest = vi.fn();
    const many = lightboxView(props({ index: 1, manage: MANAGE, onRequestRemove: manyRequest }));
    const manyDelete = byLabel(many, 'Delete image')!;
    expect((manyDelete.props as { disabled?: boolean }).disabled).toBe(undefined);
    (manyDelete.props as { onClick: () => void }).onClick();
    expect(manyRequest).toHaveBeenCalledOnce();
    expect(
      strings(lightboxView(props({ index: 1, manage: MANAGE, removeConfirming: true }))),
    ).toContain('Remove this image?');
  });

  it('swaps the bottom bar for a confirm row: cancel restores, remove runs onConfirmRemove', () => {
    const onCancelRemove = vi.fn();
    const onConfirmRemove = vi.fn();
    const tree = lightboxView(
      props({
        index: 1,
        manage: MANAGE,
        removeConfirming: true,
        onCancelRemove,
        onConfirmRemove,
      }),
    );
    // The confirm row replaces the controls; the reorder/add buttons are gone.
    expect(strings(tree)).toContain('Remove this image?');
    expect(byLabel(tree, 'Make first')).toBeUndefined();
    expect(byLabel(tree, 'Add image')).toBeUndefined();

    // Cancel restores the bar; Remove runs the existing remove handler.
    const cancel = elements(tree).find(
      (el) => (el.props as { children?: ReactNode }).children === 'Cancel',
    )!;
    const remove = elements(tree).find(
      (el) => (el.props as { children?: ReactNode }).children === 'Remove',
    )!;
    expect(className(remove)).toContain('border-bad');
    expect(className(remove)).toContain('text-bad');
    (cancel.props as { onClick: () => void }).onClick();
    expect(onCancelRemove).toHaveBeenCalledOnce();
    (remove.props as { onClick: () => void }).onClick();
    expect(onConfirmRemove).toHaveBeenCalledOnce();
  });

  it('disables left/first at position 1 and right/last at the end', () => {
    const manage = MANAGE;
    const first = lightboxView(props({ index: 0, manage }));
    expect((byLabel(first, 'Make first')!.props as { disabled: boolean }).disabled).toBe(true);
    expect((byLabel(first, 'Move left')!.props as { disabled: boolean }).disabled).toBe(true);
    expect((byLabel(first, 'Move right')!.props as { disabled: boolean }).disabled).toBe(false);
    expect((byLabel(first, 'Make last')!.props as { disabled: boolean }).disabled).toBe(false);

    const last = lightboxView(props({ index: 2, manage }));
    expect((byLabel(last, 'Make first')!.props as { disabled: boolean }).disabled).toBe(false);
    expect((byLabel(last, 'Move left')!.props as { disabled: boolean }).disabled).toBe(false);
    expect((byLabel(last, 'Move right')!.props as { disabled: boolean }).disabled).toBe(true);
    expect((byLabel(last, 'Make last')!.props as { disabled: boolean }).disabled).toBe(true);
  });

  it('renders one snapping carousel slide per item, navigable by swipe or overlay arrows', () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const tree = lightboxView(props({ index: 1, onPrev, onNext }));
    const all = elements(tree);
    const slides = all.filter((el) => className(el).includes('snap-center'));
    expect(slides).toHaveLength(3);
    // The redesign drops the dot rail; the counter reflects the index instead.
    const dots = all.filter((el) =>
      ((el.props as { 'aria-label'?: string })['aria-label'] ?? '').startsWith('Go to image'),
    );
    expect(dots).toHaveLength(0);
    // Overlaid prev/next arrows step the carousel (swipe still drives the track).
    // They sit in an absolute inset-0 layer over the image, click-through except
    // on the buttons themselves.
    const prev = byLabel(tree, 'Previous image')!;
    const next = byLabel(tree, 'Next image')!;
    const arrowLayer = all.find(
      (el) =>
        className(el).includes('absolute inset-0') && className(el).includes('justify-between'),
    )!;
    expect(className(arrowLayer)).toContain('pointer-events-none');
    expect(className(prev)).toContain('pointer-events-auto');
    (prev.props as { onClick: () => void }).onClick();
    (next.props as { onClick: () => void }).onClick();
    expect(onPrev).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledOnce();
  });

  it('keeps both arrows enabled at either end so navigation loops', () => {
    // Navigation now wraps at both ends (the wrap math lives in PostLightbox), so
    // the view never disables an arrow: prev is live at the first slide, next at
    // the last. Undefined means the prop was dropped, i.e. not disabled.
    const first = lightboxView(props({ index: 0 }));
    expect((byLabel(first, 'Previous image')!.props as { disabled?: boolean }).disabled).toBe(
      undefined,
    );
    expect((byLabel(first, 'Next image')!.props as { disabled?: boolean }).disabled).toBe(
      undefined,
    );
    const last = lightboxView(props({ index: 2 }));
    expect((byLabel(last, 'Previous image')!.props as { disabled?: boolean }).disabled).toBe(
      undefined,
    );
    expect((byLabel(last, 'Next image')!.props as { disabled?: boolean }).disabled).toBe(undefined);
    // A single-image gallery shows no arrows at all.
    const solo = lightboxView(props({ items: [item(0)], index: 0 }));
    expect(byLabel(solo, 'Previous image')).toBeUndefined();
    expect(byLabel(solo, 'Next image')).toBeUndefined();
  });

  it('disables slide swiping while zoomed past 1x', () => {
    const rest = lightboxView(props());
    const track = elements(rest).find((el) => className(el).includes('overscroll-x-contain'))!;
    expect(className(track)).toContain('overflow-x-auto');
    expect(className(track)).toContain('snap-mandatory');

    const zoomed = lightboxView(props({ zoom: { scale: 2.5, x: 10, y: -5 } }));
    const zTrack = elements(zoomed).find((el) => className(el).includes('overscroll-x-contain'))!;
    expect(className(zTrack)).toContain('overflow-x-hidden');
    expect(className(zTrack)).not.toContain('snap-mandatory');
  });

  it('wires no wheel handler onto the slide stage, so scroll/trackpad never zooms', () => {
    const tree = lightboxView(props());
    // The slide stages carry the pointer/click gesture handlers but no onWheel,
    // so a trackpad or mouse-wheel scroll can never drive the zoom transform.
    const stages = elements(tree).filter(
      (el) => typeof (el.props as { onPointerDown?: unknown }).onPointerDown === 'function',
    );
    expect(stages.length).toBeGreaterThan(0);
    for (const stage of stages) {
      expect((stage.props as { onWheel?: unknown }).onWheel).toBeUndefined();
    }
    // At rest (scale 1) no frame carries a zoom transform.
    const restFrames = elements(tree).filter(
      (el) => (el.props as { style?: { aspectRatio?: string } }).style?.aspectRatio !== undefined,
    );
    for (const frame of restFrames) {
      expect((frame.props as { style?: { transform?: string } }).style?.transform).toBeUndefined();
    }
  });

  it('applies the zoom transform to the active frame past 1x (pinch/double-tap path)', () => {
    const tree = lightboxView(props({ zoom: { scale: 2, x: 10, y: -5 } }));
    const zoomedFrame = elements(tree).find(
      (el) => (el.props as { style?: { transform?: string } }).style?.transform !== undefined,
    );
    expect(zoomedFrame).toBeDefined();
    expect((zoomedFrame!.props as { style: { transform: string } }).style.transform).toContain(
      'scale(2)',
    );
  });

  it('renders the pin overlay over the sharp image only when provided', () => {
    const without = lightboxView(props());
    expect(
      elements(without).some(
        (el) => (el.props as { 'data-testid'?: string })['data-testid'] === 'pins',
      ),
    ).toBe(false);
    const withOverlay = lightboxView(
      props({ pinOverlay: () => <span data-testid="pins">overlay</span> }),
    );
    expect(
      elements(withOverlay).some(
        (el) => (el.props as { 'data-testid'?: string })['data-testid'] === 'pins',
      ),
    ).toBe(true);
  });
});
