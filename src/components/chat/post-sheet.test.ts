import { describe, expect, it, vi } from 'vitest';
import type { PostCardRow } from '../../../packages/posts/src/reads';
import { POST_CHANGED_EVENT } from '@/components/chat/post-card';
import {
  agencyWaitingHint,
  creatorSubject,
  commentToast,
  confirmCopy,
  detailRows,
  dispatchPostChanged,
  durationLabel,
  friendlyCommentError,
  postSubject,
  reelLabel,
  sheetTitle,
  stripCounter,
} from '@/components/chat/post-sheet';

function row(over: Partial<PostCardRow> = {}): PostCardRow {
  return {
    id: 'p1',
    number: 12,
    title: 'Diwali carousel',
    platform: 'instagram',
    format: 'carousel',
    stage: 'review',
    target_date: '2026-10-02',
    stage_entered_at: '2026-09-20T10:00:00Z',
    approved_by: null,
    approved_at: null,
    thumbnailAssetVersionId: null,
    firstMedia: null,
    mediaCount: 0,
    hasVideo: false,
    ...over,
  };
}

const TZ = 'UTC';

describe('agencyWaitingHint', () => {
  it('the agency side in review: waiting on approvers since the day it entered review', () => {
    expect(agencyWaitingHint('agency', row({ stage: 'review' }), TZ)).toBe(
      'Waiting on approvers since 20 Sep',
    );
  });

  it('nobody else, and no other stage, gets a line', () => {
    expect(agencyWaitingHint('client', row({ stage: 'review' }), TZ)).toBeNull();
    expect(agencyWaitingHint('unknown', row({ stage: 'review' }), TZ)).toBeNull();
    for (const stage of ['draft', 'approved', 'parked', 'rejected']) {
      expect(agencyWaitingHint('agency', row({ stage }), TZ)).toBeNull();
    }
  });
});

describe('labels and copy', () => {
  it('approve confirm names the post, every slide and the target date', () => {
    const copy = confirmCopy('approve', {
      subject: 'Diwali carousel',
      mediaCount: 5,
      targetDate: 'Oct 2',
    });
    expect(copy.question).toBe('Approve Diwali carousel, all 5 slides, for Oct 2?');
    expect(copy.detail).toBe('This is logged as your approval and the creators are notified.');
    expect(copy.confirmLabel).toBe('Approve');
  });

  it('approve confirm drops the slide and date clauses it has no value for', () => {
    expect(
      confirmCopy('approve', { subject: 'Diwali carousel', mediaCount: 1, targetDate: '' })
        .question,
    ).toBe('Approve Diwali carousel, 1 slide?');
    expect(
      confirmCopy('approve', { subject: 'Diwali carousel', mediaCount: 0, targetDate: '' })
        .question,
    ).toBe('Approve Diwali carousel?');
  });

  it('send-for-review confirm has its own copy', () => {
    const copy = confirmCopy('send_review', {
      subject: 'Diwali carousel',
      mediaCount: 3,
      targetDate: 'Oct 2',
    });
    expect(copy.question).toBe('Send Diwali carousel to the approvers for review?');
    expect(copy.detail).toBe(
      'It leaves draft, and approvers can approve it or comment, or you can approve on their behalf.',
    );
    expect(copy.confirmLabel).toBe('Send for review');
  });

  it('the comment toast', () => {
    expect(commentToast()).toBe('Comment added');
  });

  it('reject confirm names the creator by first name, else "The creator"', () => {
    const args = { subject: 'Launch', mediaCount: 2, targetDate: 'Oct 2' };
    expect(confirmCopy('reject', { ...args, creatorName: 'Priya Shah' })).toEqual({
      question: 'Reject this post?',
      detail: 'Priya gets it back to rework. You can send a reason.',
      confirmLabel: 'Reject',
    });
    expect(confirmCopy('reject', args).detail).toBe(
      'The creator gets it back to rework. You can send a reason.',
    );
    expect(creatorSubject('   ')).toBe('The creator');
    expect(creatorSubject(null)).toBe('The creator');
  });

  it('reject copy never says client or agency', () => {
    const reject = confirmCopy('reject', { subject: 'Launch', mediaCount: 0, targetDate: '' });
    const lines = [...Object.values(reject)];
    for (const line of lines) {
      expect(line).not.toMatch(/client|agency/i);
      expect(line).not.toContain('\u2014');
    }
  });

  it('postSubject: the trimmed title, or "this post" when there is none', () => {
    expect(postSubject('Diwali carousel')).toBe('Diwali carousel');
    expect(postSubject('  Diwali carousel  ')).toBe('Diwali carousel');
    expect(postSubject('')).toBe('this post');
    expect(postSubject('   ')).toBe('this post');
    expect(postSubject(null)).toBe('this post');
    expect(postSubject(undefined)).toBe('this post');
    expect(
      confirmCopy('approve', { subject: postSubject(null), mediaCount: 0, targetDate: '' }),
    ).toMatchObject({ question: 'Approve this post?', confirmLabel: 'Approve' });
  });

  it('no label, confirm or toast carries a KEY-N code', () => {
    const code = /\b[A-Z]{2,}-\d+\b/;
    const lines = [
      ...Object.values(
        confirmCopy('approve', { subject: 'Launch', mediaCount: 2, targetDate: '' }),
      ),
      ...Object.values(
        confirmCopy('send_review', { subject: 'Launch', mediaCount: 2, targetDate: '' }),
      ),
      commentToast(),
      sheetTitle('carousel'),
    ];
    for (const line of lines) expect(line).not.toMatch(code);
  });

  it('comment errors map to plain copy', () => {
    expect(friendlyCommentError('invalid_stage')).toBe('Comments open once the post is in review.');
    expect(friendlyCommentError('mystery')).toBe("Couldn't add the comment. Try again.");
    expect(friendlyCommentError('forbidden_role')).toBe(
      "Couldn't add the comment. You don't have access to do this.",
    );
  });

  it('no user-facing copy carries an em-dash', () => {
    const copy = [
      'Waiting on approvers',
      ...Object.values(
        confirmCopy('approve', { subject: 'Launch', mediaCount: 2, targetDate: 'Oct 2' }),
      ),
      ...Object.values(
        confirmCopy('send_review', { subject: 'Launch', mediaCount: 2, targetDate: '' }),
      ),
      friendlyCommentError('invalid_stage'),
      friendlyCommentError('x'),
    ];
    for (const line of copy) expect(line).not.toContain('—');
  });

  it('title is the format label alone', () => {
    expect(sheetTitle('carousel')).toBe('Carousel');
    expect(sheetTitle('carousel')).not.toContain(' · ');
  });

  it('strip counter', () => {
    expect(stripCounter(0, 5)).toBe('1 / 5');
  });
});

