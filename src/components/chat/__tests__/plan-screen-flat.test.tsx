import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The screens' import graph pulls the real agora-chat browser SDK; mock it so
// importing in node never touches browser globals (mirrors PlanCard.test.tsx).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  DayColumn,
  PLAN_DAY_PAD,
  PLAN_DAY_SECTION,
  PLAN_DAY_STACK,
  PLAN_ROW_RULE,
  PlanProgressRow,
} from '@/components/chat/PlanScreen';
import type { PlanBundle } from '@/lib/chat/plans';

const dir = fileURLToPath(new URL('..', import.meta.url));
const src = readFileSync(`${dir}PlanScreen.tsx`, 'utf8');

const BUNDLE: PlanBundle = {
  plan: {
    id: 'plan',
    workspace_id: 'ws',
    title: 'Week',
    starts_on: '2026-10-12',
    ends_on: '2026-10-16',
    audience: 'team',
    created_by: null,
  },
  items: [
    {
      id: 'c1',
      plan_id: 'plan',
      kind: 'concept',
      position: 0,
      title: 'c1',
      description: null,
      post_id: null,
      created_at: '2026-10-09T10:00:00Z',
      target_date: '2026-10-14',
    },
  ],
  reviews: [],
  postStages: {},
  postInfo: {},
};

describe('Plan screen flat (density)', () => {
  it('density constants: Cozy default with compact: and calm: variants', () => {
    // Within a day (title, PLAN, POST, Add): 4 / 8 / 12.
    expect(PLAN_DAY_STACK).toBe('gap-2 compact:gap-1 calm:gap-3');
    // Day padding top/bottom (and so the space between two days): 8 / 12 / 16.
    expect(PLAN_DAY_PAD).toBe('py-3 compact:py-2 calm:py-4');
    for (const value of [PLAN_DAY_STACK, PLAN_DAY_PAD, PLAN_ROW_RULE]) {
      expect(value).toMatch(/\bcompact:/);
      expect(value).toMatch(/\bcalm:/);
    }
    expect(PLAN_ROW_RULE).toContain('border-t border-border');
  });

  it('a day is a flat section: hairline under, GUTTER sides, no Card frame', () => {
    expect(PLAN_DAY_SECTION).toContain('border-b border-border');
    expect(PLAN_DAY_SECTION).toContain('px-4 md:px-6');
    expect(PLAN_DAY_SECTION).toContain(PLAN_DAY_PAD);
    expect(PLAN_DAY_SECTION).not.toMatch(/rounded|lit-|shadow|\bmx-/);
    // No ui/Card around a day, and today takes no outline.
    expect(src).not.toContain("from '@/components/ui/Card'");
    expect(src).not.toMatch(/<Card\b/);
    expect(src).not.toContain('selected={day.day === today}');
    expect(src).toContain('className={PLAN_DAY_SECTION}');
  });

  it('PlanProgressRow: two flat columns, no boxes, a hairline under', () => {
    const html = renderToStaticMarkup(<PlanProgressRow bundle={BUNDLE} side="agency" />);
    const block = html.match(/<div data-plan-progress-block="" class="([^"]*)"/)?.[1] ?? '';
    expect(block.split(' ')).toEqual(
      expect.arrayContaining(['grid', 'grid-cols-2', 'border-b', 'border-border']),
    );
    expect(block).toContain(PLAN_DAY_PAD);
    expect(html.match(/data-plan-screen-progress="/g)).toHaveLength(2);
    for (const key of ['plan', 'post']) {
      const box =
        html.match(new RegExp(`data-plan-screen-progress="${key}" class="([^"]*)"`))?.[1] ?? '';
      expect(box).not.toContain('bg-panel-2');
      expect(box).not.toContain('lit-card-muted');
      expect(box).not.toMatch(/rounded|\bp-3\b/);
    }
    expect(html).not.toContain('lit-card-muted');
  });

  it('DayColumn tile: rounded-picture bg-panel-2, today bg-accent, no border or lit-card', () => {
    const tileClass = (html: string): string =>
      html.match(/<div data-plan-day-col=""(?: data-plan-today="")? class="([^"]*)"/)?.[1] ?? '';
    const other = tileClass(
      renderToStaticMarkup(<DayColumn day="2026-10-15" today="2026-10-14" />),
    );
    expect(other.split(' ')).toEqual(expect.arrayContaining(['rounded-picture', 'bg-panel-2']));
    expect(other.split(' ')).not.toContain('border');
    expect(other).not.toContain('lit-card');
    const todayHtml = renderToStaticMarkup(<DayColumn day="2026-10-14" today="2026-10-14" />);
    const today = tileClass(todayHtml);
    expect(today.split(' ')).toEqual(expect.arrayContaining(['rounded-picture', 'bg-accent']));
    expect(today.split(' ')).not.toContain('border');
    expect(today).not.toContain('lit-card');
    expect(todayHtml).toMatch(/data-plan-day-number=""[^>]*text-accent-fg">14</);
    const none = tileClass(renderToStaticMarkup(<DayColumn day={null} today="2026-10-14" />));
    expect(none.split(' ')).toEqual(expect.arrayContaining(['rounded-picture', 'bg-panel-2']));
  });

  it('PLAN line and the row menu keep 44 boxes and overlap the line (CONTROL_IN_LINE)', () => {
    expect(src).toMatch(
      /data-plan-line="plan"[\s\S]{0,200}control\.kind === 'text' && CONTROL_IN_LINE/,
    );
    expect(src).toMatch(
      /data-plan-row-menu="" className=\{cn\('flex shrink-0', CONTROL_IN_LINE\)\}/,
    );
    // The Add row under a day's rows overlaps too; no hand tuck.
    expect(src).toContain("!props.empty && cn(CONTROL_IN_LINE, 'pl-17')");
    expect(src).not.toContain('-mb-3 -mt-2 pl-17');
    // Rows in a day stack by density, the hairline rule centred in the gap.
    expect(src).toContain('const rowLine = props.tile === null && PLAN_ROW_RULE;');
    expect(src).not.toContain('-mt-2 border-t border-border pt-2');
  });
});
