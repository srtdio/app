import { describe, expect, it } from 'vitest';
import { buildResolveArgs } from '@/components/pages/pcs/checkpoint-controls';

// The resolution-note field is retired: Resolve is one tap, no note, so the
// args never carry p_resolution_note (the column stays; the proc stores null).
describe('buildResolveArgs (one tap, no note)', () => {
  it('resolve and reopen carry the id, the state and the explicit trace only', () => {
    expect(buildResolveArgs({ commentId: 'c-1', resolved: true, traceId: 't-1' })).toEqual({
      p_comment_id: 'c-1',
      p_resolved: true,
      p_trace_id: 't-1',
    });
    const reopen = buildResolveArgs({ commentId: 'c-1', resolved: false, traceId: 't-2' });
    expect(reopen).toEqual({ p_comment_id: 'c-1', p_resolved: false, p_trace_id: 't-2' });
    expect(reopen).not.toHaveProperty('p_resolution_note');
  });
});
