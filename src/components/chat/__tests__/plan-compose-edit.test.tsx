import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// The screens' import graph pulls the real agora-chat browser SDK; mock it so
// importing in node never touches browser globals (mirrors PlanCard.test.tsx).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
// The library picker reads the workspace; it is closed here, so stub it.
vi.mock('@/components/chat/AssetPicker', () => ({ AssetPicker: () => null }));
// The Sheet portals into document.body; render it in place for static markup.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (node: ReactNode) => node,
}));

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConceptSheet, conceptTileDay } from '@/components/chat/ConceptSheet';
import {
  ComposeItemRow,
  DATE_FIELD,
  DATE_FIT,
  composeConceptForm,
  composeConceptFrom,
  composeDayCounts,
  composeKindLabel,
  composeServerError,
} from '@/components/chat/PlanComposeScreen';
import {
  PlanDatesSheet,
  PlanDayPickerSheet,
  dayPickerSubline,
  dayTileWeeks,
  tileCaption,
} from '@/components/chat/PlanDayPickerSheet';
import { ToastProvider } from '@/components/ui/toast';
import type { ComposeConcept, ComposePost } from '@/lib/chat/plans';

vi.stubGlobal('document', { body: {} });

const dir = fileURLToPath(new URL('..', import.meta.url));
const src = readFileSync(`${dir}PlanComposeScreen.tsx`, 'utf8');
const planSrc = readFileSync(`${dir}PlanScreen.tsx`, 'utf8');
const pickerSrc = readFileSync(`${dir}PlanDayPickerSheet.tsx`, 'utf8');
const RANGE = { startsOn: '2026-10-12', endsOn: '2026-10-18' };

const C: ComposeConcept = {
  kind: 'concept',
  key: 'k1',
  title: 'Plant tour reel',
  description: 'A walk through the plant.',
  files: [{ versionId: 'v1', name: 'a.png' }],
  day: '2026-10-13',
};
const P: ComposePost = {
  kind: 'post',
  key: 'p1',
  title: 'Festive teaser carousel',
  stage: 'review',
  orig: '2026-11-02',
  day: null,
  chosen: false,
};
const row = (item: ComposeConcept | ComposePost): string =>
  renderToStaticMarkup(
    <ComposeItemRow item={item} onDay={() => {}} onEdit={() => {}} onRemove={() => {}} />,
  );

describe('New plan rows', () => {
  it('a flagged post: warning row, Pick a day, the outside note, a 44px X', () => {
    const html = row(P);
    expect(html).toContain('data-plan-compose-flag="need"');
    expect(html).toContain('border-warn bg-warn-soft');
    expect(html).toMatch(/data-plan-day-button="need"[^>]*min-h-\[44px\]/);
    expect(html).toContain('Pick a day');
    expect(html).toContain('Dated Mon 2 Nov, outside this plan. Pick a day.');
    expect(html).toContain('Post · In review');
    const x = html.slice(html.indexOf('data-plan-compose-remove'));
    expect(x).toContain('h-11 w-11');
    expect(x).toContain('aria-label="Remove Festive teaser carousel"');
  });

  it('a concept: day label, 2-line description, tap title to edit; no flag', () => {
    const html = row(C);
    expect(html).toContain('data-plan-compose-flag="ok"');
    expect(html).toContain('Tue 13 Oct');
    expect(html).toContain('line-clamp-2');
    expect(html).toContain('aria-label="Edit Plant tour reel"');
    expect(composeKindLabel(C)).toBe('Concept');
    expect(composeKindLabel({ ...P, kind: 'draft' })).toBe('Draft');
  });

  it('notes for a move and a clear', () => {
    expect(row({ ...P, day: '2026-10-13', chosen: true })).toContain(
      'Pipeline date moves from Mon 2 Nov to Tue 13 Oct.',
    );
    const cleared = row({ ...P, day: 'none', chosen: true });
    expect(cleared).toContain('No date');
    expect(cleared).toContain('Pipeline date Mon 2 Nov will be cleared.');
  });

  it('concept form round trip: No date, a day, a flagged day', () => {
    expect(composeConceptForm({ ...C, day: 'none' }).date).toBe('');
    expect(composeConceptForm(C).date).toBe('2026-10-13');
    const flagged = composeConceptForm({ ...C, day: null });
    expect(conceptTileDay(flagged.date, RANGE)).toBeNull();
    expect(composeConceptFrom('k1', flagged, RANGE).day).toBeNull();
    expect(composeConceptFrom('k1', { ...flagged, date: '' }, RANGE).day).toBe('none');
    expect(composeConceptFrom('k1', { ...flagged, date: '2026-10-14' }, RANGE).day).toBe(
      '2026-10-14',
    );
    expect(composeDayCounts([C, P, { ...C, key: 'k2' }])).toEqual({ '2026-10-13': 2 });
  });

  it('server errors lead with their first sentence', () => {
    expect(composeServerError('Failed to fetch')).toEqual({
      heading: "Couldn't reach Sorted.",
      lines: ['Nothing was saved. Check your connection and tap Create plan again.'],
    });
  });
});

