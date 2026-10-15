import { describe, expect, it } from 'vitest';
import {
  ADD_FAILED,
  DATE_OUTSIDE_PLAN,
  PLAN_CREATE_ERROR_COPY,
  PLAN_CREATE_FAILED_COPY,
  isNetworkFailure,
  planWriteErrorCopy,
} from '@/components/chat/plan-card';

const create = (message: string): string =>
  planWriteErrorCopy(message, PLAN_CREATE_FAILED_COPY, PLAN_CREATE_ERROR_COPY);

describe('planWriteErrorCopy: New plan create', () => {
  it('maps each cause; never "Try again" alone', () => {
    expect(create('TypeError: Failed to fetch')).toBe(
      "Couldn't reach Sorted. Nothing was saved. Check your connection and tap Create plan again.",
    );
    expect(create('Load failed')).toBe(PLAN_CREATE_ERROR_COPY.network);
    expect(create('date_outside_plan')).toBe(
      "A post's date changed and is now outside this plan. Nothing was saved. Check the orange items.",
    );
    expect(create('invalid_payload')).toBe(
      'Something in this plan is no longer available, such as a deleted post. Nothing was saved.',
    );
    expect(create('forbidden_role')).toBe('Only creators can create plans.');
    expect(create('workspace_member_only')).toBe('Only creators can create plans.');
    expect(create('boom')).toBe(PLAN_CREATE_FAILED_COPY);
    for (const copy of [...Object.values(PLAN_CREATE_ERROR_COPY), PLAN_CREATE_FAILED_COPY]) {
      expect(copy).not.toBe('Try again');
      expect(copy).not.toContain(String.fromCharCode(0x2014));
    }
  });

  it('add and move keep their copy', () => {
    expect(planWriteErrorCopy('date_outside_plan', ADD_FAILED)).toBe(DATE_OUTSIDE_PLAN);
    expect(planWriteErrorCopy('invalid_payload', ADD_FAILED)).toBe(ADD_FAILED);
    expect(planWriteErrorCopy('Failed to fetch', ADD_FAILED)).toBe(ADD_FAILED);
    expect(isNetworkFailure('NetworkError when attempting to fetch resource.')).toBe(true);
    expect(isNetworkFailure('invalid_payload')).toBe(false);
  });
});
