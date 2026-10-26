// X3: view mode and edit mode rendering and rules: concept photo tiles, the
// Edit / Save changes header, the one primary footer action, plan_save failure
// copy, the discard confirm copy, the New plan title placeholder, and the
// migration record.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { PlanBody, PlanEditHeader, planListGroups } from '@/components/chat/PlanScreen';
import {
  DISCARD_EDITS,
  EDITING_TITLE,
  EDIT_LABEL,
  OPEN_FOR_CLIENT_TOAST,
  PLAN_SAVED_TOAST,
  PLAN_SAVE_ERROR_COPY,
  PLAN_SAVE_FAILED_COPY,
  SAVE_CHANGES_LABEL,
  SAVING_LABEL,
  SEND_AFTER_OPEN_FAILED,
  composeTitlePlaceholder,
  planPrimaryAction,
  planSaveErrorCopy,
  progressLabel,
  planProgress,
  sendToApproversLabel,
} from '@/components/chat/plan-card';
import { thumbsOfRows, type PlanBundle, type PlanItemRow } from '@/lib/chat/plans';

const dir = fileURLToPath(new URL('..', import.meta.url));
const read = (name: string): string => readFileSync(`${dir}${name}`, 'utf8');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const readRoot = (name: string): string => readFileSync(`${root}${name}`, 'utf8');

function item(over: Partial<PlanItemRow> & { id: string }): PlanItemRow {
  return {
    plan_id: 'plan',
    kind: 'concept',
    position: 0,
    title: 'Reel',
    description: null,
    post_id: null,
    created_at: '2026-10-09T10:00:00Z',
    ...over,
  };
}

const BUNDLE: PlanBundle = {
  plan: {
    id: 'plan',
    workspace_id: 'ws',
    title: 'Week of 12 Oct',
    starts_on: '2026-10-12',
    ends_on: '2026-10-18',
    audience: 'team',
    created_by: 'creator',
  },
  items: [
    item({ id: 'c-photo', target_date: '2026-10-13', position: 0 }),
    item({ id: 'c-doc', target_date: '2026-10-13', position: 1 }),
    item({ id: 'c-none', target_date: '2026-10-14', position: 2 }),
    item({ id: 'p1', kind: 'post', title: null, post_id: 'post1', position: 3 }),
  ],
  reviews: [],
  postStages: { post1: 'review' },
  postInfo: { post1: { title: 'Carousel', target_date: '2026-10-15T12:00:00Z' } },
};

describe('concept photos (item 2)', () => {
  it('thumbsOfRows: a post keeps its first image; a concept gets its first image or a file tile', () => {
    const thumbs = thumbsOfRows([
      {
        entity_id: 'post1',
        entity_type: 'post',
        asset_version_id: 'v-video',
        asset_versions: { mime_type: 'video/mp4' },
      },
      {
        entity_id: 'post1',
        entity_type: 'post',
        asset_version_id: 'v-p',
        asset_versions: { mime_type: 'image/png' },
      },
      {
        entity_id: 'c-doc',
        entity_type: 'plan_item',
        asset_version_id: 'v-pdf',
        asset_versions: { mime_type: 'application/pdf' },
      },
      {
        entity_id: 'c-photo',
        entity_type: 'plan_item',
        asset_version_id: 'v-pdf2',
        asset_versions: { mime_type: 'application/pdf' },
      },
      {
        entity_id: 'c-photo',
        entity_type: 'plan_item',
        asset_version_id: 'v-img',
        asset_versions: [{ mime_type: 'image/jpeg' }],
      },
      {
        entity_id: 'c-photo',
        entity_type: 'plan_item',
        asset_version_id: 'v-img2',
        asset_versions: { mime_type: 'image/jpeg' },
      },
    ]);
    expect(thumbs.posts).toEqual({ post1: 'v-p' });
    expect(thumbs.concepts).toEqual({
      'c-doc': { kind: 'file' },
      'c-photo': { kind: 'image', versionId: 'v-img' },
    });
  });

  it('the screen read carries the post and concept tiles (no per-row fetch)', () => {
    const plans = readRoot('src/lib/chat/plans.ts');
    // The Plan screen's one plan_bundle_read returns thumbs{posts,concepts}.
    expect(plans).toContain('thumbs: read.thumbs.posts,');
    expect(plans).toContain('conceptThumbs: read.thumbs.concepts,');
    expect(plans).toContain(".in('entity_type', ['post', 'plan_item'])");
    const screen = read('PlanScreen.tsx');
    expect(screen).not.toMatch(/readItemFiles\(/);
  });

  it('rows: the photo tile, the file tile, the empty dashed tile', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PlanBody
          bundle={BUNDLE}
          groups={planListGroups(BUNDLE, 'UTC', 'agency')}
          side="agency"
          timeZone="UTC"
          thumbs={{}}
          conceptThumbs={{
            'c-photo': { kind: 'image', versionId: 'v-img' },
            'c-doc': { kind: 'file' },
          }}
          drag={null}
          onOpenItem={() => undefined}
          onPlanOk={() => undefined}
          onPlanNotOk={() => undefined}
        />
      </MemoryRouter>,
    );
    const rowOf = (id: string): string =>
      new RegExp(`<div data-plan-row-wrap="${id}"[^>]*>[\\s\\S]*?<\\/button>`).exec(html)?.[0] ??
      '';
    expect(rowOf('c-photo')).toContain('data-plan-row-tile="concept-image"');
    expect(rowOf('c-doc')).toContain('data-plan-row-tile="concept-file"');
    expect(rowOf('c-none')).toContain('data-plan-row-tile="concept"');
    // Tokens only on the file tile.
    expect(rowOf('c-doc')).toContain('bg-panel-3 text-fg-3');
  });
});

