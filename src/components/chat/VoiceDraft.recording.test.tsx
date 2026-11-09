// The shared voice note pieces (chat Composer and the catch-up reply): the
// recording row is round X cancel (bg-fg/10) | the dotted track with live ink
// bars filling from the right | m:ss (meta) | round check (Main) = stop and
// keep; bars move by transform scaleY only. The kept note's chip: round play
// (Main), fg-3 bars, the length, and a small round X (fg on bg, 24 visual, 44
// hit) at its top-right corner.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  RECORDING_BARS_MAX,
  RecordingRow,
  VoiceNoteChip,
  chipBars,
  liveBarHeight,
  liveBars,
} from '@/components/chat/VoiceDraft';

const noop = (): void => undefined;

function row(bars = 5): string {
  return renderToStaticMarkup(
    <RecordingRow
      elapsed="0:07"
      bars={bars}
      onCancel={noop}
      onKeep={noop}
      dataAttrs={{ 'data-catch-up-recording': '' }}
    />,
  );
}

describe('RecordingRow', () => {
  it('reads cancel, track, m:ss, keep, in that order', () => {
    const html = row();
    const cancel = html.indexOf('aria-label="Cancel recording"');
    const track = html.indexOf('data-recording-track');
    const elapsed = html.indexOf('data-recording-elapsed');
    const keep = html.indexOf('aria-label="Stop and keep voice note"');
    expect(cancel).toBeGreaterThan(-1);
    expect(cancel).toBeLessThan(track);
    expect(track).toBeLessThan(elapsed);
    expect(elapsed).toBeLessThan(keep);
    expect(html).toContain('data-catch-up-recording=""');
    expect(html).toContain('0:07');
  });

  it('cancel is a round soft-grey Button, keep the round Main, both 44', () => {
    const html = row();
    const cancel = /<button[^>]*aria-label="Cancel recording"[^>]*>/.exec(html)?.[0] ?? '';
    const keep = /<button[^>]*aria-label="Stop and keep voice note"[^>]*>/.exec(html)?.[0] ?? '';
    expect(cancel).toContain('bg-fg/10');
    expect(cancel).toContain('rounded-full w-11');
    expect(keep).toContain('bg-accent');
    expect(keep).toContain('rounded-full w-11');
  });

  it('the track is dotted with ink bars at the right, drawn by scaleY only', () => {
    const html = row(3);
    expect(html).toContain('border-dotted');
    expect(html).toContain('justify-end');
    expect(html.match(/data-voice-bar=""/g)).toHaveLength(3);
    expect(html).toContain('bg-fg');
    expect(html).toMatch(/style="transform:scaleY\(0\.\d+\)"/);
    // The icons' own svg size (width/height style) is not motion; check the rest.
    const noSvg = html.replace(/<svg[\s\S]*?<\/svg>/g, '');
    expect(noSvg).not.toMatch(/height:|opacity|transition|animate-/);
    // The m:ss is the meta role (mono, tabular).
    expect(html).toMatch(/data-recording-elapsed=""[^>]*class="[^"]*font-mono/);
  });

  it('liveBars keeps the newest bars, keyed by index, levels 0.25..1', () => {
    expect(liveBars(0)).toEqual([]);
    const many = liveBars(RECORDING_BARS_MAX + 10);
    expect(many).toHaveLength(RECORDING_BARS_MAX);
    expect(many[0]?.key).toBe(10);
    expect(many[many.length - 1]?.key).toBe(RECORDING_BARS_MAX + 9);
    for (let i = 0; i < 200; i += 1) {
      const h = liveBarHeight(i);
      expect(h).toBeGreaterThanOrEqual(0.25);
      expect(h).toBeLessThanOrEqual(1);
    }
    expect(liveBarHeight(3)).toBe(liveBarHeight(3));
  });
});

describe('VoiceNoteChip', () => {
  function chip(upload?: Parameters<typeof VoiceNoteChip>[0]['upload']): string {
    return renderToStaticMarkup(
      <VoiceNoteChip
        durationMs={65_000}
        playing={false}
        onPlay={noop}
        onRemove={noop}
        upload={upload}
        dataAttrs={{ 'data-catch-up-voice-chip': '' }}
      />,
    );
  }

  it('round play (Main), fg-3 bars, the length, and the corner X', () => {
    const html = chip();
    expect(html).toContain('data-catch-up-voice-chip=""');
    expect(html).toContain('data-voice-chip="ready"');
    const play = /<button[^>]*aria-label="Play voice note"[^>]*>/.exec(html)?.[0] ?? '';
    expect(play).toContain('bg-accent');
    expect(play).toContain('rounded-full w-11');
    expect(html).toContain('bg-fg-3');
    expect(html).toContain('1:05');
    const remove = /<button[^>]*aria-label="Remove voice note"[^>]*>/.exec(html)?.[0] ?? '';
    expect(remove).toContain('absolute');
    expect(remove).toContain('h-11 w-11');
    expect(html).toContain('h-6 w-6 place-items-center rounded-full bg-fg text-bg');
  });

  it('uploading holds the ring in the play slot; failed shows Retry there', () => {
    expect(chip({ state: 'uploading', progress: 0.5 })).toContain('data-upload-ring');
    expect(chip({ state: 'uploading', progress: 0.5 })).not.toContain('Play voice note');
    expect(chip({ state: 'failed', onRetry: noop })).toContain('data-upload-retry');
  });

  it('chipBars squeezes peaks to its count, else the pseudo-levels', () => {
    expect(chipBars(undefined, 4)).toEqual([0, 1, 2, 3].map(liveBarHeight));
    const bars = chipBars([0, 0.5, 1, 0.1], 4);
    expect(bars).toEqual([0.25, 0.5, 1, 0.25]);
  });
});

describe('the chat composer uses the shared pieces', () => {
  const SRC = readFileSync(fileURLToPath(new URL('./Composer.tsx', import.meta.url)), 'utf8');
  it('recording renders RecordingRow; the kept note waits in the box as a chip', () => {
    expect(SRC).toContain('recording={\n            <RecordingRow');
    expect(SRC).toContain('attachments={keptChip}');
    expect(SRC).toContain('<VoiceNoteChipPlayer');
    expect(SRC).toContain('onKeep={() => void stopKeep()}');
    // The old one-tap stop-and-send is gone; Send sends the kept note.
    expect(SRC).not.toContain('Stop and send voice note');
    expect(SRC).toContain('if (voiceSendable) void sendDraft();');
  });
});