describe('New plan create: one call, never half built', () => {
  it('one planCreateWithItems call; no sequential procs, no Retry, never locked', () => {
    expect(src.match(/planCreateWithItems\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/planCreate\(|planConceptAdd|planPostsAdd|runPlanShare/);
    expect(src).not.toMatch(/'Retry'|locked=|const locked/);
    expect(src).toContain("CREATING_LABEL = 'Creating…'");
    expect(src).toContain('if (inFlight.current) return;');
  });

  it('needs a day: no server call, alert, scroll and translateX shake (not under reduced motion)', () => {
    const create = src.slice(
      src.indexOf('const create = async'),
      src.indexOf('inFlight.current = true'),
    );
    expect(create).toContain('composeNeedsDayError(items)');
    expect(create).not.toContain('planCreateWithItems');
    expect(src).toContain('role="alert"');
    expect(src).toContain("scrollIntoView({ block: 'center' })");
    expect(src).toContain('!prefersReducedMotion()');
    const shake = src.slice(src.indexOf('row.animate('), src.indexOf('const create = async'));
    expect(shake).toContain('translateX(-4px)');
    expect(shake).not.toMatch(/translateY|rotate|scale\(/);
  });

  it('From / To live in the dates sheet: shrinkable, WebKit reset, 44px+', () => {
    expect(src).not.toContain('type="date"');
    expect(pickerSrc).toContain('className="flex w-full min-w-0 flex-col gap-1"');
    expect(pickerSrc).toContain('className={DATE_FIELD}');
    expect(DATE_FIELD).toContain(DATE_FIT);
    expect(DATE_FIELD).toContain(' px-2.5 ');
    expect(DATE_FIELD).toContain('h-11 min-h-[44px]');
    expect(DATE_FIELD).toContain('rounded-lg');
    expect(DATE_FIELD).toContain('bg-panel-2');
    expect(DATE_FIT).toContain('appearance-none');
    const html = renderToStaticMarkup(
      <PlanDatesSheet open range={RANGE} onSave={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('Plan dates');
    expect(html).toContain('value="2026-10-12"');
    expect(html).toContain('Save dates');
  });

  it('no em-dashes (chat-tokens.test.ts guards hex and theme literals)', () => {
    for (const s of [src, pickerSrc]) expect(s).not.toContain(String.fromCharCode(0x2014));
  });
});

describe('day picker sheet', () => {
  it('tiles, today accent, selected fill, pipeline dot, No date, footnote', () => {
    const html = renderToStaticMarkup(
      <PlanDayPickerSheet
        open
        title="Diwali greeting static"
        subline={dayPickerSubline({ kind: 'post', orig: '2026-10-14' }, RANGE)}
        range={RANGE}
        selected="2026-10-15"
        today="2026-10-13"
        pipelineDay="2026-10-14"
        counts={{ '2026-10-15': 2 }}
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('In Pipeline: Wed 14 Oct');
    expect(html.match(/data-plan-day-tile=/g)).toHaveLength(7);
    expect(html).toContain('grid-cols-4');
    expect(html).toMatch(/data-plan-day-tile="2026-10-15" aria-pressed="true"[^>]*bg-accent\b/);
    expect(html).toContain('2 items');
    expect(html).toContain('text-accent">Tue');
    expect(html).toContain('data-plan-day-pipeline');
    expect(html).toContain('Current Pipeline day');
    expect(html).toContain('data-plan-day-none');
    expect(html).toContain('Need a later day? Close this and change the plan dates.');
    expect(html).not.toContain('Week of');
    expect(html).not.toMatch(/Another date/);
  });

  it('F: No date and the footnote hidden; outside subline', () => {
    const html = renderToStaticMarkup(
      <PlanDayPickerSheet
        open
        title="Festive"
        subline={dayPickerSubline({ kind: 'post', orig: '2026-11-02' }, RANGE)}
        range={RANGE}
        selected={null}
        today="2026-10-13"
        hideNoDate
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('In Pipeline: Mon 2 Nov (outside this plan)');
    expect(html).not.toContain('data-plan-day-none');
    expect(html).not.toContain('Need a later day?');
    expect(html).not.toContain('Current Pipeline day');
    expect(dayPickerSubline({ kind: 'post', orig: null }, RANGE)).toBe('No Pipeline date yet');
    expect(dayPickerSubline({ kind: 'concept' }, RANGE)).toBe('Concept');
  });

  it('multi-week ranges label each week; tiles show the month when empty', () => {
    const weeks = dayTileWeeks({ startsOn: '2026-10-08', endsOn: '2026-10-20' });
    expect(weeks.map((w) => w.label)).toEqual([
      'Week of Mon 5 Oct',
      'Week of Mon 12 Oct',
      'Week of Mon 19 Oct',
    ]);
    expect(dayTileWeeks(RANGE)).toEqual([{ label: null, days: expect.any(Array) }]);
    expect(tileCaption('2026-10-13', 0)).toBe('Oct');
    expect(tileCaption('2026-10-13', 1)).toBe('1 item');
  });
});

describe('concept sheet: tiles and soft counter', () => {
  const sheet = (description: string, range?: typeof RANGE): string =>
    renderToStaticMarkup(
      <ToastProvider>
        <ConceptSheet
          open
          mode="add"
          form={{ title: 'Reel', description, date: '', files: [] }}
          onChange={() => {}}
          onSubmit={() => {}}
          onClose={() => {}}
          {...(range !== undefined ? { range, today: '2026-10-13' } : {})}
        />
      </ToastProvider>,
    );

  it('tiles plus No date (selected) replace the native date; 4-line description', () => {
    const html = sheet('', RANGE);
    expect(html).not.toContain('type="date"');
    expect(html).toMatch(/data-plan-day-none="" aria-pressed="true"/);
    expect(html).toContain('rows="4"');
    expect(html).toContain('min-h-[104px]');
    expect(html).toContain(
      'placeholder="What is the concept? The idea, the hook, what approvers will see."',
    );
    expect(html).toContain('0 / 50 words');
    expect(html).not.toContain('Need a later day?');
  });

  it('past 50 words: warning colour and the aim line; Save never blocked', () => {
    const html = sheet(Array(60).fill('word').join(' '), RANGE);
    expect(html).toMatch(/data-plan-concept-words="over"[^>]*text-warn/);
    expect(html).toContain('60 words · aim for 50 so approvers read it all');
    const save = /<button[^>]*data-plan-concept-save=""[^>]*>/.exec(html)?.[0] ?? '';
    expect(save).not.toMatch(/ disabled=""/);
  });

  it('without a range (item screen edit) the native date field stays', () => {
    expect(sheet('')).toContain('type="date"');
  });
});

describe('existing plan header "+": no outside post without a day (F)', () => {
  it('splits before any write; outside posts only go with p_target_date', () => {
    const close = planSrc.slice(
      planSrc.indexOf('const closePicker = async'),
      planSrc.indexOf('const outsideNext'),
    );
    expect(close).toContain('splitPickedByRange(');
    expect(close).toContain('addPosts(split.now, null)');
    expect(close).not.toMatch(/addPosts\(split\.outside/);
    const days = planSrc.slice(
      planSrc.indexOf('const addOnDays'),
      planSrc.indexOf('const outsidePost'),
    );
    expect(days).toContain('addPosts(group.postIds, group.day)');
    expect(planSrc).toMatch(/<PlanDayPickerSheet[\s\S]*?hideNoDate/);
  });
});
