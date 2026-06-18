import { describe, it, expect } from 'vitest';
import {
  briefCloseFields,
  buildSnapshot,
  mapBriefStatus,
  mapPostStage,
} from '../src/transform.ts';

// Regression tests for the briefs close columns. The bug: load.ts set
// briefs.status from mapBriefStatus but never set closed_at/closed_by, so a
// status='closed' row inserted with both NULL and violated the v2
// briefs_closed_consistency CHECK:
//   (status='open'   AND closed_at IS NULL     AND closed_by IS NULL)
//   OR (status='closed' AND closed_at IS NOT NULL AND closed_by IS NOT NULL)
// briefCloseFields must keep every row self-consistent with that CHECK.

const OPERATOR = '00000000-0000-0000-0000-000000000001';

// Mirror of the DB CHECK so a passing assertion proves the row would insert.
function satisfiesConstraint(
  status: string,
  closedAt: Date | string | null,
  closedBy: string | null,
): boolean {
  return (
    (status === 'open' && closedAt === null && closedBy === null) ||
    (status === 'closed' && closedAt !== null && closedBy !== null)
  );
}

describe('briefCloseFields', () => {
  it('closed request maps to closed with both close columns non-null', () => {
    const status = mapBriefStatus('closed');
    const targetDate = new Date('2025-01-15T00:00:00.000Z');
    const close = briefCloseFields(status, targetDate, OPERATOR, new Date());

    expect(status).toBe('closed');
    expect(close.closed_at).toBe(targetDate);
    expect(close.closed_by).toBe(OPERATOR);
    expect(close.closed_at).not.toBeNull();
    expect(close.closed_by).not.toBeNull();
    expect(satisfiesConstraint(status, close.closed_at, close.closed_by)).toBe(true);
  });

  it('closed request with no target_date still gets a non-null closed_at fallback', () => {
    const status = mapBriefStatus('closed');
    const fallback = new Date('2026-06-08T12:00:00.000Z');
    const close = briefCloseFields(status, null, OPERATOR, fallback);

    expect(close.closed_at).toBe(fallback);
    expect(close.closed_at).not.toBeNull();
    expect(close.closed_by).toBe(OPERATOR);
    expect(satisfiesConstraint(status, close.closed_at, close.closed_by)).toBe(true);
  });

  it.each(['pending', 'assigned', null])(
    'non-closed status %s maps to open with both close columns null',
    (raw) => {
      const status = mapBriefStatus(raw);
      const close = briefCloseFields(status, new Date(), OPERATOR, new Date());

      expect(status).toBe('open');
      expect(close.closed_at).toBeNull();
      expect(close.closed_by).toBeNull();
      expect(satisfiesConstraint(status, close.closed_at, close.closed_by)).toBe(true);
    },
  );
});

// Regression for the v1 -> v2 post.stage mapping. The locked decision is that a
// v1 'ready' post is NOT yet approved: it maps to 'draft', not 'approved'. Only
// genuinely live work (published/scheduled) maps to 'approved'.
describe('mapPostStage', () => {
  it('maps ready to draft (not approved)', () => {
    expect(mapPostStage('ready', false)).toBe('draft');
  });

  it.each(['published', 'scheduled'])('maps %s to approved', (stage) => {
    expect(mapPostStage(stage, false)).toBe('approved');
  });

  it.each(['awaiting_approval', 'awaiting_brand_input'])('maps %s to review', (stage) => {
    expect(mapPostStage(stage, false)).toBe('review');
  });

  it('maps rejected to rejected and parked to parked', () => {
    expect(mapPostStage('rejected', false)).toBe('rejected');
    expect(mapPostStage('parked', false)).toBe('parked');
  });

  it('maps unknown/null stage to draft and lets is_draft win', () => {
    expect(mapPostStage('something_else', false)).toBe('draft');
    expect(mapPostStage(null, false)).toBe('draft');
    expect(mapPostStage('published', true)).toBe('draft');
  });
});

// Regression for the post_versions snapshot. The bug: the version snapshot read
// content/images/links/pillar/location from v1 post_versions columns that do not
// exist (FATAL: column pv.content does not exist). v1 stores only the edited
// caption plus edit metadata, so the body MUST come from the caption and the
// other provenance keys MUST be null/empty, not read from a phantom column. This
// mirrors how load.ts now shapes a version row from a V1PostVersion.
describe('buildSnapshot from a v1 post_version', () => {
  // A v1 post_versions row has exactly: caption + edited_by + edited_at.
  const v1Version = { caption: 'Launch is live', edited_by: 'Jane Doe', edited_at: new Date() };
  // Exactly the shape load.ts builds for the SnapshotInput now.
  const inputFromV1 = {
    content: v1Version.caption,
    caption: v1Version.caption,
    images: null,
    canvaLink: null,
    driveLink: null,
    linkedinLink: null,
    contentPillar: null,
    location: null,
    editedBy: v1Version.edited_by,
  } as const;

  it('sources the body/content from the v1 caption', () => {
    const snap = buildSnapshot(inputFromV1, false) as Record<string, unknown>;
    expect(snap.content).toBe('Launch is live');
    expect(snap.caption).toBe('Launch is live');
  });

  it('leaves every phantom v1 field null/empty rather than reading a missing column', () => {
    const snap = buildSnapshot(inputFromV1, false) as Record<string, unknown>;
    expect(snap.images).toEqual([]);
    expect(snap.canva_link).toBeNull();
    expect(snap.drive_link).toBeNull();
    expect(snap.linkedin_link).toBeNull();
    expect(snap.content_pillar).toBeNull();
    expect(snap.location).toBeNull();
  });

  it('preserves edited_by, and scrubs it in dev-seed', () => {
    expect((buildSnapshot(inputFromV1, false) as Record<string, unknown>).edited_by).toBe(
      'Jane Doe',
    );
    // dev-seed replaces the preserved person name with the redaction constant.
    expect((buildSnapshot(inputFromV1, true) as Record<string, unknown>).edited_by).toBe('Member');
  });
});
