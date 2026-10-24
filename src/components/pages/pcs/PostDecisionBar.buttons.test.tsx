import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PostDecisionBar, PostDecisionRow } from '@/components/pages/pcs/PostDecisionBar';
import { visibleStageActions } from '@/components/pages/pcs/stage-actions';

// Button system: every decision button is the shared 44px / 8px-radius Button.
// Approve is success green; Reject is secondary with bad ink, never a red fill.

function buttonTags(html: string): string[] {
  return html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
}

function classOf(tag: string): string {
  return /class="([^"]*)"/.exec(tag)?.[1] ?? '';
}

describe('PostDecisionBar buttons', () => {
  const model = {
    kind: 'approver' as const,
    actions: visibleStageActions('review', 'client'),
    onPick: vi.fn(),
  };

  for (const [name, html] of [
    ['bar', renderToStaticMarkup(PostDecisionBar({ model, busy: false, error: null }))],
    ['row', renderToStaticMarkup(PostDecisionRow({ model, busy: false, error: null }))],
  ] as const) {
    it(`${name}: Approve is success, Reject is secondary with bad ink`, () => {
      const tags = buttonTags(html);
      const approve = tags.find((t) => t.includes('>Approve<'));
      const reject = tags.find((t) => t.includes('>Reject<'));
      if (approve === undefined || reject === undefined) throw new Error('missing buttons');
      const a = classOf(approve);
      const r = classOf(reject);
      expect(a).toContain('bg-good-solid');
      expect(a).toContain('h-11');
      expect(a).toContain('rounded-lg');
      expect(r).toContain('text-bad');
      expect(r).toContain('border-border');
      expect(r).not.toContain('bg-bad-solid');
      for (const c of [a, r]) {
        expect(c).not.toMatch(/\bh-(9|10|12)\b/);
        expect(c).not.toContain('rounded-md');
        expect(c).not.toContain('font-semibold');
      }
    });
  }

  it('creator main button is primary, 44 tall, 8px radius', () => {
    const html = renderToStaticMarkup(
      PostDecisionBar({
        model: {
          kind: 'creator',
          label: 'Send for review',
          disabled: false,
          helper: null,
          onPress: vi.fn(),
        },
        busy: false,
        error: null,
      }),
    );
    const main = buttonTags(html).find((t) => t.includes('data-decision-main'));
    if (main === undefined) throw new Error('no main button');
    expect(classOf(main)).toContain('bg-accent');
    expect(classOf(main)).toContain('h-11');
    expect(classOf(main)).toContain('rounded-lg');
  });
});
