import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/shell/PageHead';
import { IconBriefs, IconPlus } from '@/components/ui/icons';
import { BriefCard, BRIEF_STATUS, isBriefClosed } from '@/components/pages/BriefCard';
import type { BriefStatus } from '@/components/pages/BriefCard';
import { CreateBriefSheet } from '@/components/pages/CreateBriefSheet';
import { dispatchSorted } from '@/lib/events';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { useNewTrace } from '@/lib/trace-context';
import { briefClose } from '@srtdio/rpc';
import { listBriefs } from '@srtdio/briefs';
import type { Brief } from '@srtdio/briefs';

// Filter chips: All shows everything; Open/Closed key off brief.status. The
// status keys come from the @srtdio/briefs type, never inline literals.
type FilterKey = 'all' | BriefStatus;
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: BRIEF_STATUS.open, label: 'Open' },
  { key: BRIEF_STATUS.closed, label: 'Closed' },
];

export function BriefsPage() {
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();
  const newTrace = useNewTrace();
  const [filter, setFilter] = useState<FilterKey>('all');

  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<{ id: string; message: string } | null>(null);

  // One read for the whole surface (no N+1): listBriefs once, then group and
  // filter in memory. Reads are direct RLS selects, no proc, no per-status call.
  const loadBriefs = useCallback(async () => {
    if (workspaceId === null) return;
    setLoading(true);
    setError(null);
    const result = await listBriefs(supabase);
    setLoading(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setBriefs(result.data);
  }, [workspaceId]);

  useEffect(() => {
    void loadBriefs();
  }, [loadBriefs]);

  // The New brief button and the command palette dispatch this event; the sheet
  // lives here so the list can re-fetch on success.
  useEffect(() => {
    function openCreate(): void {
      setCreateOpen(true);
    }
    window.addEventListener('sorted:create-brief', openCreate);
    return () => {
      window.removeEventListener('sorted:create-brief', openCreate);
    };
  }, []);

  // Scope to the active workspace client-side (listBriefs is RLS-scoped to the
  // caller's memberships, which can span workspaces).
  const workspaceBriefs = useMemo(
    () => briefs.filter((brief) => brief.workspace_id === workspaceId),
    [briefs, workspaceId],
  );

  const visibleBriefs = useMemo(() => {
    if (filter === 'all') return workspaceBriefs;
    return workspaceBriefs.filter((brief) => brief.status === filter);
  }, [workspaceBriefs, filter]);

  const openCount = useMemo(
    () => workspaceBriefs.filter((brief) => !isBriefClosed(brief)).length,
    [workspaceBriefs],
  );

  async function handleClose(briefId: string): Promise<void> {
    setClosingId(briefId);
    setCloseError(null);
    const result = await briefClose(supabase, { p_brief_id: briefId, p_trace_id: newTrace() });
    setClosingId(null);
    if (!result.ok) {
      setCloseError({ id: briefId, message: result.error.message });
      return;
    }
    // Reflect server truth: re-fetch so the brief shows Closed, no optimism.
    await loadBriefs();
  }

  const listLoading = workspaceId === null || (loading && briefs.length === 0);

  return (
    <>
      <PageHead
        title="Briefs"
        actions={
          <Button variant="primary" onClick={() => dispatchSorted('sorted:create-brief')}>
            <IconPlus size={16} />
            New brief
          </Button>
        }
      />

      <div className="px-4 md:px-6 pt-3 text-sm text-fg-3">{openCount} open</div>

      <div className="px-4 md:px-6 mt-3 flex flex-wrap gap-2">
        {FILTERS.map((item) => (
          <Chip
            key={item.key}
            label={item.label}
            selected={filter === item.key}
            size="tap"
            onClick={() => setFilter(item.key)}
          />
        ))}
      </div>

      {error !== null ? (
        <div className="px-4 md:px-6 mt-4">
          <div role="alert" className="rounded-xl border border-bad px-4 py-3 text-sm text-bad">
            Could not load briefs. {error}
          </div>
        </div>
      ) : listLoading ? (
        <div className="px-4 md:px-6 py-10 text-sm text-fg-3">Loading briefs</div>
      ) : visibleBriefs.length === 0 ? (
        <EmptyState
          icon={<IconBriefs size={24} />}
          title="No briefs yet"
          description="Briefs from clients will show up here."
        />
      ) : (
        <div className="px-4 md:px-6 py-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visibleBriefs.map((brief) => (
            <BriefCard
              key={brief.id}
              brief={brief}
              closing={closingId === brief.id}
              closeError={closeError?.id === brief.id ? closeError.message : null}
              onConfirmClose={() => void handleClose(brief.id)}
              onOpen={() => navigate(`/briefs/${brief.id}`)}
            />
          ))}
        </div>
      )}

      <CreateBriefSheet
        open={createOpen}
        workspaceId={workspaceId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void loadBriefs();
        }}
      />
    </>
  );
}
