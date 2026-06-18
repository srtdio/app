// Pure boundary coverage for every transform.ts mapping function. No database.
// Each stage / format / content_type value (including nulls) is asserted, plus
// the cases most often gotten wrong: published/scheduled -> approved, ready ->
// draft, and is_draft -> draft,
// the objective fallback when description is blank, truncation at each CHECK
// limit, and PII scrub redaction.

import { describe, expect, it } from 'vitest';

import {
  briefObjective,
  briefTitle,
  buildReferenceLinks,
  buildSnapshot,
  COMMENT_BODY_MAX,
  commentBody,
  isBlankComment,
  mapBriefFormatRequested,
  mapBriefStatus,
  mapPostFormat,
  mapPostStage,
  NAME_REDACTION,
  OBJECTIVE_MAX,
  postCaption,
  postOrigin,
  postTitle,
  redactPii,
  TITLE_MAX,
  truncate,
} from '../../packages/etl/src/transform';

describe('mapPostStage', () => {
  it('maps every published-like v1 stage to approved', () => {
    expect(mapPostStage('published', false)).toBe('approved');
    expect(mapPostStage('scheduled', false)).toBe('approved');
  });
  it('maps ready to draft (not approved)', () => {
    expect(mapPostStage('ready', false)).toBe('draft');
  });
  it('maps awaiting stages to review', () => {
    expect(mapPostStage('awaiting_approval', false)).toBe('review');
    expect(mapPostStage('awaiting_brand_input', false)).toBe('review');
  });
  it('carries rejected and parked through', () => {
    expect(mapPostStage('rejected', false)).toBe('rejected');
    expect(mapPostStage('parked', false)).toBe('parked');
  });
  it('defaults null/unknown to draft', () => {
    expect(mapPostStage(null, false)).toBe('draft');
    expect(mapPostStage('something_else', false)).toBe('draft');
  });
  it('lets is_draft override any stage to draft', () => {
    expect(mapPostStage('published', true)).toBe('draft');
    expect(mapPostStage('rejected', true)).toBe('draft');
    expect(mapPostStage(null, true)).toBe('draft');
  });
  it('is case-insensitive', () => {
    expect(mapPostStage('PUBLISHED', false)).toBe('approved');
  });
});

describe('mapPostFormat', () => {
  it('maps each v1 format', () => {
    expect(mapPostFormat('Photo')).toBe('single_image');
    expect(mapPostFormat('Creative')).toBe('single_image');
    expect(mapPostFormat('Carousel')).toBe('carousel');
    expect(mapPostFormat('Text')).toBe('text');
    expect(mapPostFormat('Video')).toBe('video');
  });
  it('defaults null/unknown to text', () => {
    expect(mapPostFormat(null)).toBe('text');
    expect(mapPostFormat('gif')).toBe('text');
  });
});

describe('mapBriefFormatRequested', () => {
  it('maps each v1 content_type', () => {
    expect(mapBriefFormatRequested('CREATIVE')).toBe('single_image');
    expect(mapBriefFormatRequested('PHOTO')).toBe('single_image');
    expect(mapBriefFormatRequested('VIDEO')).toBe('video');
    expect(mapBriefFormatRequested('TEXT')).toBe('text');
  });
  it('maps null/unknown to null', () => {
    expect(mapBriefFormatRequested(null)).toBeNull();
    expect(mapBriefFormatRequested('OTHER')).toBeNull();
  });
});

describe('mapBriefStatus', () => {
  it('maps closed to closed and everything else to open', () => {
    expect(mapBriefStatus('closed')).toBe('closed');
    expect(mapBriefStatus('pending')).toBe('open');
    expect(mapBriefStatus('assigned')).toBe('open');
    expect(mapBriefStatus(null)).toBe('open');
  });
});

describe('briefObjective', () => {
  it('uses description when present', () => {
    expect(briefObjective('Do the thing', 'Title', false)).toBe('Do the thing');
  });
  it('falls back to title when description is blank', () => {
    expect(briefObjective('', 'Title', false)).toBe('Title');
    expect(briefObjective('   ', 'Title', false)).toBe('Title');
    expect(briefObjective(null, 'Title', false)).toBe('Title');
  });
  it('uses a safe placeholder when both are blank', () => {
    expect(briefObjective(null, null, false)).toBe('Untitled brief');
  });
  it('truncates to the objective CHECK limit', () => {
    const long = 'x'.repeat(OBJECTIVE_MAX + 50);
    expect(briefObjective(long, null, false)).toHaveLength(OBJECTIVE_MAX);
  });
  it('scrubs PII when asked', () => {
    expect(briefObjective('mail me a@b.com', null, true)).toBe('mail me [redacted-email]');
  });
});

