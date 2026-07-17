import { describe, expect, it } from 'vitest';
import {
  COUNTER_FROM,
  MAX_POINTS,
  MAX_WORDS,
  OVER_LIMIT_MESSAGE,
  buildPoints,
  counterTone,
  countWords,
  sendLabel,
  slotsSendable,
} from '@/components/comments/SlotComposer';

// Node unit environment: the stateful composer is not mounted; the pure rules
// (the word count that MUST match the server, the counter tones, the send gate,
// and the p_points shape) are asserted directly.

function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
}

describe('countWords (server parity: regexp \\s+ on btrim(body))', () => {
  it('counts a whitespace split of the trimmed body', () => {
    expect(countWords('one two three')).toBe(3);
    expect(countWords('  padded once  ')).toBe(2);
    expect(countWords('single')).toBe(1);
  });

  it('treats any whitespace run between words as one separator', () => {
    expect(countWords('a\nb\tc   d')).toBe(4);
  });

  it('counts an empty or whitespace-only body as 0 (send stays blocked)', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
    expect(countWords('\n\t')).toBe(0);
  });

  it('mirrors btrim exactly: non-space edge whitespace counts, as on the server', () => {
    // btrim strips spaces only, so regexp_split_to_array('\nword', '\s+') on the
    // server yields ['', 'word'] = 2. The client must agree at the 50 boundary.
    expect(countWords('\nword')).toBe(2);
    expect(countWords('word\n')).toBe(2);
    expect(countWords(' \nword ')).toBe(2);
  });

  it('counts exactly at and over the 50-word cap', () => {
    expect(countWords(words(50))).toBe(50);
    expect(countWords(words(51))).toBe(51);
  });
});

describe('counterTone (hidden < 35, amber 35..50, red over 50)', () => {
  it('stays hidden below 35 words', () => {
    expect(counterTone(0)).toBe('hidden');
    expect(counterTone(34)).toBe('hidden');
  });

  it('shows amber from 35 through exactly 50', () => {
    expect(counterTone(COUNTER_FROM)).toBe('amber');
    expect(counterTone(42)).toBe('amber');
    expect(counterTone(MAX_WORDS)).toBe('amber');
  });

  it('turns over (red, blocks send) above 50', () => {
    expect(counterTone(51)).toBe('over');
  });

  it('carries the exact blocking message', () => {
    expect(OVER_LIMIT_MESSAGE).toBe('Over 50 words. Split it into two points.');
  });
});

describe('slotsSendable (every slot 1..50 words)', () => {
  it('allows a full set of valid slots, including one at exactly 50 words', () => {
    expect(slotsSendable(['a point', words(50)])).toBe(true);
  });

  it('blocks when any slot is empty', () => {
    expect(slotsSendable(['fine', ''])).toBe(false);
    expect(slotsSendable(['fine', '   '])).toBe(false);
  });

  it('blocks when any slot is over 50 words', () => {
    expect(slotsSendable(['fine', words(51)])).toBe(false);
  });

  it('blocks with no slots at all', () => {
    expect(slotsSendable([])).toBe(false);
  });
});

describe('buildPoints (p_points shape)', () => {
  it('rides each slot attachment version ids with its own point', () => {
    const points = buildPoints([
      { body: 'first', attachmentVersionIds: ['v1', 'v2'] },
      { body: 'second', attachmentVersionIds: [] },
      { body: 'third', attachmentVersionIds: ['v3'] },
    ]);
    expect(points).toEqual([
      { body: 'first', attachment_version_ids: ['v1', 'v2'] },
      { body: 'second' },
      { body: 'third', attachment_version_ids: ['v3'] },
    ]);
  });

  it('omits the attachment key entirely for a slot with none', () => {
    const [point] = buildPoints([{ body: 'plain', attachmentVersionIds: [] }]);
    expect(point).not.toHaveProperty('attachment_version_ids');
  });
});

describe('sendLabel and limits', () => {
  it('reads Send N points, singular at one', () => {
    expect(sendLabel(1)).toBe('Send 1 point');
    expect(sendLabel(2)).toBe('Send 2 points');
    expect(sendLabel(20)).toBe('Send 20 points');
  });

  it('pins the proc limits: 20 points per batch, counter from 35, cap at 50', () => {
    expect(MAX_POINTS).toBe(20);
    expect(COUNTER_FROM).toBe(35);
    expect(MAX_WORDS).toBe(50);
  });
});