describe('edit mode header and copy (items 3, 4, 5)', () => {
  it('copy: Edit, Editing plan, Save changes, Saving…, Plan saved, the discard confirm; no em-dashes', () => {
    expect(EDIT_LABEL).toBe('Edit');
    expect(EDITING_TITLE).toBe('Editing plan');
    expect(SAVE_CHANGES_LABEL).toBe('Save changes');
    expect(SAVING_LABEL).toBe('Saving…');
    expect(PLAN_SAVED_TOAST).toBe('Plan saved');
    expect(DISCARD_EDITS).toEqual({
      title: 'Discard changes?',
      message: 'Your edits to this plan will be lost.',
    });
    expect(OPEN_FOR_CLIENT_TOAST).toBe('Approvers can now review this plan');
    for (const s of [
      ...Object.values(PLAN_SAVE_ERROR_COPY),
      PLAN_SAVE_FAILED_COPY,
      SEND_AFTER_OPEN_FAILED,
      DISCARD_EDITS.message,
    ]) {
      expect(s).not.toContain(String.fromCharCode(0x2014));
    }
  });

  it('plan_save failures map to plain words: forbidden_role, invalid_payload, date_outside_plan, network, other', () => {
    expect(planSaveErrorCopy('P0001: forbidden_role')).toBe(PLAN_SAVE_ERROR_COPY.forbidden);
    expect(planSaveErrorCopy('invalid_payload')).toBe(PLAN_SAVE_ERROR_COPY.invalid_payload);
    expect(planSaveErrorCopy('date_outside_plan')).toBe(PLAN_SAVE_ERROR_COPY.date_outside_plan);
    expect(planSaveErrorCopy('TypeError: Failed to fetch')).toBe(PLAN_SAVE_ERROR_COPY.network);
    expect(planSaveErrorCopy('boom')).toBe(PLAN_SAVE_FAILED_COPY);
    for (const copy of Object.values(PLAN_SAVE_ERROR_COPY))
      expect(copy).toContain('Nothing was saved');
  });

  it('the edit header: name and From / To fields, a problem line, the save error with Retry', () => {
    const draft = { title: 'Week of 12 Oct', startsOn: '2026-10-12', endsOn: '2026-10-18' };
    const html = renderToStaticMarkup(
      <PlanEditHeader
        draft={draft}
        problem={null}
        saving={false}
        error={null}
        onChange={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(html).toContain('data-plan-edit-title=""');
    expect(html).toContain('enterKeyHint="done"');
    expect(html).toContain('data-plan-edit-date="startsOn"');
    expect(html).toContain('data-plan-edit-date="endsOn"');
    expect(html).toContain('value="2026-10-18"');
    expect(html).not.toContain('data-plan-save-error');
    const failed = renderToStaticMarkup(
      <PlanEditHeader
        draft={draft}
        problem="To must be on or after From."
        saving={false}
        error={PLAN_SAVE_FAILED_COPY}
        onChange={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(failed).toMatch(
      /data-plan-save-error=""[^>]*role="alert"|role="alert"[^>]*data-plan-save-error=""/,
    );
    // The static markup HTML-escapes the apostrophe: match the copy's tail.
    expect(failed).toContain('t save the plan. Try again. Nothing was saved.');
    expect(failed).toMatch(
      /class="[^"]*h-11 min-h-\[44px\][^"]*rounded-lg[^"]*"[^>]*data-plan-save-retry=""/,
    );
    expect(failed).toContain('>Retry<');
    expect(failed).toContain('To must be on or after From.');
    expect(failed).toContain('bg-bad-soft');
  });

  it('the screen: Edit (agency, view) and Cancel / Editing plan / Save changes (edit); one plan_save; footer hidden', () => {
    const src = read('PlanScreen.tsx');
    expect(src).toContain('data-plan-edit=""');
    expect(src).toContain('backText: CANCEL_EDIT_LABEL');
    expect(src).toContain('titleSlot: editHeaderSlot');
    expect(src).toContain('{saving ? SAVING_LABEL : SAVE_CHANGES_LABEL}');
    expect(src).toContain(
      'planSave(supabase, { p_plan_id: planId, p_ops: ops, p_trace_id: traceId })',
    );
    expect(src.match(/planSave\(supabase/g)).toHaveLength(1);
    expect(src).toContain('toast.show({ title: PLAN_SAVED_TOAST })');
    expect(src).toContain('setSaveError(planSaveErrorCopy(result.error.message))');
    // Save with nothing queued only leaves edit mode.
    expect(src).toMatch(/if \(!hasQueuedOps\(ops\)\) \{\s*exitEdit\(\);\s*return;\s*\}/);
    // The footer is hidden in edit mode; the guard holds Back while dirty or saving.
    expect(src).toContain('!editMode && bundle !== null && (primary.kind');
    expect(src).toContain('active: props.open && (dirty || saving)');
    expect(src).toContain("setDiscardAsk('close')");
    expect(src).toMatch(/guard\.release\(\);\s*exitEdit\(\);/);
    // Keep the approval: the move op records the answer.
    expect(src).toContain('commitMove(ask.itemId, ask.toDay, ask.toIndex, keep)');
  });
});

describe('the footer (item 6)', () => {
  it('one primary action per state; a client never gets one', () => {
    expect(
      planPrimaryAction({ side: 'agency', audience: 'team', chat: { name: 'Priya' } }),
    ).toEqual({
      kind: 'send-approvers',
      label: 'Send to approvers in Priya',
    });
    expect(sendToApproversLabel('Priya')).toBe('Send to approvers in Priya');
    expect(
      planPrimaryAction({ side: 'agency', audience: 'client', chat: { name: 'Priya' } }),
    ).toEqual({
      kind: 'send',
      label: 'Send in Priya',
    });
    expect(planPrimaryAction({ side: 'agency', audience: 'team', chat: null })).toEqual({
      kind: 'open',
      label: 'Open for approvers',
    });
    expect(planPrimaryAction({ side: 'agency', audience: 'client', chat: null })).toEqual({
      kind: 'none',
    });
    expect(
      planPrimaryAction({ side: 'client', audience: 'client', chat: { name: 'Priya' } }),
    ).toEqual({ kind: 'none' });
    expect(
      planPrimaryAction({ side: 'unknown', audience: 'team', chat: { name: 'Priya' } }),
    ).toEqual({ kind: 'none' });
  });

  it('Send to approvers runs open then the card; a failed second step keeps a Retry that only reposts', () => {
    const src = read('PlanScreen.tsx');
    expect(src).toContain(
      "onConfirm={() => void openForClient(primary.kind === 'send-approvers')}",
    );
    expect(src).toMatch(
      /toast\.show\(\{ title: OPEN_FOR_CLIENT_TOAST \}\);[\s\S]*?if \(thenSend\) await sendHere\(true\);/,
    );
    expect(src).toContain('? SEND_AFTER_OPEN_FAILED');
    expect(SEND_AFTER_OPEN_FAILED).toBe(
      "Couldn't post the card. Try again. The plan is open for approvers.",
    );
    // Retry only reposts.
    expect(src).toMatch(/if \(sendError !== null\) \{[\s\S]*?void sendHere\(true\);/);
    expect(src).not.toContain('data-plan-go-card');
    expect(src).not.toContain('GO_TO_CARD_LABEL');
  });
});

describe('FT56 and FN25 copy', () => {
  it('"Creators X of N" on a Draft plan', () => {
    expect(progressLabel(planProgress(BUNDLE))).toBe('Creators 0 of 4');
  });

  it('the New plan title placeholder follows the chosen range', () => {
    expect(composeTitlePlaceholder({ startsOn: '2026-10-12', endsOn: '2026-10-18' })).toBe(
      'Week of 12 Oct',
    );
    expect(composeTitlePlaceholder({ startsOn: '2026-10-12', endsOn: '2026-10-25' })).toBe(
      '12 to 25 Oct',
    );
    expect(composeTitlePlaceholder({ startsOn: '2026-10-28', endsOn: '2026-11-03' })).toBe(
      '28 Oct to 3 Nov',
    );
    expect(composeTitlePlaceholder({ startsOn: '', endsOn: '' })).toBe('Plan name');
    const compose = read('PlanComposeScreen.tsx');
    expect(compose).toContain('placeholder={composeTitlePlaceholder(range)}');
    expect(compose).toContain('enterKeyHint="done"');
    expect(read('PlanItemScreen.tsx')).toContain('enterKeyHint="send"');
  });
});

describe('the plan_save migration record', () => {
  const sql = readRoot('supabase/migrations/20261019030000_plan_save.sql');
  it('the live definition, the grants, and nothing else', () => {
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.plan_save(p_plan_id uuid, p_ops jsonb, p_trace_id uuid)',
    );
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain("SET search_path TO ''");
    expect(sql).toContain('jsonb_array_length(p_ops) not between 1 and 200');
    for (const proc of [
      'plan_update',
      'plan_item_remove',
      'plan_item_move',
      'plan_items_reorder',
    ]) {
      expect(sql).toContain(`perform public.${proc}(`);
    }
    expect(sql).toContain("coalesce((v_op->>'keep_reviews')::boolean, true)");
    expect(sql).toContain(
      'revoke all on function public.plan_save(uuid,jsonb,uuid) from public, anon;',
    );
    expect(sql).toContain(
      'grant execute on function public.plan_save(uuid,jsonb,uuid) to authenticated;',
    );
    expect(sql).toMatch(/-- Rollback:/);
    expect(sql).not.toMatch(/\bdb push\b/);
  });
});