describe('briefTitle / postTitle', () => {
  it('placeholders blank titles', () => {
    expect(briefTitle(null)).toBe('Untitled brief');
    expect(briefTitle('   ')).toBe('Untitled brief');
    expect(postTitle(null)).toBe('Untitled post');
  });
  it('truncates to the title CHECK limit', () => {
    expect(briefTitle('t'.repeat(TITLE_MAX + 10))).toHaveLength(TITLE_MAX);
    expect(postTitle('t'.repeat(TITLE_MAX + 10))).toHaveLength(TITLE_MAX);
  });
});

describe('truncate', () => {
  it('keeps values at the limit and cuts longer ones', () => {
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('abcd', 3)).toBe('abc');
    expect(truncate('a', 3)).toBe('a');
  });
});

describe('buildReferenceLinks', () => {
  it('preserves drive_link and the images array', () => {
    expect(buildReferenceLinks('https://d', ['a', 'b'])).toEqual({
      drive_link: 'https://d',
      images: ['a', 'b'],
    });
  });
  it('normalises nulls to null drive_link and empty images', () => {
    expect(buildReferenceLinks(null, null)).toEqual({ drive_link: null, images: [] });
  });
});

describe('postCaption', () => {
  it('passes null through', () => {
    expect(postCaption(null, true)).toBeNull();
  });
  it('scrubs only in scrub mode', () => {
    expect(postCaption('a@b.com', false)).toBe('a@b.com');
    expect(postCaption('a@b.com', true)).toBe('[redacted-email]');
  });
});

describe('postOrigin', () => {
  it('is brief when a mapped brief id is present', () => {
    expect(postOrigin('brief-1')).toEqual({ origin: 'brief', briefId: 'brief-1' });
  });
  it('is manual when there is no mapped brief', () => {
    expect(postOrigin(null)).toEqual({ origin: 'manual', briefId: null });
  });
});

describe('buildSnapshot', () => {
  const input = {
    content: 'call 98765 43210',
    caption: 'see admin@example.com',
    images: ['https://img/1.jpg'],
    canvaLink: 'https://canva',
    driveLink: 'https://drive',
    linkedinLink: 'https://li',
    contentPillar: 'awareness',
    location: 'Mumbai',
    editedBy: 'Jane Doe',
  };
  it('preserves all v1-only fields without scrub', () => {
    expect(buildSnapshot(input, false)).toEqual({
      content: 'call 98765 43210',
      caption: 'see admin@example.com',
      images: ['https://img/1.jpg'],
      canva_link: 'https://canva',
      drive_link: 'https://drive',
      linkedin_link: 'https://li',
      content_pillar: 'awareness',
      location: 'Mumbai',
      edited_by: 'Jane Doe',
    });
  });
  it('redacts text and replaces the person name in scrub mode', () => {
    const out = buildSnapshot(input, true) as Record<string, unknown>;
    expect(out.content).toBe('call [redacted-phone]');
    expect(out.caption).toBe('see [redacted-email]');
    expect(out.edited_by).toBe(NAME_REDACTION);
    expect(out.images).toEqual(['https://img/1.jpg']);
  });
  it('keeps a null person name null even in scrub mode', () => {
    const out = buildSnapshot({ ...input, editedBy: null }, true) as Record<string, unknown>;
    expect(out.edited_by).toBeNull();
  });
});

describe('commentBody / isBlankComment', () => {
  it('truncates to the body CHECK limit', () => {
    expect(commentBody('b'.repeat(COMMENT_BODY_MAX + 5), false)).toHaveLength(COMMENT_BODY_MAX);
  });
  it('scrubs when asked', () => {
    expect(commentBody('ping a@b.com', true)).toBe('ping [redacted-email]');
  });
  it('detects blank messages', () => {
    expect(isBlankComment('')).toBe(true);
    expect(isBlankComment('   ')).toBe(true);
    expect(isBlankComment(null)).toBe(true);
    expect(isBlankComment('hi')).toBe(false);
  });
});

describe('redactPii', () => {
  it('redacts emails', () => {
    expect(redactPii('reach jane.doe+x@sub.example.co')).toBe('reach [redacted-email]');
  });
  it('redacts phone-like runs', () => {
    expect(redactPii('call +91 98765 43210 today')).toBe('call [redacted-phone] today');
  });
  it('leaves plain text untouched', () => {
    expect(redactPii('a normal sentence with no PII')).toBe('a normal sentence with no PII');
  });
});