describe('media labels', () => {
  it('durationLabel is m:ss', () => {
    expect(durationLabel(0)).toBe('0:00');
    expect(durationLabel(9_400)).toBe('0:09');
    expect(durationLabel(75_000)).toBe('1:15');
    expect(durationLabel(null)).toBe('');
    expect(durationLabel(-1)).toBe('');
  });

  it('reelLabel only for a video-format post whose video has a duration', () => {
    const video = { kind: 'video', mimeType: 'video/mp4', durationMs: 31_000 };
    const image = { kind: 'image', mimeType: 'image/jpeg', durationMs: null };
    expect(reelLabel('video', [video])).toBe('Reel · 0:31');
    expect(reelLabel('video', [image, video])).toBe('Reel · 0:31');
    expect(reelLabel('carousel', [video])).toBeNull();
    expect(reelLabel('video', [{ ...video, durationMs: null }])).toBeNull();
    expect(reelLabel('video', [image])).toBeNull();
  });
});

describe('detailRows', () => {
  it('target date, then format with the slide count past one', () => {
    const rows = detailRows(row({ mediaCount: 4 }), null, TZ, TZ);
    expect(rows.map((r) => r.key)).toEqual(['target', 'format']);
    expect(rows[0]).toMatchObject({ label: 'Target date', value: '2 Oct' });
    expect(rows[1]?.value).toMatch(/ · 4 slides$/);
    expect(detailRows(row({ mediaCount: 1 }), null, TZ, TZ)[1]?.value).not.toContain('slides');
  });

  it('the target date is its calendar day on the workspace zone, not the device zone', () => {
    // 20:00Z on 1 Oct is already 2 Oct in Kolkata.
    const at = row({ target_date: '2026-10-01T20:00:00Z' });
    expect(detailRows(at, null, 'UTC', 'Asia/Kolkata')[0]?.value).toBe('2 Oct');
    expect(detailRows(at, null, 'Asia/Kolkata', 'UTC')[0]?.value).toBe('1 Oct');
  });

  it('no target date: no target row', () => {
    expect(detailRows(row({ target_date: null }), null, TZ, TZ).map((r) => r.key)).toEqual([
      'format',
    ]);
  });

  it('approved with an approver: name · date time', () => {
    const rows = detailRows(
      row({ stage: 'approved', approved_by: 'u1', approved_at: '2026-10-01T09:05:00Z' }),
      'Asha',
      TZ,
      TZ,
    );
    const approved = rows.find((r) => r.key === 'approved');
    expect(approved?.label).toBe('Approved');
    expect(approved?.value).toBe('Asha · 1 Oct, 9:05 AM');
  });

  it('approved with no approver: the date it entered approved', () => {
    const rows = detailRows(row({ stage: 'approved' }), null, TZ, TZ);
    expect(rows.find((r) => r.key === 'approved')?.value).toBe('20 Sep');
  });

  it('not approved and no approver: no approval row', () => {
    expect(detailRows(row(), null, TZ, TZ).find((r) => r.key === 'approved')).toBeUndefined();
  });
});

describe('dispatchPostChanged', () => {
  it('dispatchPostChanged sends the PR 2 event with the post id', () => {
    const target = new EventTarget();
    const seen = vi.fn();
    target.addEventListener(POST_CHANGED_EVENT, (e) => seen((e as CustomEvent).detail));
    dispatchPostChanged(target, 'p9');
    expect(POST_CHANGED_EVENT).toBe('sorted:post-changed');
    expect(seen).toHaveBeenCalledWith({ postId: 'p9' });
  });
});

describe('detailRows approver suffix', () => {
  const approved = row({
    stage: 'approved',
    approved_by: 'u1',
    approved_at: '2026-09-21T14:05:00Z',
  });

  it('suffixes an agency-side approver', () => {
    const value = detailRows(approved, 'Chitra', TZ, TZ, 'agency').find(
      (r) => r.key === 'approved',
    );
    expect(value?.value.startsWith('Chitra on behalf of the approvers · ')).toBe(true);
  });

  it('a client approver or a missing role: name only', () => {
    for (const role of ['client', null]) {
      const value = detailRows(approved, 'Asha', TZ, TZ, role).find((r) => r.key === 'approved');
      expect(value?.value.startsWith('Asha · ')).toBe(true);
    }
  });
});
