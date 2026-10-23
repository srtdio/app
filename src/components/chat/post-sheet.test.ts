import { describe, expect, it, vi } from 'vitest';
import type { PostCardRow } from '../../../packages/posts/src/reads';
import { POST_CHANGED_EVENT } from '@/components/chat/post-card';
import {
  CLIENT_REVIEW_HINT,
  REJECT_ERROR,
  REJECT_REASON_HELPER,
  REJECT_REASON_LABEL,
  actionLabel,
  creatorSubject,
  approvedPillLabel,
  commentToast,
  confirmCopy,
  confirmTarget,
  detailRows,
  dispatchPostChanged,
  durationLabel,
  friendlyCommentError,
  postSubject,
  reelLabel,
  runStageChange,
  sheetActions,
  sheetTitle,
  stripCounter,
  successToast,
  type StageChangeDeps,
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

describe('sheetActions', () => {
  it('client in review: approve, reject, comment, open, with the one-at-a-time hint', () => {
    const set = sheetActions('client', row({ stage: 'review' }), TZ);
    expect(set.actions).toEqual(['approve', 'reject', 'comment', 'open_post']);
    expect(set.hint).toBe(CLIENT_REVIEW_HINT);
    expect(CLIENT_REVIEW_HINT).toBe('One post at a time. Comments keep it in review.');
    expect(set.approvedPill).toBe(false);
  });

  it('client on an approved post: reject and open, with the approved pill', () => {
    const set = sheetActions('client', row({ stage: 'approved' }), TZ);
    expect(set.actions).toEqual(['reject', 'open_post']);
    expect(set.hint).toBeNull();
    expect(set.approvedPill).toBe(true);
  });

  it('client elsewhere: open only, no pill', () => {
    for (const stage of ['parked', 'rejected', 'draft']) {
      const set = sheetActions('client', row({ stage }), TZ);
      expect(set.actions).toEqual(['open_post']);
      expect(set.hint).toBeNull();
      expect(set.approvedPill).toBe(false);
    }
  });

  it('the agency side never gets Reject', () => {
    for (const stage of ['draft', 'review', 'approved', 'parked', 'rejected']) {
      expect(sheetActions('agency', row({ stage }), TZ).actions).not.toContain('reject');
    }
    expect(sheetActions('unknown', row({ stage: 'approved' }), TZ).actions).toEqual(['open_post']);
  });

  it('agency in draft: send for review, open in pipeline', () => {
    const set = sheetActions('agency', row({ stage: 'draft' }), TZ);
    expect(set.actions).toEqual(['send_review', 'open_pipeline']);
    expect(set.hint).toBeNull();
  });

  it('agency in review: approve on their behalf, open in pipeline; elsewhere open in pipeline', () => {
    const review = sheetActions('agency', row({ stage: 'review' }), TZ);
    expect(review.actions).toEqual(['approve', 'open_pipeline']);
    expect(review.hint).toBe('Waiting on approvers since 20 Sep');
    for (const stage of ['approved', 'parked', 'rejected']) {
      const set = sheetActions('agency', row({ stage }), TZ);
      expect(set.actions).toEqual(['open_pipeline']);
      expect(set.hint).toBeNull();
      expect(set.approvedPill).toBe(false);
    }
  });

  it('an unresolved side is never offered a write', () => {
    const set = sheetActions('unknown', row({ stage: 'review' }), TZ);
    expect(set.actions).toEqual(['open_post']);
  });
});

describe('labels and copy', () => {
  it('action labels', () => {
    expect(actionLabel('approve')).toBe('Approve');
    expect(actionLabel('reject')).toBe('Reject');
    expect(actionLabel('comment')).toBe('Comment on this post');
    expect(actionLabel('open_post')).toBe('Open full post');
    expect(actionLabel('send_review')).toBe('Send for review');
    expect(actionLabel('open_pipeline')).toBe('Open post');
  });

  it('approved pill names the approver when known', () => {
    expect(approvedPillLabel('Asha')).toBe('Approved by Asha');
    expect(approvedPillLabel(null)).toBe('Approved');
  });

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

  it('confirm targets and toasts', () => {
    expect(confirmTarget('approve')).toBe('approved');
    expect(confirmTarget('send_review')).toBe('review');
    expect(confirmTarget('reject')).toBe('rejected');
    expect(successToast('approve')).toBe('Post approved');
    expect(successToast('reject')).toBe('Post rejected');
    expect(successToast('send_review')).toBe('Post sent for review');
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
    expect(REJECT_REASON_LABEL).toBe('Reason (optional)');
    expect(REJECT_REASON_HELPER).toBe('Goes to the comments.');
  });

  it('reject copy never says client or agency', () => {
    const reject = confirmCopy('reject', { subject: 'Launch', mediaCount: 0, targetDate: '' });
    const lines = [
      ...Object.values(reject),
      REJECT_REASON_LABEL,
      REJECT_REASON_HELPER,
      REJECT_ERROR,
      actionLabel('reject'),
      actionLabel('open_pipeline'),
      successToast('reject'),
    ];
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
      actionLabel('approve'),
      actionLabel('send_review'),
      ...Object.values(
        confirmCopy('approve', { subject: 'Launch', mediaCount: 2, targetDate: '' }),
      ),
      ...Object.values(
        confirmCopy('send_review', { subject: 'Launch', mediaCount: 2, targetDate: '' }),
      ),
      successToast('approve'),
      successToast('send_review'),
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
      CLIENT_REVIEW_HINT,
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
    const rows = detailRows(row({ mediaCount: 4 }), null, TZ);
    expect(rows.map((r) => r.key)).toEqual(['target', 'format']);
    expect(rows[0]).toMatchObject({ label: 'Target date', value: '2 Oct' });
    expect(rows[1]?.value).toMatch(/ · 4 slides$/);
    expect(detailRows(row({ mediaCount: 1 }), null, TZ)[1]?.value).not.toContain('slides');
  });

  it('no target date: no target row', () => {
    expect(detailRows(row({ target_date: null }), null, TZ).map((r) => r.key)).toEqual(['format']);
  });

  it('approved with an approver: name · date time', () => {
    const rows = detailRows(
      row({ stage: 'approved', approved_by: 'u1', approved_at: '2026-10-01T09:05:00Z' }),
      'Asha',
      TZ,
    );
    const approved = rows.find((r) => r.key === 'approved');
    expect(approved?.label).toBe('Approved');
    expect(approved?.value).toMatch(/^Asha · 1 Oct /);
  });

  it('approved with no approver: the date it entered approved', () => {
    const rows = detailRows(row({ stage: 'approved' }), null, TZ);
    expect(rows.find((r) => r.key === 'approved')?.value).toBe('20 Sep');
  });

  it('not approved and no approver: no approval row', () => {
    expect(detailRows(row(), null, TZ).find((r) => r.key === 'approved')).toBeUndefined();
  });
});

function fakeDeps(result: Awaited<ReturnType<StageChangeDeps['transition']>>) {
  const target = new EventTarget();
  const events: unknown[] = [];
  target.addEventListener(POST_CHANGED_EVENT, (e) => events.push((e as CustomEvent).detail));
  const deps = {
    transition: vi.fn(async () => result),
    target,
    toast: vi.fn(),
    close: vi.fn(),
  };
  return { deps, events };
}

describe('runStageChange', () => {
  it('approve: one transition with the right args, then event, close and toast', async () => {
    const { deps, events } = fakeDeps({ ok: true, data: 'p1' });
    const error = await runStageChange(deps, {
      kind: 'approve',
      postId: 'p1',
      traceId: 't-1',
    });
    expect(error).toBeNull();
    expect(deps.transition).toHaveBeenCalledTimes(1);
    expect(deps.transition).toHaveBeenCalledWith({
      postId: 'p1',
      toStage: 'approved',
      traceId: 't-1',
    });
    expect(events).toEqual([{ postId: 'p1' }]);
    expect(deps.close).toHaveBeenCalledTimes(1);
    expect(deps.toast).toHaveBeenCalledWith('Post approved');
  });

  it('send for review moves to review and toasts its own line', async () => {
    const { deps, events } = fakeDeps({ ok: true, data: 'p1' });
    await runStageChange(deps, { kind: 'send_review', postId: 'p1', traceId: 't' });
    expect(deps.transition).toHaveBeenCalledWith(expect.objectContaining({ toStage: 'review' }));
    expect(events).toEqual([{ postId: 'p1' }]);
    expect(deps.toast).toHaveBeenCalledWith('Post sent for review');
  });

  it('a failure returns the friendly copy and announces nothing', async () => {
    const { deps, events } = fakeDeps({
      ok: false,
      error: { code: 'forbidden_role', message: 'forbidden_role' },
    });
    const error = await runStageChange(deps, {
      kind: 'approve',
      postId: 'p1',
      traceId: 't',
    });
    expect(error).toBe("Couldn't approve the post. You don't have access to do this.");
    expect(deps.transition).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    expect(deps.close).not.toHaveBeenCalled();
    expect(deps.toast).not.toHaveBeenCalled();
  });

  it('a thrown transport error still resolves to copy', async () => {
    const { deps } = fakeDeps({ ok: true, data: 'p1' });
    deps.transition.mockRejectedValueOnce(new Error('offline'));
    const error = await runStageChange(deps, {
      kind: 'approve',
      postId: 'p1',
      traceId: 't',
    });
    expect(error).toBe("Couldn't approve the post. Try again.");
    expect(deps.close).not.toHaveBeenCalled();
  });

  it('reject: moves to rejected, then posts the trimmed reason as a comment', async () => {
    const { deps, events } = fakeDeps({ ok: true, data: 'p1' });
    const postReason = vi.fn(async () => ({ ok: true }));
    const error = await runStageChange(
      { ...deps, postReason },
      { kind: 'reject', postId: 'p1', traceId: 't-r', reason: '  Wrong logo  ' },
    );
    expect(error).toBeNull();
    expect(deps.transition).toHaveBeenCalledWith({
      postId: 'p1',
      toStage: 'rejected',
      traceId: 't-r',
    });
    expect(events).toEqual([{ postId: 'p1' }]);
    expect(postReason).toHaveBeenCalledTimes(1);
    expect(postReason).toHaveBeenCalledWith('Wrong logo');
    expect(deps.toast).toHaveBeenCalledWith('Post rejected');
    expect(deps.close).toHaveBeenCalledTimes(1);
  });

  it('reject with no reason posts no comment', async () => {
    const { deps } = fakeDeps({ ok: true, data: 'p1' });
    const postReason = vi.fn(async () => ({ ok: true }));
    await runStageChange(
      { ...deps, postReason },
      { kind: 'reject', postId: 'p1', traceId: 't', reason: '   ' },
    );
    expect(postReason).not.toHaveBeenCalled();
  });

  it('a reason that fails to post toasts so; the move still stands', async () => {
    const { deps } = fakeDeps({ ok: true, data: 'p1' });
    const postReason = vi.fn(async () => {
      throw new Error('offline');
    });
    const error = await runStageChange(
      { ...deps, postReason },
      { kind: 'reject', postId: 'p1', traceId: 't', reason: 'Too long' },
    );
    expect(error).toBeNull();
    expect(deps.toast).toHaveBeenCalledWith("Rejected, but your reason didn't post.");
  });

  it('a failed reject shows the fixed line, never server text, and posts no reason', async () => {
    const { deps, events } = fakeDeps({
      ok: false,
      error: { code: 'invalid_stage_transition', message: 'raw server text' },
    });
    const postReason = vi.fn(async () => ({ ok: true }));
    const error = await runStageChange(
      { ...deps, postReason },
      { kind: 'reject', postId: 'p1', traceId: 't', reason: 'Wrong logo' },
    );
    expect(error).toBe("Couldn't move the post. Try again.");
    expect(error).toBe(REJECT_ERROR);
    expect(events).toEqual([]);
    expect(postReason).not.toHaveBeenCalled();
    expect(deps.close).not.toHaveBeenCalled();

    const thrown = fakeDeps({ ok: true, data: 'p1' });
    thrown.deps.transition.mockRejectedValueOnce(new Error('offline'));
    expect(await runStageChange(thrown.deps, { kind: 'reject', postId: 'p1', traceId: 't' })).toBe(
      REJECT_ERROR,
    );
  });

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
    const value = detailRows(approved, 'Chitra', TZ, 'agency').find((r) => r.key === 'approved');
    expect(value?.value.startsWith('Chitra on behalf of the approvers · ')).toBe(true);
  });

  it('a client approver or a missing role: name only', () => {
    for (const role of ['client', null]) {
      const value = detailRows(approved, 'Asha', TZ, role).find((r) => r.key === 'approved');
      expect(value?.value.startsWith('Asha · ')).toBe(true);
    }
  });

  it('the approved pill matches', () => {
    expect(approvedPillLabel('Chitra', 'agency')).toBe(
      'Approved by Chitra on behalf of the approvers',
    );
    expect(approvedPillLabel('Asha', 'client')).toBe('Approved by Asha');
    expect(approvedPillLabel('Asha')).toBe('Approved by Asha');
  });
});
