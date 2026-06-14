import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { MoveSheet } from '@/components/pages/pipeline/MoveSheet';
import { stageLabel } from '@/components/pages/pipeline/stage-meta';
import { STAGE_TRANSITIONS, canTransition } from '@srtdio/posts';
import type { PipelinePost, Stage } from '@srtdio/posts';

const STAGES = Object.keys(STAGE_TRANSITIONS) as Stage[];

function makePost(stage: Stage): PipelinePost {
  return {
    id: 'p1',
    workspace_id: 'w',
    title: 'A post',
    stage,
    platform: 'instagram',
    format: 'reel',
    origin: 'manual',
    caption: null,
    brief_id: null,
    bucket_id: null,
    owner_user_id: 'u',
    created_by: 'u',
    target_date: null,
    deleted_at: null,
    row_version: 1,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    stage_entered_at: '2026-01-01',
    thumbnailAssetVersionId: null,
  };
}

function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

function collect(node: ReactNode, found: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, found));
    return;
  }
  if (!isElement(node)) return;
  found.push(node);
  collect((node.props as { children?: ReactNode }).children, found);
}

/** The label string carried by a target button (the stage name span). */
function labelOf(button: ReactElement): string | undefined {
  const inner: ReactElement[] = [];
  collect((button.props as { children?: ReactNode }).children, inner);
  for (const el of inner) {
    const child = (el.props as { children?: ReactNode }).children;
    if (typeof child === 'string' && STAGES.some((s) => stageLabel(s) === child)) {
      return child;
    }
  }
  return undefined;
}

function targetRows(source: Stage, busy = false): { label: string; disabled: boolean }[] {
  const tree = MoveSheet({
    open: true,
    post: makePost(source),
    onClose: () => {},
    onMove: () => {},
    busy,
  });
  const all: ReactElement[] = [];
  collect(tree, all);
  return all
    .filter((el) => el.type === 'button')
    .map((button) => ({
      label: labelOf(button) ?? '',
      disabled: Boolean((button.props as { disabled?: boolean }).disabled),
    }))
    .filter((row) => row.label !== '');
}

describe('MoveSheet', () => {
  it('renders one row per OTHER stage with the current stage omitted', () => {
    for (const source of STAGES) {
      const rows = targetRows(source);
      expect(rows.map((r) => r.label).sort()).toEqual(
        STAGES.filter((s) => s !== source)
          .map(stageLabel)
          .sort(),
      );
    }
  });

  it('enables legal targets and disables the rest per the transition map (draft)', () => {
    const rows = targetRows('draft');
    const enabled = rows
      .filter((r) => !r.disabled)
      .map((r) => r.label)
      .sort();
    const disabled = rows
      .filter((r) => r.disabled)
      .map((r) => r.label)
      .sort();
    // draft -> review, parked are legal; approved, rejected are not.
    expect(enabled).toEqual([stageLabel('parked'), stageLabel('review')].sort());
    expect(disabled).toEqual([stageLabel('approved'), stageLabel('rejected')].sort());
    // The enabled set matches the canTransition mirror exactly.
    for (const row of rows) {
      const stage = STAGES.find((s) => stageLabel(s) === row.label)!;
      expect(!row.disabled).toBe(canTransition('draft', stage));
    }
  });

  it('enables only the legal target per the transition map (parked)', () => {
    const rows = targetRows('parked');
    const enabled = rows
      .filter((r) => !r.disabled)
      .map((r) => r.label)
      .sort();
    const disabled = rows
      .filter((r) => r.disabled)
      .map((r) => r.label)
      .sort();
    // parked -> review only.
    expect(enabled).toEqual([stageLabel('review')]);
    expect(disabled).toEqual(
      [stageLabel('draft'), stageLabel('approved'), stageLabel('rejected')].sort(),
    );
  });

  it('a legal row calls onMove with the post id and target stage', () => {
    const onMove = vi.fn();
    const tree = MoveSheet({
      open: true,
      post: makePost('draft'),
      onClose: () => {},
      onMove,
    });
    const all: ReactElement[] = [];
    collect(tree, all);
    const reviewRow = all.find(
      (el) => el.type === 'button' && labelOf(el) === stageLabel('review'),
    )!;
    (reviewRow.props as { onClick: () => void }).onClick();
    expect(onMove).toHaveBeenCalledWith('p1', 'review');
  });

  it('disables every move target while busy (in-flight move), overriding legality', () => {
    const rows = targetRows('draft', true);
    expect(rows.length).toBeGreaterThan(0);
    // draft has legal targets (review, parked) that are enabled when idle; busy
    // disables them too. Fails if MoveSheet ignores the busy prop.
    expect(rows.every((row) => row.disabled)).toBe(true);
  });

  it('keeps legal targets enabled when not busy', () => {
    const rows = targetRows('draft', false);
    expect(rows.some((row) => !row.disabled)).toBe(true);
  });

  it('renders nothing when there is no post', () => {
    expect(MoveSheet({ open: false, post: null, onClose: () => {}, onMove: () => {} })).toBeNull();
  });
});
